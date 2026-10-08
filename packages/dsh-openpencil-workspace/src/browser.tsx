import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { getBridge, VIEW_ID } from "./contracts.js";
import { Workspace } from "./workspace.js";
import { registerNavigation } from "./chat-navigation.js";
import { registerSidebarPreview } from "./sidebar-preview.js";
import { LastDocument } from "./last-document.js";
export const inject = ["slots"];
export function apply(ctx: Pick<Context, "effect" | "slots" | "inject">): void {
  ctx.effect(() => {
    // Remove the retired file catalog without retaining a storage dependency.
    try { window.localStorage.removeItem("dsh-openpencil-workspace:documents:v1"); } catch { /* optional cleanup */ }
    const bridge = getBridge(), lastDocument = new LastDocument(() => window.localStorage);
    const workspace = new Workspace(undefined, request => lastDocument.remember(request));
    const subscribeRuntime = (fn: () => void): (() => void) => {
      window.addEventListener("dsh-openpencil-workspace:runtime", fn);
      return () => window.removeEventListener("dsh-openpencil-workspace:runtime", fn);
    };
    const parking = document.createElement("div"), mount = document.createElement("div");
    parking.dataset.openpencilParking = "true";
    Object.assign(parking.style, { position: "fixed", display: "none", zIndex: "10" });
    mount.className = "dsh-openpencil-workspace-editor";
    parking.append(mount); document.body.append(parking);
    const root = createRoot(mount);
    let seat: HTMLElement | null = null;
    const position = (): void => {
      const request = workspace.getSnapshot();
      const rect = seat?.getBoundingClientRect();
      const active = !!request && seat?.dataset.sessionId === request.sessionId && rect && rect.width > 0 && rect.height > 0;
      Object.assign(parking.style, active
        ? { display: "flex", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" }
        : { display: "none" });
    };
    const observer = new ResizeObserver(position);
    const attachSeat = (element: HTMLElement | null): void => {
      observer.disconnect(); seat = element; if (element) observer.observe(element); position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    function Editor() {
      const request = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
      const runtime = bridge.runtime;
      if (!runtime || !request) return null;
      return <EditorWithRuntime key={runtime.key(request.grant, request.sessionId)} />;
    }
    function EditorWithRuntime() {
      const request = workspace.getSnapshot()!, runtime = bridge.runtime!, options = runtime.options;
      const colorScheme = useSyncExternalStore(options.subscribeTheme, options.getColorScheme);
      const locale = useSyncExternalStore(options.subscribeLocale, options.getLocale);
      const lifecycle = useSyncExternalStore(workspace.subscribe, workspace.getLifecycle);
      const [closing, setClosing] = useState(false);
      const close = async (): Promise<void> => {
        setClosing(true);
        try { await workspace.close(); }
        catch (error) { workspace.report(request.sessionId, error instanceof Error ? error.message : String(error)); }
        finally { setClosing(false); }
      };
      const Component = runtime.Editor;
      return <Component grant={request.grant} sessionId={request.sessionId} colorScheme={colorScheme} locale={runtime.locale(locale)}
        allowTakeover={request.automatic !== true} onLifecycleState={workspace.onState} onLifecycleController={workspace.onController}
        workbenchActions={<button type="button" className="dsh-openpencil-workspace-action" disabled={closing || lifecycle.phase === "saving"}
          title={lifecycle.phase === "saving" ? "请等待保存完成" : "关闭画布并释放编辑会话"} onClick={() => { void close(); }}>{closing ? "正在关闭…" : "关闭"}</button>} />;
    }
    function View(props: ConvViewProps) {
      const runtime = useSyncExternalStore(subscribeRuntime, () => bridge.runtime);
      useEffect(() => {
        if (!runtime) return;
        const controller = new AbortController();
        void lastDocument.restore(workspace, props.sessionId, controller.signal);
        return () => controller.abort();
      }, [props.sessionId, runtime]);
      const request = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
      const notice = useSyncExternalStore(workspace.subscribe, workspace.getNotice);
      useLayoutEffect(() => { if (props.viewRequest?.view === VIEW_ID) props.completeViewRequest(); }, [props.viewRequest, props.completeViewRequest]);
      useLayoutEffect(position, [props.sessionId, request, notice]);
      const active = request?.sessionId === props.sessionId ? request : undefined;
      return <section className="dsh-openpencil-workspace-view" data-openpencil-workspace="true">
        {notice?.sessionId === props.sessionId && <div role="alert">{notice.message}<button type="button" onClick={() => workspace.clearNotice()}>关闭提示</button></div>}
        <div className="dsh-openpencil-workspace-seat" data-session-id={props.sessionId} ref={attachSeat} />
        {!active && <div className="dsh-openpencil-workspace-empty">点击聊天中的 .op 文件链接或卡片的“编辑画布”，即可在这里继续编辑。{request ? "另一个会话的文件仍保留在编辑器中。" : ""}</div>}
      </section>;
    }
    const refresh = (): void => { position(); root.render(<Editor />); };
    const disposeStore = workspace.subscribe(position);
    bridge.handler = { open: (request, automatic) => workspace.open(request, automatic), dispose: () => workspace.release() };
    const disposeNavigation = registerNavigation(ctx, workspace);
    const disposeSidebar = registerSidebarPreview(ctx, workspace);
    const disposeView = ctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: VIEW_ID, label: "OpenPencil", order: 25 }, View));
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-openpencil-workspace";
    style.textContent = 	templateStyle;
    document.head.append(style);
    window.addEventListener("dsh-openpencil-workspace:runtime", refresh); refresh();
    return async () => {
      await disposeSidebar();
      await workspace.dispose();
      if (bridge.handler) delete bridge.handler;
      window.removeEventListener("dsh-openpencil-workspace:runtime", refresh);
      window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); observer.disconnect();
      disposeNavigation(); disposeView(); disposeStore(); root.unmount(); mount.remove(); parking.remove(); style.remove();
    };
  }, "OpenPencil conversation workspace");
}
const templateStyle = `
.dsh-openpencil-workspace-view { position:relative; height:100%; min-height:460px; display:flex; flex-direction:column; max-width:none; }
.dsh-openpencil-workspace-seat { flex:1; min-height:0; display:flex; }
.dsh-openpencil-workspace-editor { flex:1; min-width:0; height:100%; display:flex; flex-direction:column; }
.dsh-openpencil-workspace-editor > * { flex:1; min-height:0; }
.dsh-openpencil-workspace-editor iframe { flex:1; width:100%; min-height:380px; }
.dsh-openpencil-workspace-editor .dsh-openpencil-workspace-toolbar { box-sizing:border-box; height:36px !important; min-height:36px !important; flex:0 0 36px; padding:4px 10px !important; gap:6px !important; }
.dsh-openpencil-workspace-toolbar > strong { font-size:13px !important; }
.dsh-openpencil-workspace-toolbar > button { box-sizing:border-box; height:26px !important; min-height:26px !important; padding:0 9px !important; border:1px solid var(--dsw-alias-border-l2) !important; border-radius:6px !important; background:var(--dsw-alias-bg-layer-1) !important; color:var(--dsw-alias-label-primary) !important; font-family:inherit !important; font-size:12px !important; font-weight:500 !important; line-height:24px !important; cursor:pointer; white-space:nowrap; }
.dsh-openpencil-workspace-toolbar > button:disabled { opacity:.5; cursor:default !important; }
.dsh-openpencil-workspace-toolbar > button:focus-visible { outline:2px solid var(--dsw-alias-label-secondary); outline-offset:2px; }
.dsh-openpencil-workspace-empty { position:absolute; top:32px; left:32px; right:32px; opacity:.8; pointer-events:none; }
[data-conversation-scroll]:has(.dsh-openpencil-workspace-view) > [data-composer-seat]:not(:has([data-approval-key], [data-question-key], [data-plan-review-key])) { display:none; }
`;
