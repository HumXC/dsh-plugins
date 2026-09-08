import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { HostConnectionHandle, ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session/types";
import "@deepseek-ai/dsh-storage";
import "@deepseek-ai/dsh-session-query";
import "@deepseek-ai/dsh-host-webserver";
import "@deepseek-ai/dsh-workspace";
import { Config, normalizeConfig } from "./config.js";
import { SessionStateTracker, levelOf, type TrayEvent } from "./state.js";
import { ViewedStore, VIEWED_UNIT } from "./viewed.js";
import { DbusMenuService } from "./menu.js";
import { buildMenuNodes, buildSnapshot, isIdleUnused, MenuIdRegistry } from "./present.js";
import { TrayService } from "./tray.js";
import { NavigationBroker } from "./navigation.js";
import { TrayNavigationService } from "./navigation-service.js";
import { ENDPOINTS, TRAY_RPC_CHANNEL, failure, isNavigationAck, isPresenceDisconnect, isPresenceUpdate } from "./rpc.js";
import { assertTrustedOrigin, openAuthenticatedRoot, resolveBaseUrl } from "./browser.js";
type HostContext = Context & { connection: HostConnectionHandle };

const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next") as typeof import("@deltachat/dbus-next");
export const name = "dsh-tray";
export const inject: string[] = ["sessions", "agents", "sessionQuery", "workspaceRegistry", "storage", "webServer", "connection", "typertGateway"];
const STARTUP_TITLE_HYDRATION_LIMIT = 8;
export { Config } from "./config.js";
export { TrayNavigationService } from "./navigation-service.js";
function focusDotColor(config: Config, focus: { icon: string }): string | undefined {
    if (focus.icon === "red") return config.dotRed;
    if (focus.icon === "yellow") return config.dotYellow;
    if (focus.icon === "green") return config.dotGreen;
    return undefined;
}

function toTrayEvent(ev: SessionEvent): TrayEvent {
    const d = ev.data as {
        reason?: { kind?: string };
        callId?: string;
        name?: string;
        id?: string;
        title?: string;
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
        title: d.title,
    };
}

function isSubagent(source: { readonly header?: { readonly origin?: string } } | undefined): boolean {
    return source?.header?.origin === "subagent";
}

function restoreLatestOwnedTurn(tracker: SessionStateTracker, session: Session): boolean {
    const inherited = Number(session.inheritedEventCount);
    let start = Number(session.seq);
    const end = session.seq;
    while (start > inherited) {
        const event = session.eventAt(SessionSeq(start - 1));
        if (!event) return false;
        start -= 1;
        if (event.type !== "turn/start") continue;
        for (const current of session.snapshotEvents(SessionLogOffset(start), end)) {
            tracker.applyEvent(session.id, toTrayEvent(current));
        }
        return true;
    }
    return false;
}

class RootDisposer {
    private actions: Array<{ order: number; action: () => void | Promise<void> }> = [];
    private done: Promise<void> | undefined;
    add(action: () => void | Promise<void>, order = 0): void { this.actions.push({ action, order }); }
    dispose(): Promise<void> {
        if (this.done) return this.done;
        this.done = (async () => {
            const errors: unknown[] = [];
            for (const item of this.actions.sort((a, b) => a.order - b.order)) { try { await item.action(); } catch (error) { errors.push(error); } }
            this.actions = [];
            if (errors.length) throw new AggregateError(errors, "Tray cleanup failed");
        })();
        return this.done;
    }
}

export async function apply(ctx: HostContext, rawConfig: Config): Promise<void> {
    if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
    const config = normalizeConfig(rawConfig);
    const root = new RootDisposer();
    let disposing = false;
    (ctx as unknown as { on(e: string, listener: () => void | Promise<void>): unknown }).on("dispose", () => { disposing = true; return root.dispose(); });

    const backend = ctx.storage.backend.get("json");
    if (!backend?.kv) { ctx.logger.warn("[dsh-tray] 未找到 json 存储后端,已跳过"); return; }
    const unit = await backend.kv.open({ name: VIEWED_UNIT, version: 1, tables: ["viewed"], hasGlobal: false });
    if (disposing) { await unit.close(); return; }
    root.add(() => unit.close(), 90);
    const viewed = await ViewedStore.open(unit);
    if (disposing) { await root.dispose(); return; }
    let baseUrl: string;
    try {
        baseUrl = assertTrustedOrigin(
            ctx.connection,
            resolveBaseUrl({
                port: ctx.webServer.port,
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            }),
        );
    } catch (err) {
        disposing = true;
        await root.dispose();
        ctx.logger.warn("[dsh-tray] web origin rejected:", (err as Error).message);
        return;
    }
    let tray: TrayService | undefined;
    let menu: DbusMenuService | undefined;
    let rpcDispose: (() => Promise<void>) | undefined;
    let bus: import("@deltachat/dbus-next").MessageBus | undefined;
    let watcherAcquisition: Promise<void> = Promise.resolve();
    const broker = new NavigationBroker({
        launch: () => openAuthenticatedRoot(ctx.connection, baseUrl).catch((err) => {
            ctx.logger.warn("[dsh-tray] authenticated launch failed:", (err as Error).message);
        }),
    });
    root.add(() => broker.dispose(), 20);
    const tracker = new SessionStateTracker(viewed, id => broker.isWatching(id));
    const resolveAgentId = (agent: Agent): string | undefined => {
        const session = (agent as Agent & { readonly session?: Session }).session;
        const id = String(agent.id);
        if (isSubagent(session)) {
            if (tracker.get(id)) tracker.remove(id);
            return undefined;
        }
        if (!session && !tracker.get(id)) return undefined;
        return id;
    };
    const menuIds = new MenuIdRegistry();
    const hydrationAbort = new AbortController();
    const baselineAt = Date.now();
    for (const session of ctx.sessions.list()) {
        if (isSubagent(session)) {
            if (tracker.get(session.id)) tracker.remove(session.id);
            continue;
        }
        tracker.upsert(session.id, { live: true, ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }) });
        const agent = ctx.agents.get(session.id);
        if (agent) {
            const agentId = resolveAgentId(agent);
            if (agentId === undefined) continue;
            tracker.applyStatus(agentId, agent.status === "running");
        }
        restoreLatestOwnedTurn(tracker, session);
    }
    let titleHydrationTimer: ReturnType<typeof setTimeout> | undefined;
    let initialHydrationTimer: ReturnType<typeof setTimeout> | undefined;
    root.add(() => {
        if (titleHydrationTimer) clearTimeout(titleHydrationTimer);
        if (initialHydrationTimer) clearTimeout(initialHydrationTimer);
    }, 14);
    root.add(() => hydrationAbort.abort(), 15);
    let menuById = new Map<number, string>();
    let titleHydrationReady = false;
    let titleHydrationScheduled = false;
    const titleHydrationInFlight = new Set<string>();
    const titleHydrationRequested = new Set<string>();
    let titleHydrationActive = false;
    const titleHydrationSuppressed = new Set<string>();
    let pendingIdleReuse = false;
    const pendingIdleCandidates = new Set<string>();
    root.add(() => { pendingIdleReuse = false; pendingIdleCandidates.clear(); titleHydrationRequested.clear(); titleHydrationInFlight.clear(); titleHydrationSuppressed.clear(); }, 13);
    const settlePendingIdleReuse = (settledIds: readonly string[] = []): void => {
        if (!pendingIdleReuse || disposing || hydrationAbort.signal.aborted) return;
        let idleId: string | undefined;
        for (const id of pendingIdleCandidates) {
            const state = tracker.get(id);
            if (!state || !state.live || levelOf(state) !== 0 || (state.titleKnown && !isIdleUnused(state))) {
                pendingIdleCandidates.delete(id);
                continue;
            }
            if (idleId === undefined && isIdleUnused(state)) idleId = state.id;
        }
        if (idleId !== undefined) {
            pendingIdleReuse = false;
            pendingIdleCandidates.clear();
            enqueueSession(idleId);
        } else {
            for (const id of settledIds) pendingIdleCandidates.delete(id);
            if (pendingIdleCandidates.size === 0) pendingIdleReuse = false;
        }
    };
    const pruneTitleHydrationRequests = (): void => {
        for (const id of titleHydrationRequested) {
            const state = tracker.get(id);
            if (!state || !state.live || state.titleKnown || levelOf(state) !== 0) titleHydrationRequested.delete(id);
        }
    };
    const hydrateDemandedTitles = (): void => {
        pruneTitleHydrationRequests();
        if (!titleHydrationReady || titleHydrationActive || disposing || hydrationAbort.signal.aborted) return;
        const demanded = new Set<SessionId>();
        const focused = tracker.focus().session;
        if (focused) demanded.add(SessionId(focused.id));
        for (const session of tracker.listMenu(50)) demanded.add(SessionId(session.id));
        for (const id of titleHydrationRequested) demanded.add(SessionId(id));
        const titleIds = [...demanded].filter(id => {
            const state = tracker.get(id);
            return state !== undefined && !state.titleKnown && !titleHydrationInFlight.has(id) && !titleHydrationSuppressed.has(id);
        }).slice(0, STARTUP_TITLE_HYDRATION_LIMIT);
        if (titleIds.length === 0) return;
        titleHydrationActive = true;
        for (const id of titleIds) titleHydrationInFlight.add(id);
        void Promise.resolve().then(() => ctx.sessionQuery.readTitleSnapshots(titleIds, hydrationAbort.signal)).then(titles => {
            for (const id of titleIds) {
                titleHydrationInFlight.delete(id);
                titleHydrationRequested.delete(id);
            }
            titleHydrationActive = false;
            if (disposing || hydrationAbort.signal.aborted) return;
            let progressed = false;
            const returned = new Set(titles.map(t => t.sessionId));
            for (const id of titleIds) if (!returned.has(id)) titleHydrationSuppressed.add(id);
            for (const t of titles) {
                const state = tracker.get(t.sessionId);
                if (t.status !== "fulfilled") {
                    titleHydrationSuppressed.add(t.sessionId);
                    continue;
                }
                if (!state) continue;
                titleHydrationSuppressed.delete(t.sessionId);
                if (state.titleKnown) continue;
                tracker.setTitle(t.sessionId, t.value.title?.title);
                progressed = true;
            }
            settlePendingIdleReuse(titleIds);
            if (progressed || titleIds.length > 0) refreshAll();
        }).catch(err => {
            for (const id of titleIds) {
                titleHydrationInFlight.delete(id);
                titleHydrationRequested.delete(id);
                titleHydrationSuppressed.add(id);
            }
            titleHydrationActive = false;
            settlePendingIdleReuse(titleIds);
            if (!disposing && !hydrationAbort.signal.aborted) {
                refreshAll();
                ctx.logger.warn("[dsh-tray] 按需标题读取失败:", (err as Error).message);
            }
        });
    };
    const scheduleTitleHydration = (): void => {
        if (titleHydrationScheduled || titleHydrationTimer || !titleHydrationReady || disposing) return;
        titleHydrationScheduled = true;
        titleHydrationTimer = setTimeout(() => {
            titleHydrationTimer = undefined;
            titleHydrationScheduled = false;
            hydrateDemandedTitles();
        }, 0);
    };
    const requestTitleHydration = (ids: readonly string[]): void => {
        for (const id of ids) {
            const state = tracker.get(id);
            if (state && !state.titleKnown) {
                titleHydrationSuppressed.delete(id);
                titleHydrationRequested.add(id);
            }
        }
        scheduleTitleHydration();
    };
    const demandIdleTitles = (): void => {
        const ids = tracker.all().filter(state => state.live && !state.titleKnown && levelOf(state) === 0).map(state => state.id);
        if (ids.length === 0) return;
        pendingIdleReuse = true;
        for (const id of ids) pendingIdleCandidates.add(id);
        requestTitleHydration(ids);
    };
    const currentMenu = () => {
        const states = tracker.all();
        const built = buildMenuNodes(tracker.listMenu(50), {
            workspaces: ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title })),
            canReuseIdle: states.some(isIdleUnused) || states.some(state => state.live && !state.titleKnown && levelOf(state) === 0),
            registry: menuIds,
        });
        menuById = built.byId;
        return built.root;
    };
    let lastTrayPresentation: string | undefined;
    let lastMenuPresentation: string | undefined;
    const refreshAll = (): void => {
        if (disposing) return;
        pruneTitleHydrationRequests();
        scheduleTitleHydration();
        const focus = tracker.focus();
        const trayPresentation = JSON.stringify([focus.icon, focus.level, focus.session?.id, focus.session?.title]);
        if (tray && trayPresentation !== lastTrayPresentation) {
            tray.refresh();
            lastTrayPresentation = trayPresentation;
        }
        const menuPresentation = JSON.stringify(currentMenu());
        if (menu && menuPresentation !== lastMenuPresentation) {
            menu.markDirty();
            lastMenuPresentation = menuPresentation;
        }
    };
    const enqueueSession = (sessionId: string): void => {
        const result = broker.enqueue({ type: "session", sessionId }, `intent-${randomUUID()}`);
        if (!result.ok) ctx.logger.warn("[dsh-tray] 导航请求被拒绝:", result.error.message);
    };
    const enqueueNewSession = (workspaceId: string): void => {
        const sessionId = SessionId(`session-${randomUUID()}`);
        const result = broker.enqueue({ type: "new-session", workspaceId, sessionId }, `intent-${randomUUID()}`);
        if (!result.ok) ctx.logger.warn("[dsh-tray] 新会话请求被拒绝:", result.error.message);
    };

    const rpcHandler = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> => {
        if (endpoint === ENDPOINTS.presenceUpdate) {
            if (!isPresenceUpdate(payload)) return failure("tray/bad-request", "Invalid presence update");
            const result = broker.register(payload);
            if (
                result.ok &&
                payload.currentSessionId &&
                payload.focused &&
                payload.visible &&
                tracker.get(payload.currentSessionId)
            ) {
                const state = tracker.get(payload.currentSessionId);
                const unread = state !== undefined && (
                    (state.lastCompletedAt ?? 0) > (state.lastViewedAt ?? 0) ||
                    (state.lastErrorAt ?? 0) > (state.lastViewedAt ?? 0)
                );
                if (unread) {
                    tracker.markViewed(payload.currentSessionId);
                    refreshAll();
                }
            }
            return result;
        }
        if (endpoint === ENDPOINTS.presenceDisconnect) {
            if (!isPresenceDisconnect(payload)) return failure("tray/bad-request", "Invalid presence disconnect");
            return broker.disconnect(payload.clientId);
        }
        if (endpoint === ENDPOINTS.navigationAck) {
            if (!isNavigationAck(payload)) return failure("tray/bad-request", "Invalid navigation acknowledgement");
            return broker.ack(payload);
        }
        return failure("tray/bad-request", "Unknown tray endpoint");
    };
    try {
        const navigation = ctx.plugin(TrayNavigationService, broker);
        root.add(() => navigation.dispose(), 25);
        await navigation.await();
        if (disposing) return;
        rpcDispose = ctx.connection.rpc.handle(TRAY_RPC_CHANNEL, rpcHandler);
    } catch (err) {
        disposing = true;
        await root.dispose();
        ctx.logger.warn("[dsh-tray] 导航通道注册失败:", (err as Error).message);
        return;
    }
    root.add(async () => { await rpcDispose?.(); rpcDispose = undefined; }, 30);
    root.add(() => watcherAcquisition, 40);

    const removeIfGone = async (id: string): Promise<void> => {
        try {
            const records = await ctx.sessionQuery.listSessions();
            if (disposing) return;
            const record = records.find(r => String(r.header.id) === id);
            if (!record || isSubagent(record)) tracker.remove(id); else tracker.dispose(id);
            settlePendingIdleReuse();
            if (disposing) return;
        } catch {
            if (!disposing) {
                tracker.dispose(id);
                settlePendingIdleReuse();
            }
        }
        if (disposing) return;
        refreshAll();
    };
    const eventDisposers: Array<() => boolean> = [];
    const on = (event: string, listener: (...args: never[]) => void): void => {
        const dispose = (ctx as unknown as {
            on(e: string, l: (...a: never[]) => void): () => boolean;
        }).on(event, listener);
        eventDisposers.push(dispose);
    };
    root.add(() => { for (const dispose of eventDisposers.splice(0)) dispose(); }, 5);
    try {
        on("session/created", ((session: Session) => {
            if (isSubagent(session)) {
                if (tracker.get(session.id)) tracker.remove(session.id);
                return;
            }
            tracker.upsert(session.id, { live: true });
            settlePendingIdleReuse();
            refreshAll();
        }) as never);
        on("session/event", ((session: Session, ev: SessionEvent) => {
            if (isSubagent(session)) {
                if (tracker.get(session.id)) tracker.remove(session.id);
                return;
            }
            tracker.applyEvent(session.id, toTrayEvent(ev));
            settlePendingIdleReuse();
            refreshAll();
        }) as never);
        on("session/disposed", ((session: Session) => {
            if (isSubagent(session)) {
                if (tracker.get(session.id)) tracker.remove(session.id);
                return;
            }
            void removeIfGone(session.id);
        }) as never);
        on("agent/status", ((data: { agent: Agent; status: AgentStatus }) => {
            const id = resolveAgentId(data.agent);
            if (id === undefined) return;
            tracker.applyStatus(id, data.status === "running");
            settlePendingIdleReuse();
            refreshAll();
        }) as never);
        on("agent/error", ((data: { agent: Agent }) => {
            const id = resolveAgentId(data.agent);
            if (id === undefined) return;
            tracker.applyAgentError(id);
            settlePendingIdleReuse();
            refreshAll();
        }) as never);
    } catch (err) {
        disposing = true;
        await root.dispose();
        ctx.logger.warn("[dsh-tray] 事件订阅失败:", (err as Error).message);
        return;
    }

    const sweepTimer = setInterval(() => {
        void ctx.sessionQuery.listSessions().then(records => {
            if (disposing) return;
            const alive = new Set<string>(); let changed = false;
            for (const rec of records) {
                const id = String(rec.header.id);
                if (isSubagent(rec)) {
                    if (tracker.get(id)) { tracker.remove(id); changed = true; }
                    continue;
                }
                alive.add(id);
            }
            for (const id of tracker.ids()) if (!alive.has(id)) { tracker.remove(id); changed = true; }
            settlePendingIdleReuse();
            if (!disposing && changed) refreshAll();
        }).catch(() => undefined);
    }, 20_000);
    root.add(() => clearInterval(sweepTimer), 10);

    const hydrateInitialState = async (): Promise<void> => {
        try {
            const records = await ctx.sessionQuery.listSessions(hydrationAbort.signal);
            if (disposing || hydrationAbort.signal.aborted) return;
            for (const rec of records) {
                const id = String(rec.header.id);
                if (isSubagent(rec)) {
                    if (tracker.get(id)) tracker.remove(id);
                    continue;
                }
                if (tracker.isRemoved(rec.header.id)) continue;
                const current = tracker.get(rec.header.id);
                tracker.upsert(rec.header.id, { live: current?.live ?? rec.live, ...(rec.header.cwd === undefined ? {} : { cwd: rec.header.cwd }) });
            }
            for (const rec of records) {
                if (isSubagent(rec)) continue;
                const agent = ctx.agents.get(rec.header.id);
                if (agent) {
                    const agentId = resolveAgentId(agent);
                    if (agentId === undefined) continue;
                    tracker.applyStatus(agentId, agent.status === "running");
                }
                const state = tracker.get(rec.header.id);
                if (
                    state &&
                    !state.running &&
                    state.lastTurn?.kind !== "error" &&
                    (state.lastCompletedAt ?? 0) < baselineAt &&
                    (state.lastErrorAt ?? 0) < baselineAt
                ) {
                    tracker.markViewed(rec.header.id, baselineAt);
                }
            }
            refreshAll();
        } catch (err) {
            if (!disposing && !hydrationAbort.signal.aborted) ctx.logger.warn("[dsh-tray] 启动状态扫描失败:", (err as Error).message);
        }
    };


    try {
        bus = dbus.sessionBus(); root.add(() => { bus?.disconnect(); }, 80);
        tray = new TrayService({
            snapshot: () => {
                const focus = tracker.focus();
                const dotColor = focusDotColor(config, focus);
                return buildSnapshot(focus, {
                    iconSize: config.iconSize,
                    outline: config.iconOutline,
                    iconColor: config.iconColor,
                    ...(dotColor === undefined ? {} : { dotColor }),
                });
            },
            onActivate: () => {
                const focused = tracker.focus().session;
                if (focused) {
                    enqueueSession(focused.id);
                } else if (broker.clientsSnapshot().length === 0) {
                    void openAuthenticatedRoot(ctx.connection, baseUrl).catch((err) => {
                        ctx.logger.warn("[dsh-tray] authenticated launch failed:", (err as Error).message);
                    });
                }
            },
            onSecondaryActivate: () => undefined,
            onContextMenu: () => menu?.markDirty(),
        });
        root.add(() => tray?.stop(), 35);
        await tray.start(bus);
        if (disposing) { await tray.stop(); return; }
        menu = new DbusMenuService({
            getRoot: currentMenu,
            onEvent: (id, eventId) => {
                if (eventId !== "clicked") return;
                const payload = menuById.get(id); if (!payload) return;
                if (payload.startsWith("ws:")) { enqueueNewSession(payload.slice(3)); return; }
                if (payload === "new") {
                    const idle = tracker.all().find(isIdleUnused);
                    if (idle) enqueueSession(idle.id); else demandIdleTitles();
                    return;
                }
                enqueueSession(payload);
            },
        });
        root.add(() => menu?.stop(), 50);
        await menu.start(bus);
        if (disposing) { menu.stop(); return; }
        const notify = tray.notifyWatcher(bus); watcherAcquisition = notify;
        try { await notify; } finally { if (watcherAcquisition === notify) watcherAcquisition = Promise.resolve(); }
        if (disposing) { await tray.stop(); return; }
    } catch (err) {
        disposing = true;
        await root.dispose();
        ctx.logger.warn("[dsh-tray] 托盘启动失败,已回滚已获取资源:", (err as Error).message);
        return;
    }
    if (!disposing) {
        titleHydrationReady = true;
        refreshAll();
        initialHydrationTimer = setTimeout(() => {
            initialHydrationTimer = undefined;
            void hydrateInitialState();
        }, 0);
    }
}
