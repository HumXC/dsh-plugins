/**
 * 浏览器侧插件(§10):深链解析 + SSE 导航监听。
 *  - 深链(托盘 open() 新开时):?tray-session=<id> / ?tray-workspace=<id>&tray-new=1
 *  - SSE(页面开着时):host 广播 navigate,复用当前标签导航
 * 导航落点:ctx.sessions.open(id)(打开会话)/ ctx.workspaces.startSession(id)(新建并打开)。
 * 全程只做导航,不做任何状态上报 / 查看记账(host 全自给)。
 */
import type { ClientContext, SessionId, WorkspaceId } from "@deepseek-ai/dsh-client-runtime/client";

export const name = "dsh-tray-client";

export const inject = ["sessions", "workspaces"];

/** 与 host 端 config.eventsPath 默认值保持一致(host 端自定义路径时需同步)。 */
const EVENTS_PATH = "/plugins/dsh-tray/events";
const READY_TIMEOUT_MS = 8000;

interface ReadySnapshotLike {
  getSnapshot(): { phase?: unknown };
  subscribe(fn: () => void): () => void;
}

interface NavigatePayload {
  type?: string;
  sessionId?: string;
  workspaceId?: string;
  newSession?: boolean;
}

/** 从当前 URL 解析托盘深链参数;无则 null。 */
function parseDeepLink(): NavigatePayload | null {
  const q = new URLSearchParams(window.location.search);
  const sessionId = q.get("tray-session");
  const workspaceId = q.get("tray-workspace");
  const newSession = q.get("tray-new") === "1";
  if (!sessionId && !workspaceId) return null;
  return {
    type: "navigate",
    ...(sessionId ? { sessionId } : {}),
    ...(workspaceId ? { workspaceId, newSession } : {}),
  };
}

/** 清理深链参数,防止刷新时重复触发。 */
function clearDeepLink(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("tray-session");
  url.searchParams.delete("tray-workspace");
  url.searchParams.delete("tray-new");
  window.history.replaceState(null, "", url.toString());
}

/** 等列表快照进入 ready(pending 会话列表到达时必用;超时兜底不阻塞)。 */
function ensureReady(list: ReadySnapshotLike): Promise<void> {
  const snap = list.getSnapshot() as { phase?: unknown } | undefined;
  if (snap?.phase === "ready") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const unsub = list.subscribe(() => {
      const s = list.getSnapshot() as { phase?: unknown } | undefined;
      if (s?.phase === "ready") {
        done = true;
        unsub();
        resolve();
      }
    });
    setTimeout(() => {
      if (!done) {
        unsub();
        resolve();
      }
    }, READY_TIMEOUT_MS);
  });
}

/** 导航落点(会话 / 新建会话)。 */
function navigate(ctx: ClientContext, payload: NavigatePayload): void {
  if (payload.sessionId) {
    void ensureReady(ctx.sessions.list).then(() => {
      try {
        ctx.sessions.open(payload.sessionId! as SessionId);
      } catch (err) {
        console.error("[dsh-tray-client] 打开会话失败:", err);
      }
    });
  } else if (payload.workspaceId) {
    ctx.workspaces.startSession(payload.workspaceId as WorkspaceId);
  }
}

export async function apply(ctx: ClientContext): Promise<void> {
  // 1) 深链(页面由托盘新开)
  const deeplink = parseDeepLink();
  if (deeplink) {
    navigate(ctx, deeplink);
    // 删参防止刷新重复;等一小段让导航先排队(open/startSession 是同步入口)
    setTimeout(clearDeepLink, 50);
  }

  // 2) SSE 导航(页面已开着,托盘广播导航复用标签)
  if (typeof EventSource !== "undefined") {
    const es = new EventSource(EVENTS_PATH);
    es.onmessage = (msg: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(msg.data) as NavigatePayload;
        if (payload.type !== "navigate") return;
        navigate(ctx, payload);
      } catch (err) {
        // 连接未就绪/上下文未激活时导航消息无法解析:仅 debug 级,避免刷屏
        console.debug("[dsh-tray-client] 导航消息解析失败(上下文未就绪,忽略):", (err as Error).message);
      }
    };
  }
}