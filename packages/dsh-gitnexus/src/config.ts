import z from "@deepseek-ai/schemastery";

export type WebUiMode = "auto" | boolean;

export interface Config {
  command?: string;
  args?: string[];
  serverName?: string;
  autoAugment?: boolean;
  maxConnections?: number;
  toolCallTimeoutMs?: number;
  augmentTimeoutMs?: number;
  maxAugmentsPerResult?: number;
  maxSecondaryPatterns?: number;
  maxContextChars?: number;
  webUi?: WebUiMode;
  servePort?: number;
  serveStartupTimeoutMs?: number;
}

export interface ResolvedConfig {
  command: string;
  args: readonly string[];
  serverName: string;
  autoAugment: boolean;
  maxConnections: number;
  toolCallTimeoutMs: number;
  augmentTimeoutMs: number;
  maxAugmentsPerResult: number;
  maxSecondaryPatterns: number;
  maxContextChars: number;
  webUi: WebUiMode;
  servePort: number;
  serveStartupTimeoutMs: number;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const Config = z.object({
  command: z.string().default("gitnexus"),
  args: z.array(String).default(["mcp"]),
  serverName: z.string().pattern(SERVER_NAME_PATTERN).default("gitnexus"),
  autoAugment: z.boolean().default(true),
  maxConnections: z.number().step(1).min(1).default(8),
  toolCallTimeoutMs: z.number().step(1).min(1).default(60_000),
  augmentTimeoutMs: z.number().step(1).min(1).default(15_000),
  maxAugmentsPerResult: z.number().step(1).min(1).default(3),
  maxSecondaryPatterns: z.number().step(1).min(0).default(2),
  maxContextChars: z.number().step(1).min(1).default(24_000),
  webUi: z
    .union([z.const("auto"), z.boolean()])
    .default("auto")
    .description("Enable the GitNexus view when DSH Web is available."),
  servePort: z
    .number()
    .step(1)
    .min(1)
    .max(65_535)
    .default(4_747)
    .description("Loopback port used by the private GitNexus Web server."),
  serveStartupTimeoutMs: z
    .number()
    .step(1)
    .min(1_000)
    .max(120_000)
    .default(15_000)
    .description("Maximum time to wait for gitnexus serve to become ready."),
});

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-gitnexus: ${name} must be a positive safe integer`);
  }
  return value;
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const command = config.command ?? "gitnexus";
  const serverName = config.serverName ?? "gitnexus";
  const args = config.args ?? ["mcp"];

  if (command.trim().length === 0) {
    throw new Error("dsh-gitnexus: command must be a non-empty string");
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error("dsh-gitnexus: serverName must match [A-Za-z0-9_-]{1,32}");
  }
  if (args.some((argument) => argument.trim().length === 0)) {
    throw new Error("dsh-gitnexus: args must not contain empty strings");
  }

  const maxSecondaryPatterns = config.maxSecondaryPatterns ?? 2;
  if (!Number.isSafeInteger(maxSecondaryPatterns) || maxSecondaryPatterns < 0) {
    throw new Error(
      "dsh-gitnexus: maxSecondaryPatterns must be a non-negative safe integer",
    );
  }

  const servePort = positiveInteger("servePort", config.servePort ?? 4_747);
  if (servePort > 65_535) {
    throw new Error("dsh-gitnexus: servePort must not exceed 65535");
  }

  const webUi = config.webUi ?? "auto";
  if (webUi !== "auto" && typeof webUi !== "boolean") {
    throw new Error("dsh-gitnexus: webUi must be auto or a boolean");
  }

  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    serverName,
    autoAugment: config.autoAugment ?? true,
    maxConnections: positiveInteger(
      "maxConnections",
      config.maxConnections ?? 8,
    ),
    toolCallTimeoutMs: positiveInteger(
      "toolCallTimeoutMs",
      config.toolCallTimeoutMs ?? 60_000,
    ),
    augmentTimeoutMs: positiveInteger(
      "augmentTimeoutMs",
      config.augmentTimeoutMs ?? 15_000,
    ),
    maxAugmentsPerResult: positiveInteger(
      "maxAugmentsPerResult",
      config.maxAugmentsPerResult ?? 3,
    ),
    maxSecondaryPatterns,
    maxContextChars: positiveInteger(
      "maxContextChars",
      config.maxContextChars ?? 24_000,
    ),
    webUi,
    servePort,
    serveStartupTimeoutMs: positiveInteger(
      "serveStartupTimeoutMs",
      config.serveStartupTimeoutMs ?? 15_000,
    ),
  });
}
