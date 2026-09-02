import { createRequire } from "node:module";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
// 声明合并直接加载(§附录:host 服务包各自 declare module '@deepseek-ai/cordis')
import "@deepseek-ai/dsh-storage";
import "@deepseek-ai/dsh-session-query";
import "@deepseek-ai/dsh-host-webserver";
import "@deepseek-ai/dsh-workspace";
import { Config } from "./config.js";
import { SessionStateTracker, type TrayEvent } from "./state.js";
import { ViewedStore, VIEWED_UNIT } from "./viewed.js";
import { DbusMenuService } from "./menu.js";
import { buildMenuNodes, buildSnapshot, isIdleUnused } from "./present.js";
import { MENU_PATH, TrayService } from "./tray.js";

/** 当前关注点的状态点颜色(hex);无点状态返回 undefined。 */
function focusDotColor(config: Config, focus: { icon: string }): string | undefined {
  switch (focus.icon) {
    case "red":
      return config.dotRed;
    case "yellow":
      return config.dotYellow;
    case "green":
      return config.dotGreen;
    default:
      return undefined;
  }
}


import { NavChannel } from "./channel.js";
import { JumpRouter } from "./jump.js";
import { openInBrowser, resolveBaseUrl } from "./browser.js";

const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next") as typeof import("@deltachat/dbus-next");

export const name = "dsh-tray";

export const inject: string[] = [
  "sessions",
  "agents",
  "sessionQuery",
  "workspaceRegistry",
  "storage",
  "webServer",
];

export { Config } from "./config.js";

