import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceRoot, workspacePath } from "./workspace-isolation.js";

export interface WorkspaceRoute {
  cwd: string;
  root: string;
  hasIndex: boolean;
}

export function canonicalWorkspacePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveWorkspaceRoute(cwd: string): WorkspaceRoute {
  const canonicalCwd = workspaceRoot(cwd);
  workspacePath(canonicalCwd, ".gitnexus");
  workspacePath(canonicalCwd, ".gitnexus/gitnexus.json");
  workspacePath(canonicalCwd, ".gitnexus/meta.json");
  return {
    cwd: canonicalCwd,
    root: canonicalCwd,
    hasIndex: existsSync(resolve(canonicalCwd, ".gitnexus", "gitnexus.json")) || existsSync(resolve(canonicalCwd, ".gitnexus", "meta.json")),
  };
}

export function sessionCwd(agent: unknown): string | undefined {
  if (typeof agent !== "object" || agent === null || !("session" in agent))
    return undefined;
  const session = agent.session;
  if (typeof session !== "object" || session === null || !("header" in session))
    return undefined;
  const header = session.header;
  if (typeof header !== "object" || header === null || !("cwd" in header))
    return undefined;
  return typeof header.cwd === "string" && header.cwd.length > 0
    ? header.cwd
    : undefined;
}
