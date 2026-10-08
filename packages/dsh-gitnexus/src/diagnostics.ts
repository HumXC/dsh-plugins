import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { GitNexusAccess } from "./access.js";
import type { ResolvedConfig } from "./config.js";
import type { McpConnectionRouter } from "./mcp-router.js";
import { publicToolName } from "./naming.js";
import { NATIVE_COMMANDS } from "./commands.js";
import { resolveWorkspaceRoute, sessionCwd } from "./repository.js";
import { workspaceDisplayMessage, workspaceDisplayName } from "./workspace-display.js";

export function diagnosticToolDefinition(
  ctx: Context,
  config: ResolvedConfig,
  access: GitNexusAccess,
  router: McpConnectionRouter,
  registeredNames: ReadonlySet<string>,
): ToolDefinition {
  const name = publicToolName(config.serverName, "status");
  return {
    name,
    description: "Inspect current workspace index-directory presence, registered and scope-visible GitNexus tools, and cached backend capabilities/errors. Does not start a backend or establish index freshness; unknown means unchecked.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          registeredTools: { type: "array", items: { type: "string" } },
          visibleTools: { type: "array", items: { type: "string" } },
          index: { type: "object", properties: { present: { type: "boolean" }, freshness: { type: "string", enum: ["unknown"] } }, required: ["present", "freshness"], additionalProperties: false },
          backend: { type: "object", properties: { state: { type: "string", enum: ["unknown", "ready", "unavailable"] }, supportedTools: { type: "array", items: { type: "string" } }, lastError: { oneOf: [{ type: "string" }, { type: "null" }] } }, required: ["state", "supportedTools", "lastError"], additionalProperties: false },
        },
        required: ["workspace", "registeredTools", "visibleTools", "index", "backend"],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: "generic", title: "GitNexus Status", kind: "search", rawInput: args }),
    presentResult: (_args, result) => ({ card: "generic", title: "GitNexus Status" + (result.isError ? " · Failed" : " · Result"), content: result.content }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      access.assert(exec.agent, name);
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("GitNexus status expects an empty object");
      const cwd = sessionCwd(exec.agent);
      if (!cwd) throw new Error("GitNexus status requires a session workspace");
      const route = resolveWorkspaceRoute(cwd);
      const backend = router.getDiagnostics(route.root);
      return {
        workspace: workspaceDisplayName(route.root),
        registeredTools: [...registeredNames],
        visibleTools: [...registeredNames].filter(tool => ctx.tools.get(tool, exec.agent) !== undefined && access.allows(exec.agent, tool)),
        index: { present: route.hasIndex, freshness: "unknown" },
        backend: {
          state: backend.state,
          supportedTools: backend.supportedTools.filter(tool => NATIVE_COMMANDS.some(command => command.name === tool)),
          lastError: backend.lastError ? workspaceDisplayMessage(backend.lastError, route.root).slice(0, 2000) : null,
        },
      };
    },
  };
}
