import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import type { ResolvedConfig } from "./config.js";
import { ManagedStdioTransport } from "./managed-stdio-transport.js";
import { prepareWorkspaceScope, scopedToolArguments, workspaceRoot } from "./workspace-isolation.js";
import { validateRenamePaths } from "./rename-preflight.js";
import { acquireWorkspaceLease } from "./workspace-lock.js";

export type ListedMcpTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
export type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpDiagnostics {
  state: "unknown" | "ready" | "unavailable";
  supportedTools: string[];
  lastError?: string;
}

interface RequestBudget {
  signal: AbortSignal;
  remaining(): number;
}
class UnconfirmedBackendExit extends Error {}

interface ConnectionSlot {
  client: Client;
  transport: ManagedStdioTransport;
  activeCalls: number;
  lastUsed: number;
  closing?: Promise<void>;
  leases?: Array<Awaited<ReturnType<typeof acquireWorkspaceLease>>>;
}

export class McpConnectionRouter {
  private readonly connections = new Map<string, ConnectionSlot>();
  private readonly pending = new Map<string, Promise<ConnectionSlot>>();
  private readonly diagnostics = new Map<string, McpDiagnostics>();
  private readonly shutdownController = new AbortController();
  private disposed = false;

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: ResolvedConfig,
    private readonly lifetimeSignal: AbortSignal,
    private readonly onDiagnostic: (message: string) => void,
    private readonly analysis = new AnalysisCoordinator(),
  ) {}

  getDiagnostics(cwd: string): McpDiagnostics {
    const cached = this.diagnostics.get(workspaceRoot(cwd));
    return cached === undefined
      ? { state: "unknown", supportedTools: [] }
      : { ...cached, supportedTools: [...cached.supportedTools] };
  }

  async discoverTools(cwd: string): Promise<ListedMcpTool[]> {
    return this.withConnection(cwd, this.lifetimeSignal, () => undefined, async (_slot, tools) => tools);
  }

  async callTool(
    cwd: string,
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult> {
    cwd = workspaceRoot(cwd);
    let scope: ReturnType<typeof prepareWorkspaceScope>;
    return this.withConnection(cwd, signal, () => {
      scope = prepareWorkspaceScope(cwd);
      args = scopedToolArguments(scope, rawName, args);
      return typeof args.repo === "string" && args.repo !== scope.root ? args.repo : undefined;
    }, async (slot, tools, budget) => {
      const tool = tools.find(tool => tool.name === rawName);
      if (tool === undefined) throw new Error("GitNexus backend does not support tool: " + rawName);
      if (tool.execution?.taskSupport === "required") {
        throw new Error("GitNexus tool requires unsupported MCP task execution: " + rawName);
      }
      const call = (name: string, arguments_: Record<string, unknown>) => this.abortable(
        budget.signal,
        () => slot.client.callTool(
          { name, arguments: arguments_ },
          undefined,
          { signal: budget.signal, timeout: budget.remaining() },
        ),
      );
      if (rawName === "rename") {
        const cypher = tools.find(tool => tool.name === "cypher");
        if (cypher === undefined) throw new Error("GitNexus rename preflight requires backend tool: cypher");
        if (cypher.execution?.taskSupport === "required") {
          throw new Error("GitNexus tool requires unsupported MCP task execution: cypher");
        }
        await validateRenamePaths(scope, String(args.repo), statement => call("cypher", { repo: args.repo, statement }));
      }
      const result = await call(rawName, args);
      if (!("toolResult" in result) && result.isError === true) {
        const lastError = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n").slice(0, 2_000)
          || "GitNexus backend reported a tool error: " + rawName;
        this.diagnostics.set(cwd, {
          state: "ready",
          supportedTools: this.diagnostics.get(cwd)?.supportedTools ?? [],
          lastError,
        });
      }
      return result;
    });
  }

  private async withConnection<T>(
    cwd: string,
    signal: AbortSignal,
    prepare: () => string | undefined,
    operation: (slot: ConnectionSlot, tools: ListedMcpTool[], budget: RequestBudget) => Promise<T>,
  ): Promise<T> {
    cwd = workspaceRoot(cwd);
    this.assertAvailable(cwd);
    const controller = new AbortController();
    const deadline = Date.now() + this.config.toolCallTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(
      `GitNexus MCP operation timed out after ${this.config.toolCallTimeoutMs}ms`,
    )), this.config.toolCallTimeoutMs);
    const budget: RequestBudget = {
      signal: AbortSignal.any([signal, this.lifetimeSignal, controller.signal, this.shutdownController.signal]),
      remaining: () => Math.max(1, deadline - Date.now()),
    };
    let lease: Awaited<ReturnType<typeof acquireWorkspaceLease>> | undefined;
    let repositoryLease: Awaited<ReturnType<typeof acquireWorkspaceLease>> | undefined;
    let slot: ConnectionSlot | undefined;
    let release = true;
    let discovered = false;
    try {
      lease = await acquireWorkspaceLease(cwd, budget.signal);
      this.assertAvailable(cwd);
      budget.signal.throwIfAborted();
      const repository = prepare();
      if (repository !== undefined) repositoryLease = await acquireWorkspaceLease(repository, budget.signal);
      const leases = repositoryLease === undefined ? [lease] : [lease, repositoryLease];
      slot = await this.connect(cwd, budget, leases);
      slot.leases ??= leases;
      budget.signal.throwIfAborted();
      this.assertAvailable(cwd);
      const tools = await this.listAllTools(slot.client, budget);
      budget.signal.throwIfAborted();
      this.assertAvailable(cwd);
      discovered = true;
      this.diagnostics.set(cwd, { state: "ready", supportedTools: [...new Set(tools.map(tool => tool.name))] });
      return await operation(slot, tools, budget);
    } catch (error) {
      if (error instanceof UnconfirmedBackendExit) release = false;
      if (!discovered) this.recordUnavailable(cwd, error);
      else this.diagnostics.set(cwd, {
        state: "ready",
        supportedTools: this.diagnostics.get(cwd)?.supportedTools ?? [],
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
      if (release) {
        // A failed close must retain both physical index leases.
        try {
          if (slot !== undefined) await this.closeSlot(slot);
        } catch (error) {
          this.recordUnavailable(cwd, error);
          throw error;
        }
        if (slot !== undefined && this.connections.get(cwd) === slot) this.connections.delete(cwd);
        repositoryLease?.release();
        lease?.release();
      }
    }
  }

  private recordUnavailable(cwd: string, error: unknown): void {
    this.diagnostics.set(cwd, {
      state: "unavailable",
      supportedTools: this.diagnostics.get(cwd)?.supportedTools ?? [],
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  async evict(cwd: string): Promise<void> {
    cwd = workspaceRoot(cwd);
    const slot = this.connections.get(cwd);
    if (slot === undefined) return;
    try {
      await this.closeSlot(slot);
      slot.leases?.forEach(lease => lease.release());
      if (this.connections.get(cwd) === slot) this.connections.delete(cwd);
    } catch (error) {
      this.recordUnavailable(cwd, error);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.shutdownController.abort(new Error("GitNexus MCP router is disposed"));
    await Promise.allSettled([...this.connections].map(async ([cwd, slot]) => {
      try {
        await this.closeSlot(slot);
        slot.leases?.forEach(lease => lease.release());
        if (this.connections.get(cwd) === slot) this.connections.delete(cwd);
      } catch (error) {
        this.recordUnavailable(cwd, error);
        throw error;
      }
    }));
  }

  private async closeSlot(slot: ConnectionSlot): Promise<void> {
    if (slot.closing === undefined) {
      // SDK close can detach before rejecting; only owned transport.close
      // confirms the managed range is gone. Observe SDK cleanup separately.
      void Promise.resolve().then(() => slot.client.close()).catch(() => undefined);
      const closing = Promise.resolve().then(() => slot.transport.close());
      slot.closing = closing;
      void closing.catch(() => {
        // Permit explicit retry, without background record/lease mutations.
        if (slot.closing === closing) delete slot.closing;
      });
    }
    const cleanupMs = Math.min(this.config.toolCallTimeoutMs, 1_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new UnconfirmedBackendExit(
        `MCP process exit unconfirmed; workspace lease retained (cleanup timed out after ${cleanupMs}ms)`,
      )), cleanupMs);
    });
    try { await Promise.race([slot.closing, timedOut]); }
    finally { clearTimeout(timer); }
  }

  private async listAllTools(client: Client, budget: RequestBudget): Promise<ListedMcpTool[]> {
    const tools: ListedMcpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.abortable(budget.signal, () => client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: budget.signal, timeout: budget.remaining() },
      ));
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error("GitNexus MCP tool discovery repeated a pagination cursor");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  }

  private async connect(
    cwd: string,
    budget: RequestBudget,
    leases: Array<Awaited<ReturnType<typeof acquireWorkspaceLease>>>,
  ): Promise<ConnectionSlot> {
    this.assertAvailable(cwd);
    if (this.connections.size >= this.config.maxConnections) {
      throw new Error("All GitNexus MCP connections are busy");
    }
    const scope = prepareWorkspaceScope(cwd);
    const transport = new ManagedStdioTransport(this.subprocess, {
      argv: [this.config.command, ...this.config.args],
      cwd: scope.root,
      env: scope.env,
      graceMs: 1_000,
      stderrMaxBytes: 64 * 1024,
      signal: budget.signal,
      onStderr: (text) => this.onDiagnostic(`GitNexus MCP (${cwd}): ${text}`),
    });
    const client = new Client({ name: "dsh-gitnexus", version: "0.1.0" });
    const protocolClose = client.close.bind(client);
    // Client.connect invokes void this.close() on handshake failure. Keep that
    // SDK path rejection-safe; owned transport.close below still reports errors.
    client.close = () => protocolClose().catch(() => undefined);
    const slot: ConnectionSlot = { client, transport, activeCalls: 1, lastUsed: Date.now(), leases };
    // Reserve before the handshake so disposal sees connecting transports.
    this.connections.set(cwd, slot);
    const pending = (async () => {
      try {
        await this.abortable(budget.signal, () => client.connect(transport, {
          signal: budget.signal, timeout: budget.remaining(),
        }));
        budget.signal.throwIfAborted();
        this.assertAvailable(cwd);
        return slot;
      } catch (error) {
        try {
          await this.closeSlot(slot);
          if (this.connections.get(cwd) === slot) this.connections.delete(cwd);
        } catch (cleanupError) {
          throw new UnconfirmedBackendExit("MCP process exit unconfirmed; workspace lease retained", { cause: cleanupError });
        }
        throw error;
      }
    })();
    this.pending.set(cwd, pending);
    try { return await pending; }
    finally { this.pending.delete(cwd); }
  }

  private async abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([operation(), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private assertAvailable(cwd: string): void {
    if (this.disposed || this.lifetimeSignal.aborted) throw new Error("GitNexus MCP router is disposed");
    if (this.analysis.isRebuilding(cwd)) {
      throw new Error(
        `dsh-gitnexus: GitNexus index for ${cwd} is being rebuilt; retry after analysis completes`,
      );
    }
  }
}