/** 真实 SessionEvent → 状态机最小事件(只取关注字段,防御性读取)。 */
function toTrayEvent(ev: SessionEvent): TrayEvent {
  const d = ev.data as {
    reason?: { kind?: string };
    callId?: string;
    name?: string;
    id?: string;
    message?: { content?: readonly { toolCallId?: string }[] };
  };
  return {
    type: ev.type,
    seq: ev.seq,
    time: ev.time,
    reasonKind: d.reason?.kind,
    callId: d.callId ?? d.message?.content?.[0]?.toolCallId,
    toolName: d.name,
    approvalId: d.id,
  };
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // —— 环境守卫(§4.2) ——
  if (process.platform !== "linux") {
    ctx.logger.warn("[dsh-tray] 仅支持 Linux,已跳过(platform=" + process.platform + ")");
    return;
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    ctx.logger.warn("[dsh-tray] 未设置 DBUS_SESSION_BUS_ADDRESS(无桌面会话总线),已跳过");
    return;
  }

  // —— M2:会话状态核心(§5/§6) ——
  const backend = ctx.storage.backend.get("json");
  if (!backend?.kv) {
    ctx.logger.warn("[dsh-tray] 未找到 json 存储后端,已跳过");
    return;
  }
  const unit = await backend.kv.open({ name: VIEWED_UNIT, version: 1, tables: ["viewed"], hasGlobal: false });
  const viewed = await ViewedStore.open(unit);
  const tracker = new SessionStateTracker(viewed);

  // —— M3/M4:SNI + DBusMenu + 导航装配 ——
  let menuById = new Map<number, string>();
  let tray: TrayService | undefined;
  let menu: DbusMenuService | undefined;
  let trayStarted = false;
  const refreshAll = (): void => {
    tray?.refresh();
    menu?.markDirty();
  };
  // 导航通道(§9.3):页面开着则广播;否则 open() 新开 + 深链(§9.4)
  const channel = new NavChannel(config.eventsPath, (route) => ctx.webServer.register(route));
  const baseUrl = resolveBaseUrl({
    port: ctx.webServer.port,
    ...(config.webBaseUrl !== undefined ? { webBaseUrl: config.webBaseUrl } : {}),
  });
  const jump = new JumpRouter(channel, { baseUrl, open: openInBrowser });
  // —— "web 已读"同步:注入前端脚本监听会话打开,POST 回来记账(§9.6) ——
  // 前端脚本:监听 localStorage dsh.sessions.current(打开/切换会话必写),上报后端。
  // 通道:dsh 官方 webServer.register 路由;认证:随机 token(每次启动生成,嵌入注入脚本,
  // handler 校验);允许任意来源访问(用户需要外网打开页面),token 即信任边界。
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const viewedToken = randomBytes(16).toString("hex");
  const viewedScript = [
    "(function(){",
    "post({ping:1,token:'__TOKEN__'});",
    "function post(o){",
    "try{fetch('/plugins/dsh-tray/viewed',{method:'POST',",
    "headers:{'Content-Type':'application/json'},",
    "body:JSON.stringify(o)}).catch(function(){});}catch(e){}}",
    "function curId(){try{var v=localStorage.getItem('dsh.sessions.current');",
    "if(!v)return null;var o=JSON.parse(v);return(o&&o.sessionId)||null;}catch(e){return null;}}",
    "function reportOpen(id){if(!id)return;post({sessionId:id,token:'__TOKEN__'});}",
    "function cur(){var id=curId();if(id)reportOpen(id);}",
    "var og=Storage.prototype.setItem;",
    "Storage.prototype.setItem=function(k,v){og.call(this,k,v);",
    "if(k==='dsh.sessions.current'){",
    "try{var o=JSON.parse(v);if(o&&o.sessionId)reportOpen(o.sessionId);}catch(e){}}};",
    "/* 在场状态:窗口聚焦且可见=用户正看着页面 */",
    "function presence(){",
    "var on=document.hasFocus()&&document.visibilityState==='visible';",
    "post(on?{presence:true,token:'__TOKEN__'}:{presence:false,token:'__TOKEN__'});}",
    "addEventListener('focus',presence);",
    "addEventListener('blur',presence);",
    "document.addEventListener('visibilitychange',presence);",
    "/* 行为:聚焦/点击/输入=人在+在看当前会话;去掉节流保证点击必上报(幂等) */",
    "function act(){var id=curId();if(id)post({sessionId:id,token:'__TOKEN__',activity:true});}",
    "document.addEventListener('focusin',act);",
    "document.addEventListener('click',act);",
    "document.addEventListener('pointerup',act);",
    "document.addEventListener('keydown',act);",
    "cur();",
    "addEventListener('DOMContentLoaded',function(){",
    "setTimeout(cur,400);setTimeout(presence,500);});",
    "})();",
  ].join("")
    .split("__TOKEN__").join(viewedToken);
  const SESSION_ID_RE = /^[a-zA-Z0-9-]{20,80}$/;
  try {
    (ctx as unknown as { on(e: string, l: (...a: unknown[]) => void): void }).on(
      "webserver/index-inject",
      (table: unknown) => {
        (table as { push(r: unknown): void }).push({ kind: "script", placement: "body", text: viewedScript });
      },
    );
    ctx.webServer.register({
      kind: "exact",
      path: "/plugins/dsh-tray/viewed",
      handler: async (req, res) => {
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body) as { sessionId?: unknown; token?: unknown; presence?: unknown };
          if (parsed.token !== viewedToken) {
            res.writeHead(401).end();
            return;
          }
          if (typeof parsed.presence === "boolean") {
            // 在场状态翻转(focus/blur/visibilitychange):不记账,仅更新"是否看着页面";
            // 也刷新托盘/菜单,保证界面与状态一致
            tracker.setPresence(parsed.presence);
            refreshAll();
            res.writeHead(204).end();
            return;
          }
          if (typeof parsed.sessionId !== "string" || !SESSION_ID_RE.test(parsed.sessionId)) {
            res.writeHead(400).end();
            return;
          }
          // 打开/切换/页面内行为:该会话即"当前查看"且人在,视为已读
          tracker.setCurrent(parsed.sessionId);
          tracker.setPresence(true);
          tracker.markViewed(parsed.sessionId);
          refreshAll();
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      },
    });
  } catch (err) {
    ctx.logger.warn("[dsh-tray] web 已读同步装配失败(webServer 不可用时忽略):", (err as Error).message);
  }

  /** 跳到某会话:记账 + 刷新 + 导航。 */
  const jumpTo = (sessionId: string): void => {
    tracker.markViewed(sessionId);
    refreshAll();
    jump.route({ type: "session", sessionId });
  };


  // 事件订阅(+ 每事件后刷新呈现)
  ctx.on("session/created", (session: Session) => {
    tracker.upsert(session.id, { live: true });
    refreshAll();
  });
  ctx.on("session/event", (session: Session, ev: SessionEvent) => {
    tracker.applyEvent(session.id, toTrayEvent(ev));
    refreshAll();
  });
  ctx.on("session/disposed", (session: Session) => {
    // 会话销毁:若已从会话存储消失 → 真正移除菜单项;仍存在(持久,仅不 live)→ 保留
    void removeIfGone(session.id);
  });
  ctx.on("agent/status", ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    tracker.applyStatus(agent.id, status === "running");
    refreshAll();
  });
  ctx.on("agent/error", ({ agent }: { agent: Agent }) => {
    tracker.applyAgentError(agent.id);
    refreshAll();
  });

  /** 销毁判定:listSessions 仍存在则仅标 non-live,否则从菜单移除。 */
  async function removeIfGone(id: string): Promise<void> {
    try {
      const records = await ctx.sessionQuery.listSessions();
      if (!records.some((r) => String(r.header.id) === id)) {
        if (tracker.remove(id)) refreshAll();
        return;
      }
      tracker.dispose(id);
      refreshAll();
    } catch {
      tracker.dispose(id);
      refreshAll();
    }
  }

  // 轮询兜底:某些销毁路径事件可能漏发,定期对照真实会话列表清扫菜单
  const sweepTimer = setInterval(() => {
    void (async () => {
      try {
        const records = await ctx.sessionQuery.listSessions();
        const alive = new Set(records.map((r) => String(r.header.id)));
        let changed = false;
        for (const id of tracker.ids()) {
          if (!alive.has(id)) {
            tracker.remove(id);
            changed = true;
          }
        }
        if (changed) refreshAll();
      } catch {
        /* 会话存储暂不可用,跳过本轮 */
      }
    })();
  }, 20_000);

  // 启动全量扫描(§5.3):只重建"会话存在 + 标题 + live/running",不回放历史事件——
  // 启动即"已查看"(见下),回放的状态点会被清零,纯属耗时浪费(曾拖慢启动)。
  try {
    const records = await ctx.sessionQuery.listSessions();
    for (const rec of records) {
      tracker.upsert(
        rec.header.id,
        rec.header.cwd === undefined ? { live: rec.live } : { live: rec.live, cwd: rec.header.cwd },
      );
    }
    const titles = await ctx.sessionQuery.readTitleSnapshots(records.map((r) => r.header.id));
    for (const t of titles) {
      if (t.status === "fulfilled" && t.value.title) tracker.setTitle(t.sessionId, t.value.title.title);
    }
    for (const rec of records) {
      const agent = ctx.agents.get(rec.header.id);
      if (agent) tracker.applyStatus(rec.header.id, agent.status === "running");
    }
    // 启动即"已查看":历史残留的完成/错误不点亮,刚启动为干净无点状态。
    // (之后新的事件/完成才会重新点亮绿/红点)
    for (const rec of records) tracker.markViewed(rec.header.id);
    const focus = tracker.focus();
    ctx.logger.info(
      "[dsh-tray] 状态就绪:" + records.length + " 个会话;关注点=" + focus.icon +
        (focus.session ? "(" + focus.session.id + ")" : ""),
    );
  } catch (err) {
    ctx.logger.warn("[dsh-tray] 全量扫描失败,仅依赖增量事件:", (err as Error).message);
  }
  refreshAll();

  // —— M3:挂载 SNI 服务与菜单 ——
  try {
    const bus = dbus.sessionBus();
    tray = new TrayService({
      snapshot: () => {
        const f = tracker.focus();
        const dot = focusDotColor(config, f);
        return buildSnapshot(f, {
          iconSize: config.iconSize,
          outline: config.iconOutline,
          iconColor: config.iconColor,
          ...(dot === undefined ? {} : { dotColor: dot }),
        });
      },
      onActivate: () => {
        const f = tracker.focus();
        if (f.session) jumpTo(f.session.id);
      },
      onSecondaryActivate: () => {
        /* 预留 */
      },
      onContextMenu: () => menu?.markDirty(),
    });
    menu = new DbusMenuService({
      getRoot: () => {
        const workspaces = ctx.workspaceRegistry.list().map((w) => ({ id: w.id, title: w.title }));
        const result = buildMenuNodes(tracker.listMenu(50), { workspaces, iconSize: config.iconSize });
        menuById = result.byId;
        return result.root;
      },
      onEvent: (id, eventId) => {
        if (eventId !== "clicked") return;
        const payload = menuById.get(id) ?? "";
        if (payload.startsWith("ws:")) {
          // 在工作区新建会话:跳转(页面开着广播;否则新开 + 深链)
          jump.route({ type: "new-session", workspaceId: payload.slice(3) });
          return;
        }
        if (payload === "new") {
          // 已有未使用的空闲会话 → 直接跳转到它(不再新建);没有才进入工作区选择
          const idle = tracker.listMenu(50).find(isIdleUnused);
          if (idle) {
            jumpTo(idle.id);
            return;
          }
          ctx.logger.info("[dsh-tray] 新会话:请选择工作区");
          return;
        }
        if (payload) jumpTo(payload);
      },
    });
    await tray.start(bus);
    await menu.start(bus);
    // 菜单对象就绪后才向 watcher 注册(否则 waybar 探测 Menu 失败,菜单永久失效)
    await tray.notifyWatcher(bus);
    trayStarted = true;
    // cordis 运行时支持 dispose 事件,但其类型缺该键;这里保持调用
    (ctx as unknown as { on(e: string, l: () => void): unknown }).on("dispose", () => {
    clearInterval(sweepTimer);
      tray?.stop();
      menu?.stop();
      channel.dispose();
      try {
        bus.disconnect();
      } catch {
        /* ignore */
      }
    });
    ctx.logger.info("[dsh-tray] 托盘已注册: " + tray.name + " 菜单=" + MENU_PATH);
  } catch (err) {
    trayStarted = false;
    ctx.logger.warn("[dsh-tray] 托盘启动失败,插件保持后台跟踪:", (err as Error).message);
  }

  void trayStarted;
  ctx.logger.info("[dsh-tray] M3 完成:状态核心 + SNI/DBusMenu 已挂载");
}