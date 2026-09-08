import type { McpCallResult } from "./mcp-router.js";
import { workspacePath, type WorkspaceScope } from "./workspace-isolation.js";

const PAGE_SIZE = 256;
const MAX_PATHS = 65_536;
const incomplete = () => new Error("Rename blocked: graph path preflight is incomplete or unsupported");

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Upstream appends a next-step hint after JSON. Parse only a complete object. */
function jsonPrefix(text: string): unknown {
  const source = text.trimStart();
  if (!source.startsWith("{")) throw incomplete();
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(source.slice(0, index + 1));
  }
  throw incomplete();
}

function pathsFromResult(result: McpCallResult): string[] {
  if (result.isError) throw incomplete();
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") throw incomplete();
  const body = record(jsonPrefix(content[0].text));
  if (body.error || body.truncated || body.partial || body.lower_bound || body.row_count !== 1 || typeof body.markdown !== "string") throw incomplete();
  const lines = body.markdown.split("\n");
  if (lines.length !== 3 || lines[0] !== "| paths |" || lines[1] !== "| --- |" || !lines[2]?.startsWith("| ") || !lines[2].endsWith(" |")) throw incomplete();
  // collect(path) renders as JSON, preserving pipes/newlines in filenames.
  const paths: unknown = JSON.parse(lines[2].slice(2, -2));
  if (!Array.isArray(paths) || paths.length > PAGE_SIZE || !paths.every((path): path is string => typeof path === "string" && path.length > 0)) throw incomplete();
  return paths;
}

/** Preview is not safe as a preflight: upstream already reads live old_text. */
export async function validateRenamePaths(
  scope: WorkspaceScope,
  repo: string,
  query: (statement: string) => Promise<McpCallResult>,
): Promise<void> {
  for (let offset = 0; offset <= MAX_PATHS; offset += PAGE_SIZE) {
    const statement = "MATCH (n) WHERE n.filePath IS NOT NULL WITH DISTINCT n.filePath AS path ORDER BY path SKIP " + offset + " LIMIT " + PAGE_SIZE + " RETURN collect(path) AS paths";
    const paths = pathsFromResult(await query(statement));
    if (offset + paths.length > MAX_PATHS) throw incomplete();
    for (const path of paths) workspacePath(scope.root, path, repo);
    if (paths.length < PAGE_SIZE) return;
  }
  throw incomplete();
}
