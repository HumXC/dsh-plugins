import process from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type {
  JsonValue,
  ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import { AnalysisCoordinator } from "./analysis-coordinator.js";
import { GitNexusAccess, INDEX_STATUS_TOOL } from "./access.js";
import { AutoAugmentController } from "./augment.js";
import { Config, resolveConfig } from "./config.js";
import type { Config as PluginConfig, ResolvedConfig } from "./config.js";
import { McpConnectionRouter } from "./mcp-router.js";
import type { ListedMcpTool, McpCallResult } from "./mcp-router.js";
import { publicToolName } from "./naming.js";
import { resolveWorkspaceRoute, sessionCwd } from "./repository.js";
import { GitNexusWebHost } from "./web-host.js";
import { NATIVE_COMMANDS } from "./commands.js";
import { commandArguments } from "./arguments.js";

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
  text: string;
  data?: JsonValue;
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
    return { text: jsonText(result.toolResult), data: result.toolResult as JsonValue };
  }
  const text = renderMcpContent(result.content, rawName);
  if (result.isError === true) throw new Error(text);
  const normalized: RoutedMcpValue = { text };
  if (result.structuredContent !== undefined) {
    normalized.data = result.structuredContent as JsonValue;
    const structuredText = jsonText(normalized.data);
    if (!text.includes(structuredText)) {
      normalized.text = text ? `${text}\n\n${structuredText}` : structuredText;
    }
  } else {
    // GitNexus appends a next-step footer after its JSON payload. Keep the full
    // text (including risk caveats) even when extracting machine-readable data.
    try { normalized.data = JSON.parse(text.split("\n\n---\n", 1)[0]!) as JsonValue; } catch { /* Text-only result. */ }
  }
  return normalized;
}

function outputContent(value: JsonValue): ContentBlock[] {
  const object = record(value);
  return [{ type: "text", text: typeof object?.text === "string" ? object.text : jsonText(value) }];
}

function toolArguments(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

export function routedToolDefinition(
  tool: ListedMcpTool,
  router: McpConnectionRouter,
  config: ResolvedConfig,
  access = new GitNexusAccess(config),
): ToolDefinition {
  const command = NATIVE_COMMANDS.find(command => command.name === tool.name);
  if (command === undefined) throw new Error("Unsupported native GitNexus tool: " + tool.name);
  const publicName = publicToolName(config.serverName, command.name);
  return {
    name: publicName,
    description: command.description,
    parameters: command.parameters,
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Complete result text, including warnings and completeness limits." },
          data: { description: "Parsed JSON evidence when available; never replaces text warnings." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      render: (_args, value) => outputContent(value),
    },
    presentCall(args) {
      const input = toolArguments(args);
      const preview = command.name === "rename" && input.dry_run !== false;
      return {
        card: "generic",
        title: command.title + (preview ? " · Preview" : ""),
        kind: command.name === "rename" && !preview ? "edit" : "search",
        rawInput: args,
      };
    },
    presentResult(_args, result) {
      return {
        card: "generic",
        title: command.title + (result.isError ? " · Failed" : " · Result"),
        content: result.content,
      };
    },
    async execute(args, exec) {
      access.assert(exec.agent, publicName);
      if (tool.execution?.taskSupport === "required") {
        throw new Error("GitNexus tool requires unsupported MCP task execution: " + tool.name);
      }
      const cwd = sessionCwd(exec.agent);
      if (!cwd) throw new Error("GitNexus requires a session workspace");
      const route = resolveWorkspaceRoute(cwd);
      const result = await router.callTool(
        route.root,
        command.name,
        commandArguments(command.name, toolArguments(args), route.root),
        exec.signal,
      );
      return normalizeMcpResult(result, command.name);
    },
  } satisfies ToolDefinition;
}

export async function apply(
  ctx: Context,
  rawConfig: PluginConfig = {},
): Promise<void> {
  const config = resolveConfig(rawConfig);
  // Only display permission crosses DSH's structured HTML bootstrap channel.
  // Register before async discovery, including when the Web view is disabled.
  ctx.on("webserver/index-inject", (rows) => {
    rows.push({ kind: "global", name: "__DSH_GITNEXUS_CONFIG__", value: { webUi: config.webUi !== false } });
  });
  const access = new GitNexusAccess(config);
  const lifetime = new AbortController();
  const analysis = new AnalysisCoordinator();
  const router = new McpConnectionRouter(
    ctx.subprocess,
    config,
    lifetime.signal,
    (message) => ctx.logger.debug(message),
    analysis,
  );
  const disposers: Array<() => void> = [];
  let augmenter: AutoAugmentController | undefined;

  try {
    const discoveryRoute = resolveWorkspaceRoute(process.cwd());
    const tools = await router.discoverTools(discoveryRoute.root);
    const names = new Set<string>();
    for (const command of NATIVE_COMMANDS) {
      const tool = tools.find(tool => tool.name === command.name);
      if (tool === undefined) throw new Error("GitNexus backend is missing required tool: " + command.name);
      const publicName = publicToolName(config.serverName, command.name);
      if (names.has(publicName)) {
        throw new Error(
          `dsh-gitnexus: GitNexus listed duplicate tool "${tool.name}"`,
        );
      }
      names.add(publicName);
      disposers.push(
        ctx.tools.register(routedToolDefinition(tool, router, config, access)),
      );
    }

    if (config.accessMode !== "all") {
      if (names.has(INDEX_STATUS_TOOL)) throw new Error("GitNexus index status name collision");
      names.add(INDEX_STATUS_TOOL);
      disposers.push(ctx.tools.register({
        name: INDEX_STATUS_TOOL,
        description: "Read the current workspace index-directory presence. This does not establish freshness; request index maintenance through the main agent when missing or stale.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", properties: { root: { type: "string" }, hasIndex: { type: "boolean" } }, required: ["root", "hasIndex"], additionalProperties: false },
          render: (_args, value) => [{ type: "text", text: jsonText(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
          access.assert(exec.agent, INDEX_STATUS_TOOL);
          const cwd = sessionCwd(exec.agent);
          if (cwd === undefined) throw new Error("GitNexus index status requires a session workspace");
          const { root, hasIndex } = resolveWorkspaceRoute(cwd);
          return { root, hasIndex };
        },
      }));
      disposers.push(access.install(ctx, [...names]));
    }

    if (config.autoAugment) {
      augmenter = new AutoAugmentController(ctx, config, analysis, access);
      augmenter.start();
    }

    if (config.webUi !== false) {
      void ctx.inject(["webServer", "sessions"], (webCtx) => {
        // SAFETY: Cordis invokes this callback only while both injected services exist.
        const webServer = (
          webCtx as Context & { readonly webServer: WebServer }
        ).webServer;
        const webHost = new GitNexusWebHost(webCtx, config, analysis, router);
        const disposeCapability = webServer.register({
          kind: "exact",
          path: "/gitnexus/session/open",
          handler: (req, res) => webHost.handleSession(req, res),
        });
        const disposeGateway = webServer.register({
          kind: "prefix",
          path: "/gitnexus/session",
          handler: (req, res) => webHost.handle(req, res),
        });
        webCtx.effect(
          () => async () => {
            disposeGateway();
            disposeCapability();
            await webHost.dispose();
          },
          "dsh-gitnexus: release Web gateway and GitNexus server",
        );
      });
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
