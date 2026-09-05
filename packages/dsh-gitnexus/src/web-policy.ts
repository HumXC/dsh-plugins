import { realpath } from "node:fs/promises";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export interface GitNexusRepo {
  name: string;
  path?: string;
  repoPath?: string;
  indexedAt?: string;
  lastCommit?: string;
  stats?: unknown;
}

const REPO_SCOPED_GET_PATHS = new Set([
  "/api/repo",
  "/api/graph",
  "/api/file",
  "/api/grep",
  "/api/processes",
  "/api/process",
  "/api/clusters",
  "/api/cluster",
]);

const REPO_SCOPED_POST_PATHS = new Set(["/api/query", "/api/search"]);
const PUBLIC_GET_PATHS = new Set([
  "/api/health",
  "/api/heartbeat",
  "/api/info",
]);

export type ApiDecision =
  | { kind: "public" }
  | { kind: "repos" }
  | { kind: "repo-get" }
  | { kind: "repo-post" }
  | { kind: "analysis"; jobId: string; progress: boolean }
  | { kind: "denied" };

export function classifyApiRequest(
  method: string,
  pathname: string,
): ApiDecision {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" && PUBLIC_GET_PATHS.has(pathname)) {
    return { kind: "public" };
  }
  if (normalizedMethod === "GET" && pathname === "/api/repos") {
    return { kind: "repos" };
  }
  if (normalizedMethod === "GET" && REPO_SCOPED_GET_PATHS.has(pathname)) {
    return { kind: "repo-get" };
  }
  if (normalizedMethod === "POST" && REPO_SCOPED_POST_PATHS.has(pathname)) {
    return { kind: "repo-post" };
  }

  const analysis = pathname.match(
    /^\/api\/analyze\/([A-Za-z0-9_-]+)(\/progress)?$/,
  );
  const jobId = analysis?.[1];
  if (jobId && (normalizedMethod === "GET" || normalizedMethod === "DELETE")) {
    return {
      kind: "analysis",
      jobId,
      progress: analysis?.[2] === "/progress",
    };
  }
  return { kind: "denied" };
}

export async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function selectWorkspaceRepo(
  repos: readonly GitNexusRepo[],
  workspaceRoot: string,
): Promise<GitNexusRepo | undefined> {
  const canonicalRoot = await canonicalPath(workspaceRoot);
  for (const repo of repos) {
    const candidate = repo.repoPath ?? repo.path;
    if (!candidate) continue;
    if ((await canonicalPath(candidate)) === canonicalRoot) return repo;
  }
  return undefined;
}

export function forceRepoQuery(url: URL, repoName: string): URL {
  url.searchParams.set("repo", repoName);
  return url;
}

export function forceRepoBody(body: unknown, repoName: string): JsonObject {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { repo: repoName };
  }
  return { ...(body as JsonObject), repo: repoName };
}

function normalizedGatewayPrefix(gatewayPrefix: string): string {
  const normalized = gatewayPrefix.replace(/\/$/, "");
  if (!/^\/gitnexus\/session\/[A-Za-z0-9_-]{24,}$/.test(normalized)) {
    throw new Error("Invalid GitNexus session gateway prefix");
  }
  return normalized;
}

export function rewriteGitNexusIndex(
  html: string,
  gatewayPrefix: string,
): string {
  const normalizedPrefix = normalizedGatewayPrefix(gatewayPrefix);
  if (
    !html.includes("<head>") ||
    !html.includes("<title>GitNexus</title>") ||
    !html.includes('<div id="root"></div>') ||
    !/<script\s+type="module"[^>]+src="\/assets\//.test(html)
  ) {
    throw new Error(
      "Installed GitNexus Web assets are incompatible with dsh-gitnexus",
    );
  }

  const rewritten = html
    .replace(
      "<head>",
      "<head><style>html,body{background-color:#06060a}</style>",
    )
    .replaceAll('href="/assets/', `href="${normalizedPrefix}/assets/`)
    .replaceAll('src="/assets/', `src="${normalizedPrefix}/assets/`);
  return rewritten.replace(
    /(<script\s+type="module")/,
    `<script src="${normalizedPrefix}/dsh/bootstrap.js"></script>\n$1`,
  );
}

export function workspaceStorageBootstrap(gatewayPrefix: string): string {
  const namespace = `dsh-gitnexus:${normalizedGatewayPrefix(gatewayPrefix)}:`;
  return `(()=>{const n=${JSON.stringify(namespace)},s=window.localStorage,p=Storage.prototype,g=p.getItem.bind(s),w=p.setItem.bind(s),r=p.removeItem.bind(s),k=p.key.bind(s),c=p.clear.bind(s),d=Object.getOwnPropertyDescriptor(p,"length"),a=()=>{const e=[];for(let i=0;i<d.get.call(s);i++){const v=k(i);if(v?.startsWith(n))e.push(v)}return e};p.getItem=function(e){return this===s?g(n+String(e)):g.call(this,e)};p.setItem=function(e,v){return this===s?w(n+String(e),v):w.call(this,e,v)};p.removeItem=function(e){return this===s?r(n+String(e)):r.call(this,e)};p.key=function(e){if(this!==s)return k.call(this,e);const v=a()[e]??null;return v===null?null:v.slice(n.length)};p.clear=function(){if(this!==s)return c.call(this);for(const e of a())r(e)};if(d?.get&&d.configurable)Object.defineProperty(p,"length",{configurable:true,get(){return this===s?a().length:d.get.call(this)}})})();`;
}
