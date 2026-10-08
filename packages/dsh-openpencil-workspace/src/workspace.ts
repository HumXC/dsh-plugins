import { getBridge, type EditorRequest, type Lifecycle, type LifecycleController, type WorkspaceHandler } from "./contracts.js";
/** One editor survives conversation view switches; all replacements are serialized. */
export class Workspace implements WorkspaceHandler {
  private current: EditorRequest | undefined;
  private state: Lifecycle = { phase: "launching", dirty: false };
  private controller: LifecycleController | undefined;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private closing = false;
  readonly navigators = new Map<string, (view: string, focus: string) => void>();
  private notice: { sessionId: string; message: string } | undefined;
  private readonly openedSessions = new Set<string>();
  private revision = 0;
  constructor(
    private readonly confirmDiscard: () => boolean = () => globalThis.confirm("当前画布有未保存的修改，确定关闭吗？取消后可返回原文件继续编辑或保存。"),
    private readonly remember: (request: EditorRequest) => void = () => {},
  ) {}
  readonly getRevision = (): number => this.revision;
  beginNavigation(): void { this.revision++; }
  canRestore(sessionId: string): boolean { return !this.current && !this.openedSessions.has(sessionId) && !this.stopped && !this.closing && !!getBridge().runtime; }
  readonly getNotice = () => this.notice;
  readonly getSnapshot = (): EditorRequest | undefined => this.current;
  readonly getLifecycle = (): Lifecycle => this.state;
  report(sessionId: string, message: string): void { this.notice = { sessionId, message }; this.emit(); this.navigators.get(sessionId)?.("openpencil", "error"); }
  clearNotice(): void { this.notice = undefined; this.emit(); }
  readonly subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  readonly onState = (state: Lifecycle): void => {
    if (state.phase === "ready" && this.current) this.remember(this.current);
    if (this.state.phase === state.phase && this.state.dirty === state.dirty) return;
    this.state = state; this.emit();
  };
  readonly onController = (value: LifecycleController | undefined): void => { this.controller = value; };
  private emit(): void { for (const fn of this.listeners) fn(); }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result;
  }
  private canClose(): boolean { return this.state.phase !== "saving" && (!this.state.dirty || this.confirmDiscard()); }
  private focus(request: EditorRequest): void { this.navigators.get(request.sessionId)?.("openpencil", request.grant.sourcePath ?? request.grant.draftId ?? "editor"); }
  open(request: EditorRequest, automatic: boolean, signal?: AbortSignal): Promise<boolean> {
    this.revision++;
    return this.openRequest(request, automatic, signal);
  }
  openIfEmpty(request: EditorRequest, revision: number, signal: AbortSignal): Promise<boolean> {
    return this.openRequest(request, true, signal, revision);
  }
  private openRequest(request: EditorRequest, automatic: boolean, signal?: AbortSignal, restoreRevision?: number): Promise<boolean> {
    return this.enqueue(async () => {
      const runtime = getBridge().runtime;
      if (signal?.aborted || this.stopped || this.closing || !runtime) return false;
      if (restoreRevision !== undefined && (restoreRevision !== this.revision || !this.canRestore(request.sessionId))) return false;
      const old = this.current;
      if (old && runtime.key(old.grant, old.sessionId) === runtime.key(request.grant, request.sessionId)) {
        if (!automatic) {
          this.current = { ...old, automatic: false }; this.emit(); this.focus(request);
        }
        return true;
      }
      if (old) {
        const successor = runtime.successor(old, request);
        if (automatic && !successor) return false;
        if (this.state.phase === "saving" || (!successor && !this.canClose())) return false;
        // An editor still launching cannot be discarded by a later request.
        if (!this.controller || !await this.controller.requestClose().catch(() => false)) return false;
        // A cancelled queued navigation must not reopen its stale file after close.
        if (signal?.aborted) {
          this.current = undefined; this.controller = undefined; this.emit(); return false;
        }
      }
      this.controller = undefined;
      this.state = { phase: "launching", dirty: false };
      this.current = { ...request, automatic };
      this.openedSessions.add(request.sessionId);
      this.emit();
      if (!automatic) this.focus(request);
      return true;
    });
  }
  close(): Promise<boolean> {
    this.revision++;
    return this.enqueue(async () => {
      if (!this.current) return true;
      if (!this.canClose() || !this.controller || !await this.controller.requestClose().catch(() => false)) return false;
      this.current = undefined; this.controller = undefined; this.emit(); return true;
    });
  }
  /** Official plugin HMR releases the editor without disabling this workspace. */
  async release(): Promise<void> {
    this.revision++;
    this.closing = true;
    await this.queue;
    if (this.controller) await getBridge().runtime?.preserve(this.state, this.controller);
    this.current = undefined; this.controller = undefined; this.emit();
    this.closing = false;
  }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.release();
    this.listeners.clear(); this.navigators.clear();
  }
}
