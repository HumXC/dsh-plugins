/** A workspace's display label must never be its absolute filesystem path. */
export function workspaceDisplayName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "当前工作区";
}

/** Keep diagnostics useful without rendering absolute paths in recovery cards. */
export function workspaceDisplayMessage(message: string, workspacePath?: string): string {
  const scoped = workspacePath
    ? message.split(workspacePath).join(workspaceDisplayName(workspacePath))
    : message;
  // Quoted paths may contain spaces; process them before unquoted path tokens.
  return scoped
    .replace(/(["'])((?:[A-Za-z]:[\\/]|\/)[^"'\n]+)\1/g,
      (_match, quote: string, path: string) => quote + workspaceDisplayName(path) + quote)
    .replace(/(^|[\s(=])((?:[A-Za-z]:[\\/]|\/)[^\s,;\)\]"']+)/g,
      (_match, prefix: string, path: string) => prefix + workspaceDisplayName(path));
}
