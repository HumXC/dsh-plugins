import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface WorkspaceRoute {
  cwd: string;
  root: string;
  hasIndex: boolean;
}

function canonicalDirectory(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveWorkspaceRoute(cwd: string): WorkspaceRoute {
  const canonicalCwd = canonicalDirectory(cwd);
  let directory = canonicalCwd;
  let gitRoot: string | undefined;

  while (true) {
    if (existsSync(resolve(directory, ".gitnexus"))) {
      return { cwd: canonicalCwd, root: directory, hasIndex: true };
    }
    if (gitRoot === undefined && existsSync(resolve(directory, ".git"))) {
      gitRoot = directory;
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return {
    cwd: canonicalCwd,
    root: gitRoot ?? canonicalCwd,
    hasIndex: false,
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
