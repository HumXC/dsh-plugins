import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import type { ResolvedConfig } from "./config.js";
import { ManagedStdioTransport } from "./managed-stdio-transport.js";
import { prepareWorkspaceScope, scopedToolArguments } from "./workspace-isolation.js";
import { validateRenamePaths } from "./rename-preflight.js";

export type ListedMcpTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
export type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

interface ConnectionSlot {
  client: Client;
  transport: ManagedStdioTransport;
  activeCalls: number;
  lastUsed: number;
}

export class McpConnectionRouter {
  private readonly connections = new Map<string, ConnectionSlot>();
  private readonly pending = new Map<string, Promise<ConnectionSlot>>();
  private disposed = false;

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: ResolvedConfig,
    private readonly lifetimeSignal: AbortSignal,
    private readonly onDiagnostic: (message: string) => void,
    private readonly analysis = new AnalysisCoordinator(),
  ) {}

  async discoverTools(cwd: string): Promise<ListedMcpTool[]> {
    this.assertAvailable(cwd);
    const slot = await this.connect(cwd);
    try {
      return await this.listAllTools(slot.client);
    } finally {
      await slot.client.close();
    }
  }

  async callTool(
    cwd: string,
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult> {
    this.assertAvailable(cwd);
    const scope = prepareWorkspaceScope(cwd);
    args = scopedToolArguments(scope, rawName, args);
    return this.withConnection(cwd, async (slot) => {
      if (rawName === "rename") {
        await validateRenamePaths(scope, String(args.repo), statement => slot.client.callTool(
          { name: "cypher", arguments: { repo: args.repo, statement } },
          undefined,
          { signal, timeout: this.config.toolCallTimeoutMs },
        ));
      }
      return slot.client.callTool(
        { name: rawName, arguments: args },
        undefined,
        { signal, timeout: this.config.toolCallTimeoutMs },
      );
    });
  }

  async evict(cwd: string): Promise<void> {
    const pending = this.pending.get(cwd);
    if (pending !== undefined) await pending.catch(() => undefined);
    const slot = this.connections.get(cwd);
    if (slot === undefined) return;
    this.connections.delete(cwd);
    await slot.client.close();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.pending.values()]);
    const slots = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(slots.map((slot) => slot.client.close()));
  }

  private async listAllTools(client: Client): Promise<ListedMcpTool[]> {
    const tools: ListedMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(
        cursor === undefined ? undefined : { cursor },
      );
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  private async withConnection<T>(
    cwd: string,
    operation: (slot: ConnectionSlot) => Promise<T>,
  ): Promise<T> {
    const slot = await this.acquireConnection(cwd);
    try {
      return await operation(slot);
    } catch (error) {
      if (slot.transport.isClosed && this.connections.get(cwd) === slot) {
        this.connections.delete(cwd);
      }
      throw error;
    } finally {
      slot.activeCalls -= 1;
      slot.lastUsed = Date.now();
    }
  }

  private async acquireConnection(cwd: string): Promise<ConnectionSlot> {
    while (true) {
      this.assertAvailable(cwd);
      if (this.disposed || this.lifetimeSignal.aborted) {
        throw new Error("dsh-gitnexus: MCP router is disposed");
      }
      const slot = this.connections.get(cwd);
      if (slot !== undefined && !slot.transport.isClosed) {
        slot.activeCalls += 1;
        slot.lastUsed = Date.now();
        return slot;
      }
      if (slot !== undefined) this.connections.delete(cwd);
      await this.connection(cwd);
    }
  }

  private async connection(cwd: string): Promise<ConnectionSlot> {
    if (this.disposed || this.lifetimeSignal.aborted) {
      throw new Error("dsh-gitnexus: MCP router is disposed");
    }

    const current = this.connections.get(cwd);
    if (current !== undefined && !current.transport.isClosed) return current;
    if (current !== undefined) this.connections.delete(cwd);

    const inFlight = this.pending.get(cwd);
    if (inFlight !== undefined) return inFlight;

    const creation = (async () => {
      await this.ensureCapacity();
      const slot = await this.connect(cwd);
      if (this.analysis.isRebuilding(cwd)) {
        await slot.client.close();
        this.assertAvailable(cwd);
      }
      if (this.disposed || this.lifetimeSignal.aborted) {
        await slot.client.close();
        throw new Error(
          "dsh-gitnexus: MCP router was disposed while connecting",
        );
      }
      this.connections.set(cwd, slot);
      return slot;
    })();
    this.pending.set(cwd, creation);

    try {
      return await creation;
    } finally {
      if (this.pending.get(cwd) === creation) this.pending.delete(cwd);
    }
  }

  private async ensureCapacity(): Promise<void> {
    const otherPending = Math.max(0, this.pending.size - 1);
    while (this.connections.size + otherPending >= this.config.maxConnections) {
      const idle = [...this.connections.entries()]
        .filter(([, slot]) => slot.activeCalls === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (idle === undefined) {
        throw new Error(
          `dsh-gitnexus: all ${this.config.maxConnections} MCP connections are busy`,
        );
      }
      const [cwd, slot] = idle;
      this.connections.delete(cwd);
      await slot.client.close();
    }
  }

  private async connect(cwd: string): Promise<ConnectionSlot> {
    const scope = prepareWorkspaceScope(cwd);
    const transport = new ManagedStdioTransport(this.subprocess, {
      argv: [this.config.command, ...this.config.args],
      cwd: scope.root,
      env: scope.env,
      graceMs: 1_000,
      stderrMaxBytes: 64 * 1024,
      signal: this.lifetimeSignal,
      onStderr: (text) => this.onDiagnostic(`GitNexus MCP (${cwd}): ${text}`),
    });
    const client = new Client({ name: "dsh-gitnexus", version: "0.1.0" });
    try {
      await client.connect(transport);
      return {
        client,
        transport,
        activeCalls: 0,
        lastUsed: Date.now(),
      };
    } catch (error) {
      try {
        await transport.close();
      } catch {
        // Preserve the connection failure; transport cleanup errors are secondary here.
      }
      throw error;
    }
  }

  private assertAvailable(cwd: string): void {
    if (this.analysis.isRebuilding(cwd)) {
      throw new Error(
        `dsh-gitnexus: GitNexus index for ${cwd} is being rebuilt; retry after analysis completes`,
      );
    }
  }
}
