import type { Context } from "@deepseek-ai/cordis";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-tools";
import type { ResolvedConfig } from "./config.js";
import { publicToolName } from "./naming.js";

type GuidanceConfig = Pick<ResolvedConfig, "serverName">;

/** Render advice only for capabilities visible in this assembly. */
export function renderUsageGuidance(
  schemas: readonly Pick<ToolSchema, "name">[],
  config: GuidanceConfig,
): string {
  const visible = new Set(schemas.map(schema => schema.name));
  const tool = (rawName: string): string | undefined => {
    const name = publicToolName(config.serverName, rawName);
    return visible.has(name) ? "`" + name + "`" : undefined;
  };
  const query = tool("query");
  const context = tool("context");
  const impact = tool("impact");
  const detectChanges = tool("detect_changes");
  const status = tool("status");
  const analyze = tool("analyze");
  if (![query, context, impact, detectChanges, status, analyze].some(Boolean)) return "";

  const lines = ["GitNexus usage:"];
  if (query && context) {
    lines.push(`For unfamiliar flows, use ${query} to find execution flows, then ${context} to inspect relevant symbols; verify the evidence against current source before editing.`);
  } else if (query || context) {
    lines.push(`For unfamiliar flows, use ${query ?? context} to inspect relevant graph evidence; verify it against current source before editing.`);
  } else {
    lines.push("Verify graph evidence against current source before editing.");
  }
  const sourceTools = ["grep", "read"].filter(name => visible.has(name));
  if (sourceTools.length > 0) {
    lines.push(`Exact symbol or file lookups can use ${sourceTools.map(name => "`" + name + "`").join(" and ")} directly.`);
  }
  if (impact) lines.push(`Before public-interface changes, deletion, or cross-file refactors, use ${impact} to inspect callers and affected flows.`);
  if (detectChanges) lines.push(`After code changes, use ${detectChanges} to inspect the changed scope and affected flows.`);
  if (status) lines.push(`Use ${status} to inspect workspace index presence and reported state; visibility alone does not establish index freshness or backend readiness.`);
  if (analyze) lines.push(`Use ${analyze} only when an index relevant to the work is missing or confirmed stale; do not reindex for every task.`);
  return lines.join("\n");
}

/** The prompt registry owns the section effect and its Cordis disposal. */
export function installUsageGuidance(ctx: Context, config: GuidanceConfig): () => void {
  return ctx.systemPrompt.section({
    name: "gitnexus:usage-guidance",
    order: ctx.systemPrompt.getSectionOrder("TOOLS_SDK") + 10,
    interpolate: false,
    // schemas() is the public projection of the same scoped visible view used
    // by the SDK renderer, including callable functions under PTC presentation.
    text: context => renderUsageGuidance(ctx.tools.schemas(context.scope), config),
  });
}
