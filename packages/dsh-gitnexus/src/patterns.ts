import { basename } from "node:path";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

const SEARCH_TOOLS = new Set(["read", "grep", "glob", "bash"]);
const PATH_LINE = /^\.?\/?[^\n]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COLON_MATCH = /^([^\n:]+\.[A-Za-z0-9][A-Za-z0-9._-]*):\d+:/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const object = record(value);
  const property = object?.[key];
  return typeof property === "string" ? property : undefined;
}

function basenamePattern(path: string): string | undefined {
  const filename = basename(path.trim());
  const pattern = filename.replace(/\.[^.]+$/, "");
  return pattern.length >= 3 ? pattern : undefined;
}

function textContent(content: readonly ContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

export function isAugmentableTool(toolName: string): boolean {
  return SEARCH_TOOLS.has(toolName);
}

export function primaryPattern(
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName === "read") {
    const path = stringProperty(args, "file_path");
    return path === undefined ? undefined : basenamePattern(path);
  }
  if (toolName === "grep") {
    const pattern = stringProperty(args, "pattern")?.trim();
    return pattern !== undefined && pattern.length >= 3
      ? pattern.slice(0, 200)
      : undefined;
  }
  return undefined;
}

export function extractFilePatterns(
  content: readonly ContentBlock[],
  limit: number,
): string[] {
  if (limit === 0) return [];

  const lines = textContent(content).split("\n");
  const results: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const colonPath = line.match(COLON_MATCH)?.[1];
    const nextLine = lines[index + 1]?.trim() ?? "";
    const groupedPath =
      PATH_LINE.test(line) && /^Line \d+:/.test(nextLine) ? line : undefined;
    const globPath =
      PATH_LINE.test(line) && !line.startsWith("Found ") ? line : undefined;
    const pattern = basenamePattern(colonPath ?? groupedPath ?? globPath ?? "");
    if (pattern === undefined) continue;

    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(pattern);
    if (results.length >= limit) break;
  }

  return results;
}

export function augmentationCandidates(
  toolName: string,
  args: unknown,
  content: readonly ContentBlock[],
  secondaryLimit: number,
): string[] {
  const candidates = [
    primaryPattern(toolName, args),
    ...extractFilePatterns(content, secondaryLimit),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (candidate === undefined) return false;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
