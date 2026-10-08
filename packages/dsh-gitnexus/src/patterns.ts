import { basename } from "node:path";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

const SEARCH_TOOLS = new Set(["read", "grep", "glob", "bash"]);
// Bare paths exclude read anchors, grep source rows, and common source syntax.
const PATH_LINE = /^[^\n\r:│|"'`{}()[\];=<>]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COLON_MATCH = /^([^\n:]+\.[A-Za-z0-9][A-Za-z0-9._-]*):\d+:/;
const MAX_CONTENT_CHARS = 1_048_576;

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

function* structuredPaths(value: unknown): Iterable<string> {
  const object = record(value);
  if (Array.isArray(object?.paths)) {
    for (const path of object.paths) {
      if (typeof path === "string") yield path;
    }
  }
  if (Array.isArray(object?.matches)) {
    for (const match of object.matches) {
      const path = stringProperty(match, "path");
      if (path !== undefined) yield path;
    }
  }
}

function* filePaths(text: string, toolName?: string): Iterable<string> {
  const body = text.trim();
  if (body.startsWith("{") || body.startsWith("[")) {
    // Serialized search values have explicit path fields. Never inspect line/text
    // fields (or recursively traverse arbitrary source JSON) for filenames.
    try {
      yield* structuredPaths(JSON.parse(body));
    } catch {
      // Incomplete JSON is not a path listing.
    }
    return;
  }

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (/^(?:[A-Za-z0-9]{3}│|Line \d+:)/.test(line)) continue;
    const colonPath = line.match(COLON_MATCH)?.[1];
    if (colonPath !== undefined && PATH_LINE.test(colonPath)) {
      yield colonPath;
      continue;
    }
    if (!PATH_LINE.test(line) || line.startsWith("Found ")) continue;
    const nextLine = lines[index + 1]?.trim() ?? "";
    if (toolName !== "grep" || /^Line \d+:/.test(nextLine)) yield line;
  }
}

export function isAugmentableTool(toolName: string): boolean {
  return SEARCH_TOOLS.has(toolName);
}

export function primaryPattern(
  toolName: string,
  args: unknown,
): string | undefined {
  if (toolName === "read") {
    const path = stringProperty(args, "path") ?? stringProperty(args, "file_path");
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
  toolName?: string,
): string[] {
  if (!Number.isFinite(limit) || limit <= 0 || toolName === "read") return [];
  const maxResults = Math.floor(limit);
  if (maxResults === 0) return [];

  const results: string[] = [];
  const seen = new Set<string>();
  let remainingChars = MAX_CONTENT_CHARS;

  for (const block of content) {
    if (block.type !== "text") continue;
    if (block.text.length > remainingChars) break;
    remainingChars -= block.text.length;
    for (const path of filePaths(block.text, toolName)) {
      const pattern = basenamePattern(path);
      if (pattern === undefined) continue;
      const key = pattern.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(pattern);
      if (results.length >= maxResults) return results;
    }
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
    ...extractFilePatterns(content, secondaryLimit, toolName),
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
