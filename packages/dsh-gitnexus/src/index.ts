import process from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type {
  JsonValue,
  ToolDefinition,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { AutoAugmentController } from "./augment.js";
import { Config, resolveConfig } from "./config.js";
import type { Config as PluginConfig, ResolvedConfig } from "./config.js";
import { McpConnectionRouter } from "./mcp-router.js";
import type { ListedMcpTool, McpCallResult } from "./mcp-router.js";
import { publicToolName } from "./naming.js";
import { resolveWorkspaceRoute, sessionCwd } from "./repository.js";

export { Config };
export type { PluginConfig as ConfigOptions, ResolvedConfig };
export { publicToolName } from "./naming.js";
export { resolveWorkspaceRoute } from "./repository.js";
export {
  augmentationCandidates,
  extractFilePatterns,
  primaryPattern,
} from "./patterns.js";

export const name = "dsh-gitnexus";
export const inject = ["tools", "subprocess"];

interface RoutedMcpValue {
  content: JsonValue[];
  structuredContent?: JsonValue;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderMcpContent(
  content: readonly unknown[],
  toolName: string,
): string {
  const lines: string[] = [];
  for (const value of content) {
    const block = record(value);
    if (block === undefined) {
      lines.push("[unsupported MCP content block]");
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text);
      continue;
    }
    if (block.type === "resource") {
      const resource = record(block.resource);
      if (typeof resource?.text === "string") lines.push(resource.text);
      else lines.push(`[resource returned by ${toolName}]`);
      continue;
    }
    if (block.type === "resource_link") {
      const label = typeof block.name === "string" ? block.name : "resource";
      const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
      lines.push(`[${label}: ${uri}]`);
      continue;
    }
    if (block.type === "image" || block.type === "audio") {
      const mediaType =
        typeof block.mimeType === "string"
          ? block.mimeType
          : "unknown media type";
      lines.push(`[${String(block.type)}: ${mediaType}]`);
      continue;
    }
    lines.push(`[unsupported MCP content block from ${toolName}]`);
  }
  return lines.join("\n") || "(no output)";
}

function normalizeMcpResult(
  result: McpCallResult,
  rawName: string,
): RoutedMcpValue {
  if ("toolResult" in result) {
    return { content: [{ type: "text", text: jsonText(result.toolResult) }] };
  }

  const content = result.content as JsonValue[];
  if (result.isError === true) {
    throw new Error(renderMcpContent(content, rawName));
  }
  const normalized: RoutedMcpValue = { content };
  if (result.structuredContent !== undefined) {
    normalized.structuredContent = result.structuredContent as JsonValue;
  }
  return normalized;
}

function outputContent(value: JsonValue, rawName: string): ContentBlock[] {
  const object = record(value);
  const content = Array.isArray(object?.content) ? object.content : [];
  return [{ type: "text", text: renderMcpContent(content, rawName) }];
}

function toolArguments(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function routedToolDefinition(
  tool: ListedMcpTool,
  router: McpConnectionRouter,
  config: ResolvedConfig,
): ToolDefinition {
  const publicName = publicToolName(config.serverName, tool.name);
  const definition = {
    name: publicName,
    description: tool.description ?? `GitNexus MCP tool ${tool.name}`,
    parameters: tool.inputSchema,
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          structuredContent: {},
        },
        required: ["content"],
        additionalProperties: false,
      },
      render: (_args, value) => outputContent(value, tool.name),
    },
    timeoutMs: config.toolCallTimeoutMs,
    async execute(
      args: unknown,
      exec: ToolRunContext,
    ): Promise<RoutedMcpValue> {
      if (tool.execution?.taskSupport === "required") {
        throw new Error(
          `GitNexus tool "${tool.name}" requires unsupported MCP task execution`,
        );
      }
      const cwd = sessionCwd(exec.agent) ?? process.cwd();
      const route = resolveWorkspaceRoute(cwd);
      const result = await router.callTool(
        route.root,
        tool.name,
        toolArguments(args),
        exec.signal,
      );
      return normalizeMcpResult(result, tool.name);
    },
  } satisfies ToolDefinition;
  if (tool.annotations?.readOnlyHint === true) {
    return { ...definition, isConcurrencySafe: () => true };
  }
  return definition;
}

export async function apply(
  ctx: Context,
  rawConfig: PluginConfig = {},
): Promise<void> {
  const config = resolveConfig(rawConfig);
  const lifetime = new AbortController();
  const router = new McpConnectionRouter(
    ctx.subprocess,
    config,
    lifetime.signal,
    (message) => ctx.logger.debug(message),
  );
  const disposers: Array<() => void> = [];
  let augmenter: AutoAugmentController | undefined;

  try {
    const discoveryRoute = resolveWorkspaceRoute(process.cwd());
    const tools = await router.discoverTools(discoveryRoute.root);
    const names = new Set<string>();
    for (const tool of tools) {
      const publicName = publicToolName(config.serverName, tool.name);
      if (names.has(publicName)) {
        throw new Error(
          `dsh-gitnexus: GitNexus listed duplicate tool "${tool.name}"`,
        );
      }
      names.add(publicName);
      disposers.push(
        ctx.tools.register(routedToolDefinition(tool, router, config)),
      );
    }

    if (config.autoAugment) {
      augmenter = new AutoAugmentController(ctx, config);
      augmenter.start();
    }
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose();
    lifetime.abort(error);
    await augmenter?.dispose();
    await router.dispose();
    throw error;
  }

  ctx.effect(
    () => async () => {
      for (const dispose of disposers.toReversed()) dispose();
      lifetime.abort(new Error("dsh-gitnexus plugin disposed"));
      await augmenter?.dispose();
      await router.dispose();
    },
    "dsh-gitnexus: unregister tools and close workspace MCP connections",
  );

  ctx.logger.info(
    `dsh-gitnexus: registered ${disposers.length} workspace-routed GitNexus tools`,
  );
}
