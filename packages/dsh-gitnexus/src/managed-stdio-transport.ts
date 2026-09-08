import type {
  SubprocessHandle,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export interface ManagedStdioOptions {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  graceMs: number;
  stderrMaxBytes: number;
  signal: AbortSignal;
  onStderr?(text: string): void;
}

export class ManagedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly buffer = new ReadBuffer();
  private readonly closeController = new AbortController();
  private handle: SubprocessHandle | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: ManagedStdioOptions,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("dsh-gitnexus: MCP transport was started more than once");
    }
    this.started = true;

    const signal = AbortSignal.any([
      this.options.signal,
      this.closeController.signal,
    ]);
    const handle = this.subprocess.spawn({
      argv: this.options.argv,
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: {
        stdin: "pipe",
        stdout: "pipe",
        stderr: { maxBytes: this.options.stderrMaxBytes },
      },
      graceMs: this.options.graceMs,
      signal,
    });
    this.handle = handle;

    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate();
      throw new Error(
        "dsh-gitnexus: subprocess provider did not expose MCP stdio pipes",
      );
    }

    handle.stdin.on("error", (error: Error) => this.reportError(error));
    handle.stdout.on("error", (error: Error) => this.reportError(error));
    handle.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    void handle.done.then(
      () => this.finish(handle),
      (error: unknown) => {
        this.reportError(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.finish(handle);
      },
    );
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const stdin = this.handle?.stdin;
    if (stdin === undefined || this.closed) {
      throw new Error("dsh-gitnexus: MCP transport is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeController.abort(new Error("dsh-gitnexus: MCP transport closed"));
    const handle = this.handle;
    if (handle === undefined) {
      this.finish();
      return;
    }

    handle.stdin?.end();
    handle.terminate();
    await handle.waitForExit();
    this.finish(handle);
  }

  private receive(chunk: Buffer): void {
    try {
      this.buffer.append(chunk);
      while (true) {
        const message = this.buffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
      void this.close();
    }
  }

  private reportError(error: Error): void {
    if (!this.closed) this.onerror?.(error);
  }

  private finish(handle?: SubprocessHandle): void {
    if (handle !== undefined && this.handle !== handle) return;
    if (handle !== undefined) {
      const diagnostic = handle.collected.stderr?.readFrom(0).text.trim();
      if (diagnostic) this.options.onStderr?.(diagnostic);
    }
    this.handle = undefined;
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
