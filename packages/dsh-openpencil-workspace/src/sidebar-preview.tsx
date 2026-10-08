import { useEffect, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { openDocument } from "./chat-navigation.js";
import type { Workspace } from "./workspace.js";

/** Minimal public Better Sidebar contract; no runtime dependency on the optional plugin. */
interface SidebarService {
  closeTab?(tabId: string, scope: { sessionId: string }): void;
  registerFileViewer(descriptor: {
    id: string; title: string; exts: readonly string[]; priority: number;
    fetchStrategy: "none"; component: (props: PreviewProps) => ReactNode;
  }): () => void;
}
type SidebarPane = { kind: "leaf"; id: string; active: string | null; tabs: { id: string; path?: string }[] } |
  { kind: "split"; children: SidebarPane[] };
interface SidebarStore {
  getSnapshot(): { sessionId?: string; state?: { activePane: string | null; bottomSplits: SidebarPane } };
  update(mutator: (draft: { bottomOpen: boolean }) => void): void;
}
interface NativeSidebar {
  mounted: { getSnapshot(): string | undefined };
  active(): { id: string; contentId: string } | undefined;
  close(tabId: string): void;
  isExpanded(): boolean;
  toggleExpanded(): void;
}
interface PreviewProps {
  scope: { sessionId: string }; path: string;
  ctx?: Pick<Context, "get">; store?: SidebarStore;
}
type Open = (sessionId: string, path: string, signal: AbortSignal) => Promise<void>;
type Status = { phase: "opening" | "opened" | "failed"; message?: string };

/** Capture the initiating surface so a late response cannot dismiss another session or tab. */
export function captureSidebarCollapse({ ctx, store, scope, path }: PreviewProps): () => void {
  const sidebar = ctx?.get("betterSidebar") as SidebarService | undefined;
  const native = ctx?.get("sidebarRight") as NativeSidebar | undefined;
  if (native) {
    const sessionId = native.mounted.getSnapshot();
    const tab = native.active();
    return () => {
      const active = native.active();
      if (tab && sessionId === scope.sessionId && native.mounted.getSnapshot() === sessionId &&
          active?.id === tab.id && active.contentId === tab.contentId) {
        if (sidebar?.closeTab) sidebar.closeTab(tab.id, scope);
        else native.close(tab.id);
        if (native.isExpanded()) native.toggleExpanded();
      }
    };
  }
  // Older hosts use Better Sidebar's own bottom workbench instead of the native right column.
  const activeTab = () => {
    const state = store?.getSnapshot().state;
    const find = (pane: SidebarPane): { id: string; path?: string } | undefined => {
      if (pane.kind === "leaf") return pane.id === state?.activePane ? pane.tabs.find(tab => tab.id === pane.active) : undefined;
      for (const child of pane.children) { const tab = find(child); if (tab) return tab; }
      return undefined;
    };
    return state ? find(state.bottomSplits) : undefined;
  };
  const tab = activeTab();
  return () => {
    if (store?.getSnapshot().sessionId !== scope.sessionId) return;
    if (tab) {
      const active = activeTab();
      if (tab.path !== path || active?.id !== tab.id || active.path !== path) return;
      sidebar?.closeTab?.(tab.id, scope);
    }
    store.update(draft => { draft.bottomOpen = false; });
  };
}

export function createSidebarPreview(open: Open) {
  return function OpenPencilPreview({ scope, path, ctx, store }: PreviewProps) {
    const [attempt, setAttempt] = useState(0);
    const [status, setStatus] = useState<Status>({ phase: "opening" });
    useEffect(() => {
      const controller = new AbortController();
      const collapse = captureSidebarCollapse({ scope, path, ...(ctx ? { ctx } : {}), ...(store ? { store } : {}) });
      setStatus({ phase: "opening" });
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return open(scope.sessionId, path, controller.signal);
      }).then(() => {
        if (controller.signal.aborted) return;
        setStatus({ phase: "opened" });
        collapse();
      }).catch(error => {
        if (!controller.signal.aborted) setStatus({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
      });
      return () => controller.abort();
    }, [scope.sessionId, path, ctx, store, attempt]);
    if (status.phase !== "failed") return null;
    return <div className="dsh-openpencil-sidebar-preview" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
      <strong>无法打开 OpenPencil</strong>
      <div style={{ overflowWrap: "anywhere" }}>{path}</div>
      <div role="alert">{status.message}</div>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
    </div>;
  };
}

export function registerSidebarPreview(ctx: Pick<Context, "inject">, workspace: Workspace): () => Promise<void> {
  const component = createSidebarPreview((sessionId, path, signal) => openDocument(workspace, sessionId, path, signal));
  const fork = ctx.inject(["betterSidebar"], injected => {
    const sidebar = injected.get("betterSidebar") as SidebarService | undefined;
    if (typeof sidebar?.registerFileViewer !== "function") return;
    injected.effect(() => sidebar.registerFileViewer({
      id: "openpencil-workspace:op", title: "OpenPencil", exts: ["op"], priority: 100,
      fetchStrategy: "none", component,
    }), "OpenPencil .op file preview");
  });
  return async () => { await fork.dispose(); };
}
