import z from "@deepseek-ai/schemastery";

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
  });
}
