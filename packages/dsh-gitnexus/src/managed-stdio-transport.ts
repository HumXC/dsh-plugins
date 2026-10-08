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
  private protocolClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: ManagedStdioOptions,
  ) {}

  get isClosed(): boolean {
    // MCP onclose only ends the protocol; ownership ends after range confirmation.
    return this.closed;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("dsh-gitnexus: MCP transport was started more than once");
    }
    if (this.protocolClosed || this.closePromise !== undefined) {
      throw new Error("dsh-gitnexus: MCP transport is closed");
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

    void handle.done.then(
      () => this.finish(handle),
      (error: unknown) => {
        this.reportError(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.finish(handle);
      },
    );

    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate();
      throw new Error(
        "dsh-gitnexus: subprocess provider did not expose MCP stdio pipes",
      );
    }

    handle.stdin.on("error", (error: Error) => this.reportError(error));
    handle.stdout.on("error", (error: Error) => this.reportError(error));
    handle.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const stdin = this.handle?.stdin;
    if (stdin === undefined || this.protocolClosed || this.closeController.signal.aborted || this.closePromise !== undefined) {
      throw new Error("dsh-gitnexus: MCP transport is not connected");
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    // Publish the promise before abort or onclose callbacks can reenter close().
    const closing = Promise.resolve().then(() => this.closeOwnedHandle());
    this.closePromise = closing;
    void closing.catch(() => {
      // Keep the owned handle after failure so the router can retry confirmation.
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }

  private async closeOwnedHandle(): Promise<void> {
    if (this.closed) return;
    this.closeController.abort(new Error("dsh-gitnexus: MCP transport closed"));
    const handle = this.handle;
    if (handle === undefined) {
      this.closed = true;
      this.finish();
      return;
    }

    handle.terminate();
    handle.stdin?.end();
    if (await handle.waitForExit() !== true) {
      throw new Error("dsh-gitnexus: MCP managed process exit unconfirmed");
    }
    this.closed = true;
    this.finish(handle);
    this.handle = undefined;
  }

  private receive(chunk: Buffer): void {
    if (this.protocolClosed) return;
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
      void this.close().catch((closeError: unknown) => this.reportError(
        closeError instanceof Error ? closeError : new Error(String(closeError)),
      ));
    }
  }

  private reportError(error: Error): void {
    if (!this.protocolClosed) this.onerror?.(error);
  }

  private finish(handle?: SubprocessHandle): void {
    if (this.protocolClosed || (handle !== undefined && this.handle !== handle)) return;
    if (handle !== undefined) {
      const diagnostic = handle.collected.stderr?.readFrom(0).text.trim();
      if (diagnostic) this.options.onStderr?.(diagnostic);
    }
    // done/onclose cannot relinquish a range that may still own the database.
    this.protocolClosed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
