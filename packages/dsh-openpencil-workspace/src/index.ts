import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type FileSystem from "@deepseek-ai/dsh-fs";
import type SandboxPolicyService from "@deepseek-ai/dsh-sandbox-policy";
import type { SessionStore } from "@deepseek-ai/dsh-session";
import type WebServer from "@deepseek-ai/dsh-host-webserver";
import { isOpPath, OPEN_ENDPOINT, type Grant } from "./contracts.js";
const missing = (error: unknown): boolean => !!error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
export const name = "dsh-openpencil-workspace";
export const inject = ["fs", "sessions", "sandboxPolicy"];
interface OfficialHost { version: 1; grantForDocument(path: string, text: string): Promise<Grant> }
export type HostContext = Pick<Context, "inject" | "effect" | "get"> & { fs: FileSystem; sessions: SessionStore; sandboxPolicy: SandboxPolicyService };
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
export function requireLocalRequest(req: IncomingMessage): void {
  if (!loopback(req.socket.remoteAddress)) throw new Error("只允许本机打开 OpenPencil 编辑器");
  const host = new URL("http://" + req.headers.host);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) throw new Error("Invalid Host");
  const origin = req.headers.origin;
  if (!origin || new URL(origin).host !== host.host || !["http:", "https:"].includes(new URL(origin).protocol)) throw new Error("Invalid Origin");
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") throw new Error("Cross-site request rejected");
}
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown> & { sessionId: string }> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Expected JSON");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length; if (size > 16384) throw new Error("Request too large"); chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || !value.sessionId) throw new Error("Expected sessionId");
  return { ...value, sessionId: value.sessionId };
}
export async function grantForPath(ctx: Pick<HostContext, "fs" | "sessions" | "sandboxPolicy" | "get">, sessionId: string, path: string): Promise<Grant> {
  if (!isOpPath(path)) throw new Error("Expected .op file path");
  // Validation establishes the untrusted string is a session address; lookup remains authoritative.
  const session = ctx.sessions.get(sessionId as Parameters<SessionStore["get"]>[0]);
  if (!session) throw new Error("Session not found");
  const policy = ctx.sandboxPolicy.resolve({ session });
  if (policy.mode === "read-only") throw new Error("当前会话为只读模式，无法打开可保存的编辑器");
  const target = await ctx.fs.resolve(path, { cwd: policy.workspaceRoot });
  const sourcePath = await realpath(ctx.fs.processPath(target));
  if (policy.mode !== "danger-full-access") {
    const root = await realpath(policy.workspaceRoot), tail = relative(root, sourcePath);
    if (tail === ".." || tail.startsWith("../") || isAbsolute(tail)) throw new Error("File is outside the session workspace");
  }
  const bytes = await ctx.fs.readBytes(target, AbortSignal.timeout(15000), 16 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const document: unknown = JSON.parse(text);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid OpenPencil document");
  const host = ctx.get("openpencilWorkspaceHost") as OfficialHost | undefined;
  if (host?.version !== 1) throw new Error("请先为官方 OpenPencil 安装 workspace v1 补丁并重启 DSH");
  return host.grantForDocument(sourcePath, text);
}
export async function handleOpen(ctx: Pick<HostContext, "fs" | "sessions" | "sandboxPolicy" | "get">, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    requireLocalRequest(req);
    if (req.method !== "POST") { reply(res, 405, { error: "Use POST" }); return; }
    const input = await bodyOf(req);
    if (typeof input.path !== "string" || !isOpPath(input.path)) throw new Error("Expected .op file path");
    reply(res, 200, { grant: await grantForPath(ctx, input.sessionId, input.path) });
  } catch (error) { reply(res, missing(error) ? 404 : 400, { error: error instanceof Error ? error.message : String(error), ...(missing(error) ? { code: "FILE_NOT_FOUND" } : {}) }); }
}
export function apply(ctx: HostContext): void {
  void ctx.inject(["webServer"], webCtx => {
    const server = (webCtx as Context & { webServer: WebServer }).webServer;
    webCtx.effect(() => server.register({ kind: "exact", path: OPEN_ENDPOINT, handler: (req, res) => handleOpen(ctx, req, res) }), "OpenPencil workspace file-open route");
  });
}
