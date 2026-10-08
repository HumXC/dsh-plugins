import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ResolvedConfig } from "./config.js";
import { GitNexusAccess } from "./access.js";
import { publicToolName } from "./naming.js";
import { sessionCwd } from "./repository.js";
import { acquireWorkspaceLease } from "./workspace-lock.js";
import { ensureWorkspaceCli } from "./workspace-cli.js";
import { prepareWorkspaceScope } from "./workspace-isolation.js";

export async function prepareWorkspaceCli(cwd: string, command: string, signal?: AbortSignal): Promise<string> {
  const lease = await acquireWorkspaceLease(cwd, signal);
  try { return ensureWorkspaceCli(cwd, command); } finally { lease.release(); }
}

export async function prepareLockedScope(cwd: string) {
  const lease = await acquireWorkspaceLease(cwd);
  try { return prepareWorkspaceScope(cwd); } finally { lease.release(); }
}

export function localToolDefinitions(ctx: Context, config: ResolvedConfig, access: GitNexusAccess): ToolDefinition[] {
  return ["analyze", "cli"].map(kind => {
    const name = publicToolName(config.serverName, kind);
    const title = kind === "analyze" ? "GitNexus Index Maintenance" : "GitNexus Workspace CLI";
    return {
      name,
      description: kind === "analyze"
        ? "Build or repair the current session workspace index. Always index-only; optionally force a rebuild. Coordinates with Web and graph tools. Returns stdout/stderr and exit status; no installation fallback."
        : "Prepare the workspace-bound executable CLI and return its exact path and supported usage. Invoke this path in Bash, not global gitnexus. No arbitrary commands, environment or workspace overrides.",
      parameters: { type: "object", properties: kind === "analyze" ? { force: { type: "boolean", description: "Force an index-only rebuild.", default: false } } : {}, required: [], additionalProperties: false },
      output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, render: (_args, value) => [{ type: "text", text: (value as { text: string }).text }] },
      presentCall: args => ({ card: "generic", title, kind: kind === "analyze" ? "edit" : "search", rawInput: args }),
      presentResult: (_args, result) => ({ card: "generic", title: title + (result.isError ? " · Failed" : " · Result"), content: result.content }),
      async execute(args, exec) {
        access.assert(exec.agent, name);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("GitNexus expects an object");
        const input = args as Record<string, unknown>;
        if (Object.keys(input).some(key => kind !== "analyze" || key !== "force") || (input.force !== undefined && typeof input.force !== "boolean")) throw new Error("Unsupported GitNexus maintenance arguments");
        const cwd = sessionCwd(exec.agent);
        if (!cwd) throw new Error("GitNexus requires a session workspace");
        const path = await prepareWorkspaceCli(cwd, config.command, exec.signal);
        if (kind === "cli") return { text: JSON.stringify({ path, usage: ["analyze [--force] [--index-only]", "status", "query <query> [--limit N]", "context <symbol> [--content]", "impact <symbol> [--direction upstream|downstream] [--depth N] [--limit N] [--offset N] [--include-tests] [--summary-only]", "detect-changes [--scope unstaged|staged|all|compare] [--base-ref REF] [--limit N]"], policy: "Use this executable in the caller sandbox. Workspace and isolated runtime are bound. Unknown commands/flags, rename, repo/root/env overrides are denied. Busy operations wait; unknown/stale locks require verified manual recovery." }) };
        const handle = ctx.subprocess.spawn({ argv: [path, "analyze", ...(input.force === true ? ["--force"] : [])], cwd, signal: exec.signal, graceMs: 5_000, stdio: { stdin: "ignore", stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 8 * 1024 * 1024 } } });
        const outcome = await handle.done;
        const stdout = handle.collected.stdout?.readFrom(0);
        const stderr = handle.collected.stderr?.readFrom(0);
        const text = JSON.stringify({ path, exitCode: outcome.exitCode, stdout: stdout?.text ?? "", stderr: stderr?.text ?? "", cancelled: exec.signal.aborted, truncated: stdout?.lossy === true || stderr?.lossy === true });
        if (exec.signal.aborted || outcome.exitCode !== 0 || stdout?.lossy || stderr?.lossy) throw new Error(text);
        return { text };
      },
    } satisfies ToolDefinition;
  });
}
