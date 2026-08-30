import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

import type {
  AnalysisCoordinator,
  WorkspaceAnalysisState,
} from "./analysis-coordinator.js";
import type { ResolvedConfig } from "./config.js";
import type { McpConnectionRouter } from "./mcp-router.js";
import { GitNexusServeManager } from "./serve-manager.js";
import { resolveWorkspaceRoute, type WorkspaceRoute } from "./repository.js";
import {
  classifyApiRequest,
  forceRepoBody,
  forceRepoQuery,
  rewriteGitNexusIndex,
  selectWorkspaceRepo,
  workspaceStorageBootstrap,
  type GitNexusRepo,
  type JsonObject,
} from "./web-policy.js";

const GATEWAY_ROOT = "/gitnexus/session";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const VIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_VIEW_TOKENS = 256;
const MAX_ANALYSIS_MESSAGE_CHARS = 240;
const MAX_ANALYSIS_ERROR_CHARS = 8_000;
const ACTIVE_ANALYSIS_STATUSES = new Set(["starting", "running"]);
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

interface GatewayRequest {
  token: string;
  prefix: string;
  suffix: string;
  url: URL;
  signal: AbortSignal;
}

interface ViewToken {
  sessionId: string;
  expiresAt: number;
}

interface WorkspaceContext {
  route: WorkspaceRoute;
  repo: GitNexusRepo | undefined;
  repos: readonly GitNexusRepo[];
}

interface ActiveAnalysisProcess {
  jobId: string;
  handle: SubprocessHandle;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

function analysisJobPayload(state: WorkspaceAnalysisState): JsonObject {
  const status =
    state.status === "completed"
      ? "complete"
      : state.status === "cancelled"
        ? "cancelled"
        : state.status === "failed"
          ? "failed"
          : "analyzing";
  return {
    id: state.jobId,
    status,
    progress: {
      phase: state.phase,
      percent: state.progress,
      message: state.message,
    },
    ...(state.error ? { error: state.error } : {}),
  };
}

function latestOutputLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return line.slice(0, MAX_ANALYSIS_MESSAGE_CHARS);
  }
  return undefined;
}

function inferAnalysisProgress(
  message: string,
  currentProgress: number,
): { phase?: string; progress?: number; message: string } {
  const explicit = message.match(/\b(\d{1,3})%\b/)?.[1];
  if (explicit) {
    return {
      progress: Math.max(currentProgress, Math.min(95, Number(explicit))),
      message,
    };
  }
  const phases: ReadonlyArray<readonly [RegExp, string, number]> = [
    [/complete|success|up.to.date/i, "finalizing", 95],
    [/write|index|store|register/i, "indexing", 85],
    [/graph|relationship|edge|cluster/i, "graph", 65],
    [/parse|extract|symbol/i, "parsing", 40],
    [/discover|scan|collect|file/i, "scanning", 15],
  ];
  for (const [pattern, phase, progress] of phases) {
    if (pattern.test(message)) {
      return { phase, progress: Math.max(currentProgress, progress), message };
    }
  }
  return { message };
}

function parseGatewayRequest(
  req: IncomingMessage,
  signal: AbortSignal,
): GatewayRequest | undefined {
  if (!req.url) return undefined;
  let url: URL;
  try {
    url = new URL(req.url, "http://dsh.local");
  } catch {
    return undefined;
  }
  const prefix = `${GATEWAY_ROOT}/`;
  if (!url.pathname.startsWith(prefix)) return undefined;
  const remainder = url.pathname.slice(prefix.length);
  const slashIndex = remainder.indexOf("/");
  const token = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) return undefined;

  const sessionPrefix = `${GATEWAY_ROOT}/${token}`;
  const suffix = slashIndex === -1 ? "/" : remainder.slice(slashIndex);
  return { token, prefix: sessionPrefix, suffix, url, signal };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRepos(value: unknown): readonly GitNexusRepo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isJsonObject(candidate) || typeof candidate.name !== "string")
      return [];
    const repo: GitNexusRepo = { name: candidate.name };
    if (typeof candidate.path === "string") repo.path = candidate.path;
    if (typeof candidate.repoPath === "string")
      repo.repoPath = candidate.repoPath;
    if (typeof candidate.indexedAt === "string")
      repo.indexedAt = candidate.indexedAt;
    if (typeof candidate.lastCommit === "string")
      repo.lastCommit = candidate.lastCommit;
    if (candidate.stats !== undefined) repo.stats = candidate.stats;
    return [repo];
  });
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("request body must contain valid JSON", { cause: error });
  }
  if (!isJsonObject(parsed))
    throw new Error("request body must be a JSON object");
  return parsed;
}

