import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";

import type { ResolvedConfig } from "./config.js";
import { prepareWorkspaceScope, workspaceRoot } from "./workspace-isolation.js";

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

export class GitNexusServeManager {
  private readonly baseUrl: string;
  private handle: SubprocessHandle | undefined;
  private starting: Promise<void> | undefined;
  private ownsProcess = false;
  private disposed = false;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly root = workspaceRoot(process.cwd()),
  ) {
    this.baseUrl = `http://127.0.0.1:${config.servePort}`;
  }

  get origin(): string {
    return this.baseUrl;
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error("dsh-gitnexus: GitNexus Web service is disposed");
    }
    const probe = await this.probeServer();
    if (probe.kind === "compatible") {
      if (!this.handle || !this.ownsProcess) throw new Error("Refusing to reuse an unscoped external GitNexus server");
      return;
    }
    if (probe.kind === "incompatible") {
      throw incompatibleVersionError(probe.version);
    }
    if (this.starting) return this.starting;

    this.starting = this.startOwnedProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureStarted();
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const handle = this.handle;
    this.handle = undefined;
    if (!handle || !this.ownsProcess) return;
    handle.terminate();
    await handle.waitForExit(AbortSignal.timeout(5_000));
  }

  private async probeServer(): Promise<ServerProbe> {
    try {
      const response = await fetch(`${this.baseUrl}/api/info`, {
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
    const handle = this.ctx.subprocess.spawn({
      argv: [
        this.config.command,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.config.servePort),
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
    this.handle = handle;
    this.ownsProcess = true;

    let exited = false;
    void handle.done.then(
      () => {
        exited = true;
        if (this.handle === handle) this.handle = undefined;
      },
      () => {
        exited = true;
        if (this.handle === handle) this.handle = undefined;
      },
    );

    const deadline = Date.now() + this.config.serveStartupTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.probeServer();
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
      `dsh-gitnexus: gitnexus serve did not become ready on port ${this.config.servePort}${detail}`,
    );
  }
}
