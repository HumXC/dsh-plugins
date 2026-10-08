import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { prepareWorkspaceScope, workspacePath, workspaceRoot } from "./workspace-isolation.js";
import { acquireWorkspaceLease } from "./workspace-lock.js";
import { drainWorkspaceBackends } from "./workspace-backends.js";

const commands: Record<string, Record<string, "boolean" | "value">> = {
  analyze: { "--force": "boolean", "--index-only": "boolean" },
  status: {},
  query: { "--limit": "value" },
  context: { "--content": "boolean" },
  impact: { "--direction": "value", "--depth": "value", "--limit": "value", "--offset": "value", "--include-tests": "boolean", "--summary-only": "boolean" },
  "detect-changes": { "--scope": "value", "--base-ref": "value", "--limit": "value" },
};

export function auditedCliArguments(root: string, input: readonly string[]): string[] {
  const [command, ...rest] = input;
  if (!command || !Object.hasOwn(commands, command)) throw new Error("Unsupported GitNexus command; allowed: analyze, status, query, context, impact, detect-changes");
  const result = [command];
  const seen = new Set<string>();
  let positional = 0;
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]!;
    if (!argument || /[\0\r\n]/.test(argument)) throw new Error("Malformed GitNexus argument");
    if (!argument.startsWith("-")) {
      if (!["query", "context", "impact"].includes(command) || positional++ > 0) throw new Error("Unexpected GitNexus positional argument (workspace is bound)");
      result.push(argument);
      continue;
    }
    const kind = commands[command]![argument];
    if (!kind || seen.has(argument)) throw new Error("Unsupported or duplicate GitNexus flag: " + argument);
    seen.add(argument);
    if (argument !== "--index-only") result.push(argument);
    if (kind === "value") {
      const value = rest[++i];
      if (!value || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error("Missing or invalid GitNexus flag value");
      if (["--limit", "--depth", "--offset"].includes(argument) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 10_000 || Number(value) < (argument === "--offset" ? 0 : 1))) throw new Error("Invalid GitNexus numeric bound");
      if (argument === "--depth" && Number(value) > 32) throw new Error("GitNexus depth exceeds 32");
      if (argument === "--direction" && !["upstream", "downstream"].includes(value)) throw new Error("Invalid GitNexus direction");
      if (argument === "--scope" && !["unstaged", "staged", "all", "compare"].includes(value)) throw new Error("Invalid GitNexus diff scope");
      if (argument === "--base-ref" && !/^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/.test(value)) throw new Error("Invalid GitNexus base ref");
      result.push(value);
    }
  }
  if (["query", "context", "impact"].includes(command) && positional !== 1) throw new Error("GitNexus command requires one query or symbol");
  if (command === "analyze") return [...result, "--index-only", ...(!existsSync(join(root, ".git")) ? ["--skip-git"] : []), root];
  if (command !== "status") result.push("--repo", root);
  return result;
}

function executable(command: string): string {
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [resolve(command)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => resolve(path, command));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); if (lstatSync(realpathSync(path)).isFile()) return realpathSync(path); } catch { /* next configured PATH entry */ }
  }
  throw new Error("Configured GitNexus executable is unavailable; no installation fallback is allowed");
}

/** Caller holds the operation lease. No executable is obtained from model arguments. */
export function ensureWorkspaceCli(cwd: string, command: string): string {
  const scope = prepareWorkspaceScope(cwd);
  const directory = join(scope.root, ".gitnexus", "bin");
  const path = join(directory, "gitnexus");
  if (workspacePath(scope.root, path) !== path) throw new Error("Unsafe GitNexus wrapper alias");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))) throw new Error("Unsafe GitNexus wrapper path");
  const runner = executable(command);
  if (runner === path) throw new Error("Configured GitNexus executable resolves to the workspace wrapper");
  const source = "#!" + process.execPath + "\n" +
    "import(" + JSON.stringify(import.meta.url) + ").then(m => m.runWorkspaceCli(" + JSON.stringify(scope.root) + ", " + JSON.stringify(runner) + ", process.argv.slice(2))).then(code => { process.exitCode = code; }, error => { console.error(String(error)); process.exitCode = 1; });\n";
  if (!existsSync(path) || readFileSync(path, "utf8") !== source) {
    const temporary = join(directory, "gitnexus-" + randomUUID());
    writeFileSync(temporary, source, { flag: "wx", mode: 0o700 });
    renameSync(temporary, path);
  }
  chmodSync(path, 0o700);
  return path;
}

/** Runs in the calling Bash sandbox, never through privileged host IPC. */
export async function runWorkspaceCli(cwd: string, command: string, input: readonly string[]): Promise<number> {
  const root = workspaceRoot(cwd);
  if (root !== cwd) throw new Error("Bound GitNexus workspace moved or became a symlink; refresh the wrapper");
  const argv = auditedCliArguments(root, input);
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (signal: NodeJS.Signals) => {
    cancelled ??= signal;
    controller.abort();
    child?.kill(signal);
    if (child && !killTimer) killTimer = setTimeout(() => child?.kill("SIGKILL"), 2_000);
  };
  const term = () => cancel("SIGTERM");
  const interrupt = () => cancel("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  let lease: Awaited<ReturnType<typeof acquireWorkspaceLease>> | undefined;
  try {
    lease = await acquireWorkspaceLease(root, controller.signal);
    const scope = prepareWorkspaceScope(root);
    if (argv[0] === "status") {
      console.log(JSON.stringify({ root, indexed: scope.repositories.some(repo => repo.path === root), repositories: scope.repositories }));
      return 0;
    }
    if (argv[0] === "analyze") await drainWorkspaceBackends(root, controller.signal);
    else if (!scope.repositories.some(repo => repo.path === root)) throw new Error("Current workspace has no index; run analyze first");
    controller.signal.throwIfAborted();
    const env = { ...process.env, ...scope.env, NODE_OPTIONS: undefined, NODE_PATH: undefined };
    child = spawn(command, argv, { cwd: root, env, stdio: "inherit", shell: false });
    return await new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => {
        const stoppedBy = cancelled ?? signal;
        resolve(stoppedBy ? 128 + osConstants.signals[stoppedBy] : code ?? 1);
      });
    });
  } catch (error) {
    if (cancelled && !child) return 128 + osConstants.signals[cancelled];
    throw error;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    lease?.release();
    process.off("SIGTERM", term); process.off("SIGINT", interrupt);
  }
}