async function pipeResponse(
  upstream: Response,
  res: ServerResponse,
  rewriteHtml: ((html: string) => string) | undefined,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (rewriteHtml && contentType.includes("text/html")) {
    const html = rewriteHtml(await upstream.text());
    res.writeHead(upstream.status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "x-frame-options": "SAMEORIGIN",
    });
    res.end(html);
    return;
  }

  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (
      key === "content-length" ||
      key === "content-encoding" ||
      key === "transfer-encoding"
    ) {
      return;
    }
    headers[key] = value;
  });
  headers["x-frame-options"] = "SAMEORIGIN";
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

export class GitNexusWebHost {
  private readonly serve: GitNexusServeManager;
  private readonly viewTokens = new Map<string, ViewToken>();
  private readonly activeRequests = new Set<AbortController>();
  private readonly analysisProcesses = new Map<string, ActiveAnalysisProcess>();
  private disposed = false;

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly analysis: AnalysisCoordinator,
    private readonly router: McpConnectionRouter,
  ) {
    this.serve = new GitNexusServeManager(ctx, this.config);
  }

  async handleCapability(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (this.disposed) {
      sendError(res, 503, "GitNexus Web host is shutting down");
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, { enabled: true });
      return;
    }
    if (req.method !== "POST") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    let body: JsonObject;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendError(
        res,
        400,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      sendError(res, 400, "sessionId is required");
      return;
    }
    const session = this.ctx.sessions.get(body.sessionId as SessionId);
    if (!session) {
      sendError(res, 404, "DSH session not found");
      return;
    }
    if (typeof session.header.cwd !== "string" || !session.header.cwd) {
      sendError(res, 409, "The DSH session has no workspace");
      return;
    }

    const token = this.issueViewToken(body.sessionId);
    sendJson(res, 200, { gateway: `${GATEWAY_ROOT}/${token}` });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.disposed) {
      sendError(res, 503, "GitNexus Web host is shutting down");
      return;
    }
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    const abortClosedResponse = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", abortRequest);
    res.once("close", abortClosedResponse);
    this.activeRequests.add(controller);

    try {
      const gateway = parseGatewayRequest(req, controller.signal);
      if (!gateway) {
        sendError(res, 400, "Invalid GitNexus session gateway URL");
        return;
      }

      const viewToken = this.resolveViewToken(gateway.token);
      if (!viewToken) {
        sendError(res, 404, "GitNexus view token is invalid or expired");
        return;
      }
      const session = this.ctx.sessions.get(viewToken.sessionId as SessionId);
      if (!session) {
        this.viewTokens.delete(gateway.token);
        sendError(res, 404, "DSH session not found");
        return;
      }
      if (typeof session.header.cwd !== "string" || !session.header.cwd) {
        sendError(res, 409, "The DSH session has no workspace");
        return;
      }

      const workspace = await this.resolveWorkspace(
        session.header.cwd,
        controller.signal,
      );
      if (gateway.suffix.startsWith("/dsh/")) {
        await this.handleDshRequest(req, res, gateway, workspace);
        return;
      }
      if (gateway.suffix.startsWith("/api/")) {
        await this.handleApiRequest(req, res, gateway, workspace);
        return;
      }
      await this.handleStaticRequest(res, gateway, workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(message));
      } else if (!controller.signal.aborted) {
        sendError(res, 502, message);
      }
    } finally {
      req.off("aborted", abortRequest);
      res.off("close", abortClosedResponse);
      this.activeRequests.delete(controller);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.viewTokens.clear();
    const processes = [...this.analysisProcesses.values()];
    for (const process of processes) process.handle.terminate();
    await Promise.all(
      processes.map(async ({ handle }) => handle.waitForExit()),
    );
    this.analysisProcesses.clear();
    await this.serve.dispose();
  }

  private issueViewToken(sessionId: string): string {
    const now = Date.now();
    for (const [token, view] of this.viewTokens) {
      if (view.expiresAt <= now) this.viewTokens.delete(token);
    }
    while (this.viewTokens.size >= MAX_VIEW_TOKENS) {
      const oldest = this.viewTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.viewTokens.delete(oldest);
    }

    const token = randomBytes(24).toString("base64url");
    this.viewTokens.set(token, {
      sessionId,
      expiresAt: now + VIEW_TOKEN_TTL_MS,
    });
    return token;
  }

  private resolveViewToken(token: string): ViewToken | undefined {
    const view = this.viewTokens.get(token);
    if (!view) return undefined;
    if (view.expiresAt <= Date.now()) {
      this.viewTokens.delete(token);
      return undefined;
    }
    return view;
  }

  private async resolveWorkspace(
    cwd: string,
    signal: AbortSignal,
  ): Promise<WorkspaceContext> {
    await this.serve.ensureStarted();
    const route = resolveWorkspaceRoute(cwd);
    const response = await this.serve.request("/api/repos", { signal });
    if (!response.ok)
      throw new Error("GitNexus could not list indexed repositories");
    const repos = parseRepos(await response.json());
    const repo = await selectWorkspaceRepo(repos, route.root);
    return { route, repo, repos };
  }

  private async handleDshRequest(
    req: IncomingMessage,
    res: ServerResponse,
    gateway: GatewayRequest,
    workspace: WorkspaceContext,
  ): Promise<void> {
    if (req.method === "GET" && gateway.suffix === "/dsh/bootstrap.js") {
      const body = workspaceStorageBootstrap(gateway.prefix);
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && gateway.suffix === "/dsh/status") {
      await this.sendWorkspaceStatus(res, gateway, workspace);
      return;
    }
    if (req.method === "POST" && gateway.suffix === "/dsh/analyze") {
      await this.startAnalysis(req, res, workspace);
      return;
    }

    const cancel = gateway.suffix.match(/^\/dsh\/analysis\/([A-Za-z0-9_-]+)$/);
    if (req.method === "DELETE" && cancel?.[1]) {
      await this.cancelAnalysis(res, workspace.route.root, cancel[1]);
      return;
    }
    sendError(res, 404, "Unknown GitNexus workspace operation");
  }

  private async sendWorkspaceStatus(
    res: ServerResponse,
    gateway: GatewayRequest,
    workspace: WorkspaceContext,
  ): Promise<void> {
    const analysisState = this.analysis.state(workspace.route.root);
    const common = {
      workspace: {
        name: basename(workspace.route.root),
        path: workspace.route.root,
      },
      gateway: gateway.prefix,
      repo: workspace.repo,
      analysis: analysisState,
    };

    if (analysisState && ACTIVE_ANALYSIS_STATUSES.has(analysisState.status)) {
      sendJson(res, 200, { ...common, state: "analyzing" });
      return;
    }
    if (analysisState?.status === "cancelled") {
      sendJson(res, 200, { ...common, state: "cancelled" });
      return;
    }
    if (analysisState?.status === "failed") {
      sendJson(res, 200, { ...common, state: "failed" });
      return;
    }
    if (!workspace.repo) {
      sendJson(res, 200, { ...common, state: "unindexed" });
      return;
    }

    const currentCommit = await this.readCurrentCommit(workspace.route.root);
    const stale = Boolean(
      currentCommit &&
        workspace.repo.lastCommit &&
        currentCommit !== workspace.repo.lastCommit,
    );
    sendJson(res, 200, { ...common, state: stale ? "stale" : "ready" });
  }

  private async startAnalysis(
    req: IncomingMessage,
    res: ServerResponse,
    workspace: WorkspaceContext,
  ): Promise<void> {
    let body: JsonObject;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendError(
        res,
        400,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (Object.keys(body).some((key) => key !== "force")) {
      sendError(res, 400, "Only the force option is accepted");
      return;
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      sendError(res, 400, "force must be a boolean");
      return;
    }

    const root = workspace.route.root;
    const begin = this.analysis.begin(root);
    if (!begin.started) {
      sendJson(res, 409, {
        error: "Analysis is already running",
        analysis: begin.state,
      });
      return;
    }

    try {
      await this.router.evict(root);
      const force = body.force ?? Boolean(workspace.repo);
      const argv = [
        this.config.command,
        "analyze",
        ...(force ? ["--force"] : []),
        "--index-only",
        ...(!existsSync(resolve(root, ".git")) ? ["--skip-git"] : []),
        root,
      ];
      const handle = this.ctx.subprocess.spawn({
        argv,
        cwd: root,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        graceMs: 2_000,
      });
      const jobId = `dsh-${randomBytes(18).toString("base64url")}`;
      this.analysisProcesses.set(root, { jobId, handle });
      this.analysis.bindJob(root, jobId);
      this.analysis.update(root, {
        phase: "starting",
        progress: 5,
        message: "Starting index-only GitNexus analysis",
      });
      void this.monitorAnalysis(root, jobId, handle);
      sendJson(res, 202, { jobId, status: "analyzing" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.analysis.finish(root, "failed", detail);
      await this.router.evict(root);
      sendError(res, 502, detail);
    }
  }

  private async cancelAnalysis(
    res: ServerResponse,
    root: string,
    jobId: string,
  ): Promise<void> {
    const state = this.analysis.state(root);
    const active = this.analysisProcesses.get(root);
    if (!state?.jobId || state.jobId !== jobId || active?.jobId !== jobId) {
      sendError(res, 404, "Analysis job is not owned by the current workspace");
      return;
    }
    active.handle.terminate();
    this.analysis.finish(root, "cancelled", "Cancelled by user");
    await this.router.evict(root);
    sendJson(res, 202, { id: jobId, status: "cancelled" });
  }

  private async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    gateway: GatewayRequest,
    workspace: WorkspaceContext,
  ): Promise<void> {
    const decision = classifyApiRequest(req.method ?? "GET", gateway.suffix);
    if (decision.kind === "denied") {
      sendError(
        res,
        403,
        "This GitNexus API is unavailable in the DSH workspace view",
      );
      return;
    }
    if (decision.kind === "repos") {
      sendJson(res, 200, workspace.repo ? [workspace.repo] : []);
      return;
    }
    if (decision.kind === "analysis") {
      const state = this.analysis.state(workspace.route.root);
      if (state?.jobId !== decision.jobId) {
        sendError(
          res,
          404,
          "Analysis job is not owned by the current workspace",
        );
        return;
      }
      if (req.method === "DELETE") {
        await this.cancelAnalysis(res, workspace.route.root, decision.jobId);
        return;
      }
      const payload = analysisJobPayload(state);
      if (decision.progress) {
        const event = `data: ${JSON.stringify(payload)}\n\n`;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "content-length": Buffer.byteLength(event),
          "cache-control": "no-store",
        });
        res.end(event);
      } else {
        sendJson(res, 200, payload);
      }
      return;
    }
    if (
      (decision.kind === "repo-get" || decision.kind === "repo-post") &&
      !workspace.repo
    ) {
      sendError(res, 404, "Current workspace has not been analyzed");
      return;
    }

    const upstreamUrl = gateway.url;
    upstreamUrl.pathname = gateway.suffix;
    let body: string | undefined;
    if (decision.kind === "repo-get" && workspace.repo) {
      forceRepoQuery(upstreamUrl, workspace.repo.name);
    } else if (decision.kind === "repo-post" && workspace.repo) {
      let parsed: JsonObject;
      try {
        parsed = await readJsonBody(req);
      } catch (error) {
        sendError(
          res,
          400,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      body = JSON.stringify(forceRepoBody(parsed, workspace.repo.name));
    }

    const upstream = await this.serve.request(
      `${upstreamUrl.pathname}${upstreamUrl.search}`,
      {
        method: req.method ?? "GET",
        signal: gateway.signal,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(req.method === "DELETE" ? { origin: this.serve.origin } : {}),
        },
        ...(body ? { body } : {}),
      },
    );
    await pipeResponse(upstream, res, undefined);
  }

  private async handleStaticRequest(
    res: ServerResponse,
    gateway: GatewayRequest,
    workspace: WorkspaceContext,
  ): Promise<void> {
    if (!workspace.repo) {
      sendError(
        res,
        409,
        "Analyze the current workspace before opening the graph",
      );
      return;
    }
    const upstream = await this.serve.request(
      `${gateway.suffix}${gateway.url.search}`,
      { signal: gateway.signal },
    );
    await pipeResponse(upstream, res, (html) =>
      rewriteGitNexusIndex(html, gateway.prefix),
    );
  }

  private async monitorAnalysis(
    root: string,
    jobId: string,
    handle: SubprocessHandle,
  ): Promise<void> {
    let stderrTail = "";
    const updateFromOutput = (
      chunk: Buffer | string,
      isError: boolean,
    ): void => {
      const text = chunk.toString();
      if (isError) {
        stderrTail = `${stderrTail}${text}`.slice(-MAX_ANALYSIS_ERROR_CHARS);
      }
      const message = latestOutputLine(text);
      const state = this.analysis.state(root);
      if (
        !message ||
        !state ||
        state.jobId !== jobId ||
        !ACTIVE_ANALYSIS_STATUSES.has(state.status)
      ) {
        return;
      }
      this.analysis.update(
        root,
        inferAnalysisProgress(message, state.progress ?? 5),
      );
    };
    const onStdout = (chunk: Buffer | string): void =>
      updateFromOutput(chunk, false);
    const onStderr = (chunk: Buffer | string): void =>
      updateFromOutput(chunk, true);
    handle.stdout?.on("data", onStdout);
    handle.stderr?.on("data", onStderr);

    try {
      const outcome = await handle.done;
      const state = this.analysis.state(root);
      if (
        state?.jobId === jobId &&
        ACTIVE_ANALYSIS_STATUSES.has(state.status)
      ) {
        if (outcome.exitCode === 0) {
          this.analysis.update(root, {
            phase: "complete",
            progress: 100,
            message: "GitNexus index is ready",
          });
          this.analysis.finish(root, "completed");
        } else {
          const detail =
            latestOutputLine(stderrTail) ??
            `GitNexus analysis exited with code ${String(outcome.exitCode)}`;
          this.analysis.finish(root, "failed", detail);
        }
      }
    } catch (error) {
      const state = this.analysis.state(root);
      if (
        state?.jobId === jobId &&
        ACTIVE_ANALYSIS_STATUSES.has(state.status)
      ) {
        this.analysis.finish(
          root,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      handle.stdout?.off("data", onStdout);
      handle.stderr?.off("data", onStderr);
      const active = this.analysisProcesses.get(root);
      if (active?.jobId === jobId) this.analysisProcesses.delete(root);
      await this.router.evict(root);
    }
  }

  private async readCurrentCommit(root: string): Promise<string | undefined> {
    const handle = this.ctx.subprocess.spawn({
      argv: ["git", "-C", root, "rev-parse", "HEAD"],
      cwd: root,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 4_096 },
        stderr: { maxBytes: 4_096 },
      },
      graceMs: 1_000,
    });
    const outcome = await handle.done;
    if (outcome.exitCode !== 0) return undefined;
    return handle.collected.stdout?.readFrom(0).text.trim() || undefined;
  }
}
