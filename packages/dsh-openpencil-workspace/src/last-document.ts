import { isOpPath, type EditorRequest } from "./contracts.js";
import { DocumentOpenError, loadDocument } from "./chat-navigation.js";
import type { Workspace } from "./workspace.js";

export const LAST_DOCUMENT_KEY = "dsh-openpencil-workspace:last-document:v1:";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const validPath = (path: unknown): path is string => typeof path === "string" && path.length <= 8192 && isOpPath(path);

/** Only paths are persisted; editor tokens, private drafts and document contents stay out of storage. */
export class LastDocument {
  private readonly attempted = new Set<string>();
  private readonly pending = new Map<string, AbortSignal>();
  constructor(private readonly storage: () => Storage = () => globalThis.localStorage) {}
  private key(sessionId: string): string { return LAST_DOCUMENT_KEY + encodeURIComponent(sessionId); }
  get(sessionId: string): string | undefined {
    try {
      const raw = this.storage().getItem(this.key(sessionId));
      if (!raw) return undefined;
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && "path" in value && validPath(value.path)) return value.path;
    } catch { /* Unavailable or malformed storage must not block the editor. */ }
    return undefined;
  }
  remember(request: EditorRequest): void {
    const path = request.grant.sourcePath;
    if (request.grant.liveDraft || !validPath(path)) return;
    try { this.storage().setItem(this.key(request.sessionId), JSON.stringify({ path })); } catch { /* Persistence is optional. */ }
  }
  private forget(sessionId: string, path: string): void {
    try { if (this.get(sessionId) === path) this.storage().removeItem(this.key(sessionId)); } catch { /* optional storage */ }
  }
  async restore(workspace: Workspace, sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.attempted.has(sessionId) || (this.pending.has(sessionId) && !this.pending.get(sessionId)!.aborted) || !workspace.canRestore(sessionId)) return;
    const path = this.get(sessionId);
    if (!path) return;
    const revision = workspace.getRevision();
    this.pending.set(sessionId, signal);
    try {
      const grant = await loadDocument(sessionId, path, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
      signal.throwIfAborted();
      await workspace.openIfEmpty({ sessionId, grant }, revision, signal);
    } catch (error) {
      if (!signal.aborted && error instanceof DocumentOpenError && error.code === "FILE_NOT_FOUND") this.forget(sessionId, path);
      // A missing, inaccessible or temporarily unavailable file leaves the page empty. Manual opening still reports errors.
    } finally {
      if (this.pending.get(sessionId) === signal) {
        this.pending.delete(sessionId);
        if (!signal.aborted) this.attempted.add(sessionId);
      }
    }
  }
}
