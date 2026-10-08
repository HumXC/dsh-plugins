import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { devNull } from "node:os";

export interface ScopedRepository {
  name: string;
  path: string;
  storagePath: string;
  indexedAt?: unknown;
  lastCommit?: unknown;
  stats?: unknown;
}
export interface WorkspaceScope {
  root: string;
  home: string;
  repositories: ScopedRepository[];
  env: NodeJS.ProcessEnv;
}

export function workspaceRoot(cwd: string): string {
  if (!cwd || !isAbsolute(cwd)) throw new Error("GitNexus requires an absolute session workspace");
  return realpathSync(cwd);
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}
/** Resolve existing ancestors, including dangling symlinks, before permitting a path. */
export function workspacePath(root: string, value: string, base = root): string {
  const path = resolve(base, value);
  if (!contains(root, path)) throw new Error("GitNexus path is outside the session workspace");
  let ancestor = path;
  while (true) {
    try {
      lstatSync(ancestor);
      const real = realpathSync(ancestor);
      if (!contains(root, real)) throw new Error("GitNexus symlink escapes the session workspace");
      return resolve(real, relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing directory and must never be followed.
      try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("GitNexus dangling symlink is not allowed"); } catch (nested) {
        if ((nested as NodeJS.ErrnoException).code !== "ENOENT") throw nested;
      }
      if (ancestor === root) throw new Error("GitNexus workspace is missing");
      ancestor = dirname(ancestor);
    }
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function gitPointer(root: string, value: string, base: string): string {
  const pointer = value.trim();
  if (!pointer || /^["']/.test(pointer) || /[\0\r\n]/.test(pointer)) throw new Error("Unsupported quoted or malformed Git metadata pointer");
  return workspacePath(root, pointer, base);
}

/** Follow contained metadata aliases, never external targets; bound traversal. */
function validateGitTrees(root: string, gitDirs: string[]): void {
  const visited = new Set<string>();
  const objectDirs = gitDirs.map(dir => join(dir, "objects"));
  const pending = [...gitDirs];
  let checked = 0;
  const visit = (start: string) => {
    pending.push(start);
    while (pending.length) {
      const directory = workspacePath(root, pending.pop()!);
      if (!existsSync(directory) || visited.has(directory)) continue;
      if (!lstatSync(directory).isDirectory()) throw new Error("Git metadata directory is not a directory");
      visited.add(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++checked > 100_000) throw new Error("Git metadata safety traversal limit exceeded");
        const target = workspacePath(root, join(directory, entry.name));
        if (lstatSync(target).isDirectory()) pending.push(target);
      }
    }
  };
  const seenObjects = new Set<string>();
  visit(gitDirs[0]!);
  while (objectDirs.length) {
    const objects = workspacePath(root, objectDirs.pop()!);
    if (seenObjects.has(objects)) continue;
    if (++checked > 100_000) throw new Error("Git metadata safety traversal limit exceeded");
    seenObjects.add(objects);
    visit(objects);
    const alternates = workspacePath(root, join(objects, "info/alternates"));
    if (!existsSync(alternates)) continue;
    for (const line of readFileSync(alternates, "utf8").split(/\r?\n/).filter(Boolean)) {
      objectDirs.push(gitPointer(root, line, objects));
    }
  }
}

/** Git can otherwise follow a linked worktree or alternates outside the scope. */
function validateGitMetadata(root: string, directory: string): void {
  let git = workspacePath(root, join(directory, ".git"));
  if (!existsSync(git)) return;
  if (lstatSync(git).isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"));
    if (!match?.[1]) throw new Error("Invalid workspace Git metadata pointer");
    git = gitPointer(root, match[1], directory);
  }
  const gitDirs = [git];
  const common = workspacePath(root, join(git, "commondir"));
  if (existsSync(common)) git = gitPointer(root, readFileSync(common, "utf8"), git);
  gitDirs.push(git);
  for (const dir of new Set(gitDirs)) {
    for (const name of ["config", "config.worktree"]) {
      const config = workspacePath(root, join(dir, name));
      if (!existsSync(config)) continue;
      const text = readFileSync(config, "utf8").replace(/\\\r?\n/g, "");
      // Deliberately conservative: never follow include chains or interpret a
      // worktree override, even when it might ultimately resolve inside scope.
      if (/\[\s*include/i.test(text) || /\bworktree\s*(?:=|$)/im.test(text)) {
        throw new Error("Workspace Git configuration includes or worktree overrides are not supported in isolated mode");
      }
    }
  }
  validateGitTrees(root, gitDirs);
}
function safeStorage(root: string, storage: string): void {
  const stack = [storage];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = workspacePath(root, join(directory, item.name));
      // Indexes must not follow directory aliases: otherwise cycles and mutable
      // external storage pointers can bypass the initial storage root check.
      if (item.isSymbolicLink()) throw new Error("GitNexus index contains a symbolic link: " + path);
      if (item.isDirectory()) stack.push(path);
    }
  }
}
/** Discover from the workspace only. Never read or import a global registry. */
export function discoverWorkspaceRepositories(cwd: string): ScopedRepository[] {
  const root = workspaceRoot(cwd);
  const repos: ScopedRepository[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Discovery cannot inspect private descendants; do not block accessible indexes.
      // Root, Git metadata, and index storage errors still fail at their own boundaries.
      if (directory !== root && (code === "EACCES" || code === "EPERM")) continue;
      throw error;
    }
    if (entries.some(entry => entry.name === ".git")) validateGitMetadata(root, directory);
    const index = entries.find(entry => entry.name === ".gitnexus");
    if (index) {
      const storagePath = workspacePath(root, join(directory, ".gitnexus"));
      if (index.isSymbolicLink()) throw new Error("GitNexus index directory must not be a symbolic link");
      if (index.isDirectory()) {
        safeStorage(root, storagePath);
        for (const filename of ["gitnexus.json", "meta.json"]) {
          const metadata = workspacePath(root, join(storagePath, filename));
          if (!existsSync(metadata)) continue;
          let meta: Record<string, unknown>;
          try { meta = object(JSON.parse(readFileSync(metadata, "utf8"))); }
          catch (error) { if (error instanceof SyntaxError) break; throw error; }
          repos.push({ name: relative(root, directory) || basename(directory), path: directory, storagePath,
            indexedAt: meta.indexedAt, lastCommit: meta.lastCommit, stats: meta.stats });
          break;
        }
      }
    }
    for (const entry of entries) {
      if ([".git", ".gitnexus", "node_modules", ".pnpm-store"].includes(entry.name)) continue;
      // Do not traverse directory aliases. Live rename paths are independently
      // checked from the graph, including normally ignored dependency paths.
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(workspacePath(root, join(directory, entry.name)));
    }
  }
  return repos.sort((a, b) => a.path.localeCompare(b.path));
}

export function prepareWorkspaceScope(cwd: string): WorkspaceScope {
  const root = workspaceRoot(cwd);
  const repositories = discoverWorkspaceRepositories(root);
  const home = workspacePath(root, join(root, ".gitnexus", "runtime"));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  workspacePath(root, home);
  const registry = workspacePath(root, join(home, "registry.json"));
  if (existsSync(registry) && lstatSync(registry).isSymbolicLink()) throw new Error("GitNexus runtime registry must not be a symbolic link");
  const temporary = join(home, "registry-" + randomUUID() + ".tmp");
  writeFileSync(temporary, JSON.stringify(repositories), { flag: "wx", mode: 0o600 });
  renameSync(temporary, registry);
  // HOME relocation, rather than output filtering, keeps backend startup and
  // metadata validation from opening the user's global repository registry.
  // No MCP allowlist is needed: this registry contains only discovered indexes,
  // and the router validates every selector. Unset inherited MCP restrictions
  // so a new/unindexed workspace can initialize without invalid policy entries.
  const env: NodeJS.ProcessEnv = {
    GITNEXUS_HOME: home, GITNEXUS_MCP_ALLOWED_REPOS: undefined, GITNEXUS_MCP_DEFAULT_REPO: undefined,
    RIPGREP_CONFIG_PATH: undefined,
    GIT_CEILING_DIRECTORIES: dirname(root), GIT_DIR: undefined, GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_INDEX_FILE: undefined, GIT_SHALLOW_FILE: undefined, GIT_CONFIG: undefined,
    GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
  };
  return { root, home, repositories, env };
}

export function scopedToolArguments(scope: WorkspaceScope, method: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  if (method === "list_repos") return args;
  const selector = args.repo;
  let repo = scope.repositories.find(item => item.path === scope.root);
  if (selector !== undefined) {
    if (typeof selector !== "string" || selector.startsWith("@")) throw new Error("Invalid workspace repository selector");
    const matches = scope.repositories.filter(item => item.name === selector || basename(item.path) === selector || item.path === selector);
    if (matches.length === 1) repo = matches[0];
    else {
      const selected = workspacePath(scope.root, selector);
      repo = scope.repositories.find(item => item.path === selected);
      if (!repo) throw new Error("Repository is not indexed in the current workspace");
    }
  }
  if (!repo) throw new Error("Current workspace is not indexed; select an indexed descendant repository or analyze it first");
  args.repo = repo.path;
  for (const key of ["file_path", "file", "path", "worktree"]) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "string") throw new Error("Invalid GitNexus path selector: " + key);
    const path = workspacePath(scope.root, args[key] as string, repo.path);
    // Preserve relative source filters, but canonicalize the worktree selector.
    if (key === "worktree") args[key] = path;
  }
  if (method === "cypher" && typeof args.statement === "string" && /\b(?:CALL|LOAD|COPY|ATTACH|INSTALL|IMPORT|EXPORT|READ_CSV|READ_JSON|READ_PARQUET)\b/i.test(args.statement)) {
    throw new Error("Workspace GitNexus permits graph queries, not filesystem or extension procedures");
  }
  return args;
}
