import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { createServer } from "node:net";

import type { ResolvedConfig } from "./config.js";
import { prepareWorkspaceScope, workspaceRoot } from "./workspace-isolation.js";
import { acquireWorkspaceLease } from "./workspace-lock.js";
import { registerWorkspaceBackend } from "./workspace-backends.js";

interface GitNexusInfo {
  version: string;
}

type ServerProbe =
  | { kind: "absent" }
  | { kind: "compatible"; version: string }
  | { kind: "incompatible"; version: string };

const CHECK_TIMEOUT_MS = 800;
const START_POLL_INTERVAL_MS = 150;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseInfo(value: unknown): GitNexusInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" ? { version } : undefined;
}

function isSupportedVersion(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 1 && minor === 6 && patch >= 5;
}

function incompatibleVersionError(version: string): Error {
  return new Error(
    `dsh-gitnexus: GitNexus Web ${version} is unsupported; expected >=1.6.5 <1.7.0`,
  );
}

async function availablePort(preferred: number): Promise<number> {
  const bind = (port: number) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback GitNexus port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  try { return await bind(preferred); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return bind(0);
  }
}

export class GitNexusServeManager {
  private port: number;
  private handle: SubprocessHandle | undefined;
  private starting: Promise<void> | undefined;
  private ownsProcess = false;
  private disposed = false;
  private unregisterBackend: (() => void) | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly root = workspaceRoot(process.cwd()),
  ) {
    this.port = config.servePort;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async ensureStarted(): Promise<void> {
    const lease = await acquireWorkspaceLease(this.root);
    try { await this.startUnderLease(); } finally { lease.release(); }
  }

  private async startUnderLease(): Promise<void> {
    if (this.disposed) {
      throw new Error("dsh-gitnexus: GitNexus Web service is disposed");
    }
    if (this.starting) return this.starting;
    if (this.handle && this.ownsProcess) {
      const probe = await this.probeServer();
      if (probe.kind === "compatible") return;
      if (probe.kind === "incompatible") throw incompatibleVersionError(probe.version);
      throw new Error("Owned GitNexus server is unresponsive; refusing to replace a live backend");
    }

    this.starting = this.startOwnedProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const lease = await acquireWorkspaceLease(this.root, init.signal ?? undefined);
    try {
      await this.startUnderLease();
      const headers = new Headers(init.headers);
      if (init.method?.toUpperCase() === "DELETE") headers.set("origin", this.origin);
      const response = await fetch(`${this.origin}${path}`, { ...init, headers, redirect: "manual" });
      if (!response.body) { lease.release(); return response; }
      const reader = response.body.getReader();
      const release = () => { init.signal?.removeEventListener("abort", onAbort); lease.release(); };
      const onAbort = () => { void reader.cancel(init.signal?.reason).then(release, release); };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      if (init.signal?.aborted) onAbort();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { release(); controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { lease.release(); throw error; }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeOwnedBackend();
  }

  private async closeOwnedBackend(): Promise<void> {
    const handle = this.handle;
    if (handle && this.ownsProcess) {
      handle.terminate();
      await handle.waitForExit(AbortSignal.timeout(5_000));
      if (this.handle === handle) this.handle = undefined;
    }
    this.unregisterBackend?.();
    this.unregisterBackend = undefined;
  }

  private async probeServer(): Promise<ServerProbe> {
    try {
      const response = await fetch(`${this.origin}/api/info`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) return { kind: "absent" };
      const info = parseInfo(await response.json());
      if (!info) return { kind: "incompatible", version: "unknown" };
      return isSupportedVersion(info.version)
        ? { kind: "compatible", version: info.version }
        : { kind: "incompatible", version: info.version };
    } catch {
      return { kind: "absent" };
    }
  }

  private async startOwnedProcess(): Promise<void> {
    // Foreign listeners are never probed, reused, or stopped.
    this.port = await availablePort(this.config.servePort);
    let ownedHandle: SubprocessHandle | undefined;
    const unregister = registerWorkspaceBackend(this.root, async () => {
      if (!ownedHandle) return;
      ownedHandle.terminate();
      await ownedHandle.waitForExit(AbortSignal.timeout(5_000));
      if (this.handle === ownedHandle) this.handle = undefined;
    }, error => this.ctx.logger.warn(String(error)));
    let handle: SubprocessHandle;
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [
          this.config.command,
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(this.port),
        ],
        cwd: this.root,
        env: prepareWorkspaceScope(this.root).env,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 2_000,
      });
      ownedHandle = handle;
    } catch (error) {
      unregister();
      throw error;
    }
    this.handle = handle;
    this.ownsProcess = true;
    this.unregisterBackend = unregister;

    let exited = false;
    void handle.done.then(
      () => {
        exited = true;
        if (this.handle === handle) this.handle = undefined;
        try { unregister(); } catch (error) { this.ctx.logger.warn(String(error)); }
      },
      () => {
        exited = true;
        // Keep the handle and registration until waitForExit confirms shutdown.
      },
    );

    const deadline = Date.now() + this.config.serveStartupTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.probeServer();
      if (exited || this.handle !== handle) break;
      if (probe.kind === "compatible") return;
      if (probe.kind === "incompatible") {
        handle.terminate();
        await handle.waitForExit(AbortSignal.timeout(5_000));
        throw incompatibleVersionError(probe.version);
      }
      if (exited) break;
      await delay(START_POLL_INTERVAL_MS);
    }

    handle.terminate();
    await handle.waitForExit(AbortSignal.timeout(5_000));
    const stderr = handle.collected.stderr?.readFrom(0).text.trim();
    const detail = stderr ? `: ${stderr}` : "";
    throw new Error(
      `dsh-gitnexus: gitnexus serve did not become ready on port ${this.port}${detail}`,
    );
  }
}
