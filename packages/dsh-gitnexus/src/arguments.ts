/** Translate native DSH arguments into the private MCP contract. */
export function commandArguments(name: string, value: Record<string, unknown>, root: string): Record<string, unknown> {
  const args = { ...value };
  for (const [key, item] of Object.entries(args)) {
    if (typeof item === "string" && item.trim().length === 0) throw new Error(key + " must not be empty");
  }
  const integer = (key: string, min: number, max: number) => {
    const item = args[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isSafeInteger(item) || item < min || item > max)) {
      throw new Error(key + " must be an integer between " + min + " and " + max);
    }
  };
  if (name !== "list_repos") args.repo ??= root;
  if (typeof args.repo === "string" && args.repo.startsWith("@")) throw new Error("Repository groups are not supported by native GitNexus tools");
  if (name === "list_repos") {
    integer("limit", 1, 200);
    integer("offset", 0, Number.MAX_SAFE_INTEGER);
  }
  if (name === "query") {
    integer("limit", 1, 100);
    integer("max_symbols", 1, 200);
    args.search_query = args.query;
    delete args.query;
    if (args.content !== undefined) { args.include_content = args.content; delete args.content; }
  }
  if (name === "context" && !args.name && !args.uid) throw new Error("Provide name or uid");
  if (name === "impact") {
    if (!args.target && !args.target_uid) throw new Error("Provide target or target_uid");
    args.direction ??= "upstream";
    integer("maxDepth", 1, 32);
    integer("limit", 1, 10_000);
    integer("offset", 0, Number.MAX_SAFE_INTEGER);
    if (args.minConfidence !== undefined && (typeof args.minConfidence !== "number" || !Number.isFinite(args.minConfidence) || args.minConfidence < 0 || args.minConfidence > 1)) throw new Error("minConfidence must be between 0 and 1");
  }
  if (name === "detect_changes") {
    args.scope ??= "unstaged";
    if (args.scope === "compare" && !args.base_ref) throw new Error("compare requires base_ref");
    if (args.scope !== "compare" && args.base_ref !== undefined) throw new Error("base_ref requires scope compare");
  }
  if (name === "rename") {
    if (!args.symbol_name && !args.symbol_uid) throw new Error("Provide symbol_name or symbol_uid");
    args.dry_run ??= true;
  }
  if (name === "api_impact" && !args.route && !args.file) throw new Error("Provide route or file");
  return args;
}
