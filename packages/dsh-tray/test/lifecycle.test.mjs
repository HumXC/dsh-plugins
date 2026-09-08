import test from "node:test";
import assert from "node:assert/strict";
import { openerCalls, resetOpenerCalls } from "./process-isolation.mjs";
import childProcess from "node:child_process";
import { spawn as childProcessSpawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dbus = require("@deltachat/dbus-next");
const { TrayService } = require("../lib/tray.js");
const { DbusMenuService } = require("../lib/menu.js");
const { NavigationBroker } = require("../lib/navigation.js");
const { SessionStateTracker } = require("../lib/state.js");
const { buildMenuNodes, isIdleUnused, sessionMenuLabel } = require("../lib/present.js");

function service() {
    return new TrayService({ snapshot: () => ({ status: "Active", pixmap: [], tooltipTitle: "", tooltipBody: "" }), onActivate() { }, onSecondaryActivate() { }, onContextMenu() { } });
}
function bus(reply, log) {
    return { requestName: async () => reply, export: () => { }, unexport: () => log.push("unexport"), releaseName: async () => log.push("release") };
}

test("TrayService accepts only primary/already owner and awaits idempotent release", async () => {
    for (const reply of [dbus.RequestNameReply.PRIMARY_OWNER, dbus.RequestNameReply.ALREADY_OWNER]) {
        const log = []; const tray = service(); await tray.start(bus(reply, log)); await tray.stop(); await tray.stop();
        assert.deepEqual(log, ["unexport", "release"]);
    }
    for (const reply of [dbus.RequestNameReply.IN_QUEUE, dbus.RequestNameReply.EXISTS]) {
        const log = []; const tray = service(); await assert.rejects(() => tray.start(bus(reply, log)), /未获得所有权/);
        assert.deepEqual(log, ["release"]);
    }
});

test("TrayService settles pending name acquisition before one concurrent release", async () => {
    const events = [];
    let resolveRequest;
    const pendingBus = {
        requestName: () => new Promise(resolve => { resolveRequest = resolve; }),
        export: () => events.push("export"),
        unexport: () => events.push("unexport"),
        releaseName: async () => events.push("release"),
    };
    const tray = service();
    const starting = tray.start(pendingBus);
    await new Promise(resolve => setImmediate(resolve));
    const stopping = tray.stop();
    const stoppingAgain = tray.stop();
    resolveRequest(dbus.RequestNameReply.PRIMARY_OWNER);
    await Promise.all([starting, stopping, stoppingAgain]);
    assert.deepEqual(events, ["release"]);
});

test("TrayService releases ownership when watcher listener removal throws", async () => {
    const log = [];
    const tray = service();
    const watchedBus = {
        ...bus(dbus.RequestNameReply.PRIMARY_OWNER, log),
        on() { },
        off() { throw new Error("off failed"); },
        getProxyObject: async () => { throw new Error("watcher unavailable"); },
    };
    await tray.start(watchedBus);
    await tray.notifyWatcher(watchedBus);
    await tray.stop();
    assert.deepEqual(log, ["unexport", "release"]);
});

test("TrayService settles pending watcher registration before releasing its name", async () => {
    const log = [];
    let resolveProxy;
    let registrations = 0;
    const watchedBus = {
        ...bus(dbus.RequestNameReply.PRIMARY_OWNER, log),
        on() { },
        off() { },
        getProxyObject: () => new Promise(resolve => { resolveProxy = resolve; }),
    };
    const tray = service();
    await tray.start(watchedBus);
    const notifying = tray.notifyWatcher(watchedBus);
    await new Promise(resolve => setImmediate(resolve));
    const stopping = tray.stop();
    assert.deepEqual(log, []);
    resolveProxy({ getInterface: () => ({ RegisterStatusNotifierItem: async () => { registrations += 1; } }) });
    await notifying;
    await stopping;
    assert.equal(registrations, 0);
    assert.equal(log.at(-1), "release");
});

test("tray lifecycle can restart repeatedly without duplicate release", async () => {
    const tray = service();
    for (let i = 0; i < 20; i += 1) {
        const log = [];
        const b = bus(dbus.RequestNameReply.PRIMARY_OWNER, log);
        await tray.start(b);
        await tray.stop();
        assert.deepEqual(log, ["unexport", "release"]);
    }
});

test("runtime title and reusable idle session are reflected in menu", () => {
    const viewed = { lastViewedAt: () => undefined, markViewed() { } };
    const tracker = new SessionStateTracker(viewed);
    tracker.upsert("idle", { live: true });
    tracker.applyEvent("active", { type: "session/title", seq: 1, time: 1000, title: "Runtime title" });
    const menu = buildMenuNodes([tracker.get("idle"), tracker.get("active")], { canReuseIdle: true });
    assert.equal(menu.root[0].enabled, true);
    assert.equal(menu.root.some(node => node.label === "Runtime title"), true);
    assert.equal(isIdleUnused({ ...tracker.get("idle"), live: false }), false);
});

test("unresolved live title is not treated as reusable idle", () => {
    const tracker = new SessionStateTracker({ lastViewedAt: () => undefined, markViewed() { } });
    const idle = tracker.upsert("idle", { live: true });
    assert.equal(isIdleUnused(idle), false);
    assert.equal(sessionMenuLabel(idle), "加载中…");
    tracker.setTitle("idle", undefined);
    assert.equal(isIdleUnused(tracker.get("idle")), true);
    assert.equal(sessionMenuLabel(tracker.get("idle")), "新会话");
});

const { apply } = await import("../lib/index.js");
const { openAuthenticatedRoot } = await import("../lib/browser.js");

test("test isolation blocks child processes and records the opener boundary", async () => {
    resetOpenerCalls();
    const methods = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
    for (const name of methods) {
        assert.throws(() => childProcess[name]("xdg-open", ["http://127.0.0.1:3080"]), new RegExp(`unexpected child_process\\.${name} invocation`));
    }
    assert.throws(() => childProcessSpawn("xdg-open", ["http://127.0.0.1:3080"]), /unexpected child_process\.spawn invocation/);
    await openAuthenticatedRoot({ authenticatedUrl: url => url }, "http://127.0.0.1:3080");
    assert.deepEqual(openerCalls, [{ url: "http://127.0.0.1:3080" }]);
});
function makeLiveSession(input) {
    const events = input.events ?? [];
    return {
        ...input,
        header: { id: input.id, ...input.header },
        inheritedEventCount: input.inheritedEventCount ?? 0,
        seq: input.seq ?? events.length,
        eventAt: input.eventAt ?? (seq => events[seq]),
        snapshotEvents: input.snapshotEvents ?? ((from = 0, to = events.length) => events.slice(from, to)),
    };
}

function hostFixture({ failMenu = false, sessionRecords = [], liveSessions = [], runningSessions = [], listSessions, readTitleSnapshots, viewedWrites = [], getProxyObject } = {}) {
    const running = new Set(runningSessions);
    const live = liveSessions.map(makeLiveSession);
    const events = [];
    const authUrls = [];
    let disposeListener;
    let rpcHandler;
    const listeners = new Map();
    const unit = {
        loadAll: async () => ({ tables: {}, global: null }),
        putRecord: async (...args) => { viewedWrites.push(args); },
        close: async () => { events.push("store-close"); },
    };
    const bus = {
        requestName: async () => dbus.RequestNameReply.PRIMARY_OWNER,
        export(path) { events.push("export:" + path); if (failMenu && path === "/StatusNotifierItem/Menu") throw new Error("menu export failed"); },
        unexport(path) { events.push("unexport:" + path); },
        releaseName: async () => { events.push("release"); },
        disconnect: () => { events.push("disconnect"); },
        on: () => { },
        off: () => { },
        getProxyObject: getProxyObject ?? (async () => { throw new Error("watcher unavailable"); }),
    };
    const ctx = {
        plugin() {
            events.push("navigation-register");
            return { async await() {}, async dispose() { events.push("navigation-dispose"); } };
        },
        storage: { backend: { get: () => ({ kv: { open: async () => unit } }) } },
        connection: {
            requestRejection: () => 401,
            authenticatedUrl: baseUrl => { const url = baseUrl + "?token=test"; authUrls.push(url); return url; },
            rpc: { handle: (_channel, handler) => { rpcHandler = handler; events.push("rpc-register"); return async () => { events.push("rpc-dispose"); }; } },
        },
        webServer: { port: 3080 },
        workspaceRegistry: { list: () => [] },
        agents: {
            get: id => {
                const session = live.find(candidate => candidate.id === id);
                return running.has(id) ? { id, status: "running", ...(session ? { session } : {}) } : undefined;
            },
        },
        sessions: { list: () => live },
        sessionQuery: { listSessions: listSessions ?? (async () => sessionRecords), readTitleSnapshots: readTitleSnapshots ?? (async () => []) },
        logger: { warn: () => { } },
        on(event, listener) {
            if (event === "dispose") disposeListener = listener;
            listeners.set(event, listener);
            return () => { events.push("off:" + event); };
        },
    };
    return { ctx, bus, events, authUrls, viewedWrites, emit: (event, ...args) => listeners.get(event)?.(...args), rpc: (endpoint, payload) => rpcHandler?.(endpoint, payload, new AbortController().signal), dispose: async () => disposeListener?.() };
}

test("exported apply rolls back partially acquired Host resources in order", async () => {
    const fixture = hostFixture({ failMenu: true });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
    } finally {
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
    const release = fixture.events.indexOf("release");
    const disconnect = fixture.events.indexOf("disconnect");
    const close = fixture.events.indexOf("store-close");
    assert.ok(fixture.events.includes("rpc-dispose"));
    assert.ok(fixture.events.includes("unexport:/StatusNotifierItem"));
    assert.ok(release >= 0 && release < disconnect && disconnect < close);
});

test("exported apply cancels pending watcher registration before proxy resolution", async () => {
    let resolveProxy;
    let registrations = 0;
    const fixture = hostFixture({
        getProxyObject: () => new Promise(resolve => { resolveProxy = resolve; }),
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    const config = { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" };
    try {
        const applying = apply(fixture.ctx, config);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof resolveProxy, "function");
        const disposing = fixture.dispose();
        await disposing;
        await applying;
        const release = fixture.events.indexOf("release");
        const disconnect = fixture.events.indexOf("disconnect");
        const close = fixture.events.indexOf("store-close");
        assert.ok(release >= 0 && release < disconnect && disconnect < close);
        resolveProxy({ getInterface: () => ({ RegisterStatusNotifierItem: async () => { registrations += 1; } }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrations, 0);
    } finally {
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("exported apply settles with a never-resolving watcher and ignores late rejection", async () => {
    let rejectProxy;
    let registrations = 0;
    const fixture = hostFixture({
        getProxyObject: () => new Promise((_resolve, reject) => { rejectProxy = reject; }),
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    const config = { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" };
    try {
        const applying = apply(fixture.ctx, config);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof rejectProxy, "function");
        await fixture.dispose();
        await applying;
        const release = fixture.events.indexOf("release");
        const disconnect = fixture.events.indexOf("disconnect");
        const close = fixture.events.indexOf("store-close");
        assert.ok(release >= 0 && release < disconnect && disconnect < close);
        rejectProxy(new Error("late watcher rejection"));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrations, 0);
    } finally {
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("exported apply cancels an in-flight watcher registration response", async () => {
    let resolveRegistration;
    let registrationCalls = 0;
    const fixture = hostFixture({
        getProxyObject: async () => ({
            getInterface: () => ({
                RegisterStatusNotifierItem: () => {
                    registrationCalls += 1;
                    return new Promise(resolve => { resolveRegistration = resolve; });
                },
            }),
        }),
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    const config = { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" };
    try {
        const applying = apply(fixture.ctx, config);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrationCalls, 1);
        assert.equal(typeof resolveRegistration, "function");
        await fixture.dispose();
        await applying;
        const release = fixture.events.indexOf("release");
        const disconnect = fixture.events.indexOf("disconnect");
        const close = fixture.events.indexOf("store-close");
        assert.ok(release >= 0 && release < disconnect && disconnect < close);
        resolveRegistration();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrationCalls, 1);
    } finally {
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("exported apply settles a never-resolving registration response and ignores late rejection", async () => {
    let rejectRegistration;
    let registrationCalls = 0;
    const fixture = hostFixture({
        getProxyObject: async () => ({
            getInterface: () => ({
                RegisterStatusNotifierItem: () => {
                    registrationCalls += 1;
                    return new Promise((_resolve, reject) => { rejectRegistration = reject; });
                },
            }),
        }),
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    const config = { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" };
    try {
        const applying = apply(fixture.ctx, config);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrationCalls, 1);
        assert.equal(typeof rejectRegistration, "function");
        await fixture.dispose();
        await applying;
        const release = fixture.events.indexOf("release");
        const disconnect = fixture.events.indexOf("disconnect");
        const close = fixture.events.indexOf("store-close");
        assert.ok(release >= 0 && release < disconnect && disconnect < close);
        rejectRegistration(new Error("late registration rejection"));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(registrationCalls, 1);
    } finally {
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("exported apply uses authenticated root when no session has focus", async () => {
    resetOpenerCalls();
    const fixture = hostFixture();
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldStart = TrayService.prototype.start;
    const oldNotify = TrayService.prototype.notifyWatcher;
    let tray;
    TrayService.prototype.start = async function() { tray = this; };
    TrayService.prototype.notifyWatcher = async function() { };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        tray.cb.onActivate();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(fixture.authUrls, ["http://127.0.0.1:3080?token=test"]);
        assert.deepEqual(openerCalls.map(call => call.url), fixture.authUrls);
        await fixture.rpc("presence/update", { clientId: "open-page", focused: true, visible: true, currentSessionId: null });
        tray.cb.onActivate();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(openerCalls.length, 1, "existing page must prevent a duplicate launch without an attention target");
        await fixture.rpc("presence/disconnect", { clientId: "open-page" });
        tray.cb.onActivate();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(openerCalls.length, 2, "without a page, activation must launch again");
        await fixture.dispose();
    } finally {
        TrayService.prototype.start = oldStart;
        TrayService.prototype.notifyWatcher = oldNotify;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("presence update immediately refreshes a newly viewed unread session", async () => {
    const fixture = hostFixture({ sessionRecords: [{ header: { id: "green" }, live: false }] });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldRefresh = TrayService.prototype.refresh;
    const oldMarkDirty = DbusMenuService.prototype.markDirty;
    const snapshots = [];
    let refreshes = 0;
    let dirty = 0;
    TrayService.prototype.refresh = function() { refreshes += 1; snapshots.push(this.snapshotNow()); return oldRefresh.call(this); };
    DbusMenuService.prototype.markDirty = function() { dirty += 1; return oldMarkDirty.call(this); };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        refreshes = 0; dirty = 0; snapshots.length = 0;
        fixture.emit("session/event", { id: "green" }, { type: "turn/end", seq: 1, time: Date.now() + 100, data: { reason: { kind: "completed" } } });
        await new Promise(resolve => setTimeout(resolve, 110));
        const unread = snapshots.at(-1);
        assert.match(unread.tooltipBody, /已完成/);
        refreshes = 0; dirty = 0; snapshots.length = 0;
        const before = refreshes;
        await fixture.rpc("presence/update", { clientId: "client-green", focused: true, visible: true, currentSessionId: "green" });
        assert.equal(refreshes, before + 1);
        assert.equal(dirty, 1);
        assert.match(snapshots.at(-1).tooltipBody, /空闲/);
        await fixture.rpc("presence/update", { clientId: "client-green", focused: true, visible: true, currentSessionId: "green" });
        assert.equal(refreshes, before + 1);
        assert.equal(dirty, 1);
        await new Promise(resolve => setImmediate(resolve));
        const writes = fixture.viewedWrites.length;
        for (let i = 0; i < 100; i++) {
            await fixture.rpc("presence/update", { clientId: "client-green", focused: true, visible: true, currentSessionId: "green" });
            fixture.emit("session/event", { id: "green" }, { type: "tool/result", seq: i + 2, time: Date.now(), data: { callId: "untracked" } });
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.viewedWrites.length, writes);
        assert.equal(refreshes, before + 1);
        assert.equal(dirty, 1);
        await fixture.dispose();
    } finally {
        TrayService.prototype.refresh = oldRefresh;
        DbusMenuService.prototype.markDirty = oldMarkDirty;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("slow history and titles do not block tray registration", async () => {
    let resolveList;
    let resolveTitles;
    let listCalls = 0;
    let titleCalls = 0;
    const order = [];
    const snapshots = [];
    const fixture = hostFixture({
        liveSessions: [{ id: "running", header: { id: "running" } }],
        runningSessions: ["running"],
        listSessions: () => {
            order.push("list-start");
            listCalls += 1;
            return new Promise(resolve => { resolveList = resolve; });
        },
        readTitleSnapshots: async () => {
            order.push("title-start");
            titleCalls += 1;
            return new Promise(resolve => { resolveTitles = resolve; });
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldRefresh = TrayService.prototype.refresh;
    TrayService.prototype.notifyWatcher = async function() { };
    TrayService.prototype.refresh = function() { snapshots.push(this.snapshotNow()); return oldRefresh.call(this); };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    let applying;
    try {
        const started = performance.now();
        applying = apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await applying;
        order.push("apply-resolved");
        const applyDurationMs = performance.now() - started;
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(applyDurationMs < 100, `controlled startup took ${applyDurationMs.toFixed(1)}ms`);
        assert.equal(listCalls, 1);
        assert.ok(fixture.events.includes("export:/StatusNotifierItem"));
        assert.ok(fixture.events.includes("rpc-register"));
        assert.equal(titleCalls, 1);
        assert.ok(order.indexOf("apply-resolved") < order.indexOf("title-start"));
        assert.ok(order.indexOf("apply-resolved") < order.indexOf("list-start"));
        assert.equal(snapshots.some(snapshot => snapshot.tooltipBody.includes("running")), true);
    } finally {
        await fixture.dispose();
        resolveList?.([]);
        resolveTitles?.([]);
        if (applying) await applying;
        TrayService.prototype.notifyWatcher = oldNotify;
        TrayService.prototype.refresh = oldRefresh;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("demanded title hydration resolves later-visible sessions without history scans", async () => {
    const batches = [];
    let resolveFirstBatch;
    const liveSessions = Array.from({ length: 9 }, (_, i) => ({ id: `live-${i}`, header: { id: `live-${i}` } }));
    const records = [
        ...liveSessions.map(session => ({ header: session.header, live: true, persisted: true })),
        ...Array.from({ length: 30 }, (_, i) => ({ header: { id: `history-${i}` }, live: false, persisted: true })),
    ];
    const fixture = hostFixture({
        liveSessions,
        listSessions: async () => records,
        readTitleSnapshots: async ids => {
            batches.push([...ids]);
            const results = ids.map(sessionId => ({
                sessionId,
                status: "fulfilled",
                value: { session: { id: sessionId }, title: { title: `title-${sessionId}` } },
            }));
            if (batches.length === 1) return new Promise(resolve => { resolveFirstBatch = () => resolve(results); });
            return results;
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldRefresh = TrayService.prototype.refresh;
    const snapshots = [];
    TrayService.prototype.notifyWatcher = async function() { };
    TrayService.prototype.refresh = function() { snapshots.push(this.snapshotNow()); return oldRefresh.call(this); };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(batches, []);
        for (let i = 0; i < 8; i += 1) fixture.emit("agent/status", { agent: { id: `live-${i}` }, status: "running" });
        await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(batches.length, 1);
        assert.deepEqual([...batches[0]].sort(), liveSessions.slice(0, 8).map(session => session.id).sort());
        fixture.emit("agent/status", { agent: { id: "live-8" }, status: "running" });
        await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(batches.length, 1);
        for (let i = 0; i < 8; i += 1) fixture.emit("session/event", { id: `live-${i}` }, { type: "session/title", seq: i + 1, time: Date.now(), data: { title: i === 0 ? "runtime title" : `runtime title ${i}` } });
        resolveFirstBatch?.();
        await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(snapshots.some(snapshot => snapshot.tooltipBody.includes("runtime title")), true);
        await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(batches.length, 2);
        assert.deepEqual([...batches[1]], ["live-8"]);
        assert.equal(batches.flat().some(id => id.startsWith("history-")), false);
    } finally {
        await fixture.dispose();
        TrayService.prototype.notifyWatcher = oldNotify;
        TrayService.prototype.refresh = oldRefresh;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});
test("new-session lazily hydrates unknown idle candidates", async () => {
    resetOpenerCalls();
    const batches = [];
    let menuCallbacks;
    const fixture = hostFixture({
        liveSessions: [{ id: "idle", header: { id: "idle" } }],
        listSessions: async () => [{ header: { id: "idle" }, live: true, persisted: true }, { header: { id: "history" }, live: false, persisted: true }],
        readTitleSnapshots: async ids => {
            batches.push([...ids]);
            return ids.map(sessionId => ({ sessionId, status: "fulfilled", value: { session: { id: sessionId } } }));
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldEnqueue = NavigationBroker.prototype.enqueue;
    const intents = [];
    const oldMenuStart = DbusMenuService.prototype.start;
    NavigationBroker.prototype.enqueue = function(intent, key) { intents.push(intent); return oldEnqueue.call(this, intent, key); };
    DbusMenuService.prototype.start = async function(bus) { menuCallbacks = this.cb; return oldMenuStart.call(this, bus); };
    TrayService.prototype.notifyWatcher = async function() { };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        const newBefore = menuCallbacks.getRoot().find(node => node.data === "new");
        assert.equal(newBefore?.enabled, true);
        menuCallbacks.onEvent(newBefore.id, "clicked", undefined);
        menuCallbacks.onEvent(newBefore.id, "clicked", undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(batches, [["idle"]]);
        assert.deepEqual(openerCalls.map(call => call.url), ["http://127.0.0.1:3080?token=test"]);
        assert.deepEqual(intents, [{ type: "session", sessionId: "idle" }]);
        const newAfter = menuCallbacks.getRoot().find(node => node.data === "new");
        assert.equal(newAfter?.enabled, true);
        assert.equal(batches.flat().includes("history"), false);
    } finally {
        await fixture.dispose();
        DbusMenuService.prototype.start = oldMenuStart;
        NavigationBroker.prototype.enqueue = oldEnqueue;
        TrayService.prototype.notifyWatcher = oldNotify;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("new-session preserves idle reuse for a runtime-settled ninth candidate", async () => {
    resetOpenerCalls();
    const liveSessions = Array.from({ length: 9 }, (_, index) => ({ id: `idle-${index}`, header: { id: `idle-${index}` } }));
    const firstBatchIds = liveSessions.slice(0, 8).map(session => session.id);
    let removed = false;
    let menuCallbacks;
    let hydratedIds;
    const batches = [];
    let resolveTitles;
    const fixture = hostFixture({
        liveSessions,
        listSessions: async () => (removed ? liveSessions.filter(session => session.id !== "idle-8") : liveSessions).map(session => ({ header: { id: session.id }, live: true, persisted: true })),
        readTitleSnapshots: async ids => {
            hydratedIds = [...ids];
            batches.push([...ids]);
            return new Promise(resolve => { resolveTitles = resolve; });
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldMenuStart = DbusMenuService.prototype.start;
    const oldEnqueue = NavigationBroker.prototype.enqueue;
    const intents = [];
    NavigationBroker.prototype.enqueue = function(intent, key) { intents.push(intent); return oldEnqueue.call(this, intent, key); };
    DbusMenuService.prototype.start = async function(bus) { menuCallbacks = this.cb; return oldMenuStart.call(this, bus); };
    TrayService.prototype.notifyWatcher = async function() { };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        const newNode = menuCallbacks.getRoot().find(node => node.data === "new");
        assert.equal(newNode?.enabled, true);
        menuCallbacks.onEvent(newNode.id, "clicked", undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(hydratedIds, firstBatchIds);
        fixture.emit("agent/status", { agent: { id: "idle-8" }, status: "idle" });
        fixture.emit("session/event", { id: "idle-8" }, { type: "session/title", seq: 1, time: Date.now(), data: { title: "" } });
        resolveTitles(hydratedIds.map(sessionId => ({ sessionId, status: "fulfilled", value: { title: { title: `Named ${sessionId}` } } })));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(intents, [{ type: "session", sessionId: "idle-8" }]);
        assert.deepEqual(fixture.authUrls, ["http://127.0.0.1:3080?token=test"]);
        assert.deepEqual(openerCalls.map(call => call.url), fixture.authUrls);
        removed = true;
        fixture.emit("session/disposed", { id: "idle-8" });
        await new Promise(resolve => setTimeout(resolve, 10));
        fixture.emit("session/created", { id: "idle-8" });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(batches, [firstBatchIds]);
    } finally {
        await fixture.dispose();
        DbusMenuService.prototype.start = oldMenuStart;
        NavigationBroker.prototype.enqueue = oldEnqueue;
        TrayService.prototype.notifyWatcher = oldNotify;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("failed demanded title batches do not retry-spin", async () => {
    let titleCalls = 0;
    const fixture = hostFixture({
        liveSessions: [{ id: "failed", header: { id: "failed" } }],
        listSessions: async () => [{ header: { id: "failed" }, live: true, persisted: true }],
        readTitleSnapshots: async ids => {
            titleCalls += 1;
            return ids.map(sessionId => ({ sessionId, status: "rejected", reason: "boom" }));
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    TrayService.prototype.notifyWatcher = async function() { };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await new Promise(resolve => setTimeout(resolve, 5));
        fixture.emit("agent/status", { agent: { id: "failed" }, status: "running" });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(titleCalls, 1);
    } finally {
        await fixture.dispose();
        TrayService.prototype.notifyWatcher = oldNotify;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("disposing during startup hydration aborts and prevents title reads", async () => {
    let signal;
    let resolveList;
    let titleCalls = 0;
    const fixture = hostFixture({
        listSessions: incomingSignal => {
            signal = incomingSignal;
            return new Promise(resolve => { resolveList = resolve; });
        },
        readTitleSnapshots: async () => { titleCalls += 1; return []; },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    TrayService.prototype.notifyWatcher = async function() { };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await new Promise(resolve => setTimeout(resolve, 5));
        await fixture.dispose();
        assert.equal(signal.aborted, true);
        resolveList?.([{ header: { id: "late" }, live: false, persisted: true }]);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(titleCalls, 0);
    } finally {
        resolveList?.([]);
        TrayService.prototype.notifyWatcher = oldNotify;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("session disposal lookup does not mutate tracker after root disposal", async () => {
    let resolveDisposeLookup;
    let listCalls = 0;
    let removeCalls = 0;
    let trackerDisposeCalls = 0;
    const fixture = hostFixture({
        liveSessions: [{ id: "disposed", header: { id: "disposed" } }],
        listSessions: async () => {
            listCalls += 1;
            if (listCalls === 1) return [{ header: { id: "disposed" }, live: true, persisted: true }];
            return new Promise(resolve => { resolveDisposeLookup = resolve; });
        },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldRemove = SessionStateTracker.prototype.remove;
    const oldDispose = SessionStateTracker.prototype.dispose;
    TrayService.prototype.notifyWatcher = async function() { };
    SessionStateTracker.prototype.remove = function(...args) { removeCalls += 1; return oldRemove.apply(this, args); };
    SessionStateTracker.prototype.dispose = function(...args) { trackerDisposeCalls += 1; return oldDispose.apply(this, args); };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await new Promise(resolve => setTimeout(resolve, 10));
        fixture.emit("session/disposed", { id: "disposed" });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof resolveDisposeLookup, "function");
        await fixture.dispose();
        resolveDisposeLookup([]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(removeCalls, 0);
        assert.equal(trackerDisposeCalls, 0);
    } finally {
        resolveDisposeLookup?.([]);
        TrayService.prototype.notifyWatcher = oldNotify;
        SessionStateTracker.prototype.remove = oldRemove;
        SessionStateTracker.prototype.dispose = oldDispose;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("subagent origin is excluded while originless user forks restore live attention", async () => {
    const turnStart = (seq, time) => ({ type: "turn/start", seq, time, data: {} });
    const pendingCall = (seq, time, callId) => ({ type: "tool/call", seq, time, data: { callId, name: "ask_user_question" } });
    const errorEnd = (seq, time) => ({ type: "turn/end", seq, time, data: { reason: { kind: "error" } } });
    const pendingInput = {
        id: "pending",
        header: { id: "pending" },
        events: [turnStart(0, 100), pendingCall(1, 101, "pending-call")],
    };
    const forkInput = {
        id: "fork",
        header: { id: "fork", parentSession: "parent", isSeeded: true },
        inheritedEventCount: 1,
        events: [turnStart(0, 90), turnStart(1, 110), pendingCall(2, 111, "fork-call")],
    };
    const errorInput = {
        id: "error",
        header: { id: "error" },
        events: [turnStart(0, 80), errorEnd(1, 81)],
    };
    const subInput = {
        id: "sub",
        header: { id: "sub", origin: "subagent" },
        events: [turnStart(0, 70), errorEnd(1, 71)],
    };
    const fixture = hostFixture({
        liveSessions: [pendingInput, forkInput, errorInput, subInput],
        runningSessions: ["pending", "fork"],
        sessionRecords: [
            { header: pendingInput.header, live: true, persisted: true },
            { header: forkInput.header, live: true, persisted: true },
            { header: errorInput.header, live: true, persisted: true },
            { header: subInput.header, live: true, persisted: true },
        ],
        readTitleSnapshots: async ids => {
            return ids.map(sessionId => ({ sessionId, status: "fulfilled", value: { session: { id: sessionId }, title: { title: sessionId } } }));
        },
    });
    const subSession = makeLiveSession(subInput);
    const titleCalls = [];
    const oldReadTitles = fixture.ctx.sessionQuery.readTitleSnapshots;
    fixture.ctx.sessionQuery.readTitleSnapshots = async ids => {
        titleCalls.push([...ids]);
        return oldReadTitles(ids);
    };
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    const oldNotify = TrayService.prototype.notifyWatcher;
    const oldRefresh = TrayService.prototype.refresh;
    const oldMenuStart = DbusMenuService.prototype.start;
    const oldEnqueue = NavigationBroker.prototype.enqueue;
    const snapshots = [];
    const intents = [];
    let menuCallbacks;
    TrayService.prototype.notifyWatcher = async function() { };
    TrayService.prototype.refresh = function() { snapshots.push(this.snapshotNow()); return oldRefresh.call(this); };
    DbusMenuService.prototype.start = async function(bus) { menuCallbacks = this.cb; return oldMenuStart.call(this, bus); };
    NavigationBroker.prototype.enqueue = function(intent, key) { intents.push(intent); return oldEnqueue.call(this, intent, key); };
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => fixture.bus;
    try {
        await apply(fixture.ctx, { iconSize: 22, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" });
        await new Promise(resolve => setTimeout(resolve, 10));
        const root = menuCallbacks.getRoot();
        const data = root.map(node => node.data);
        assert.ok(data.includes("pending"));
        assert.ok(data.includes("fork"));
        assert.ok(data.includes("error"));
        assert.equal(data.includes("sub"), false);
        assert.equal(titleCalls.flat().includes("sub"), false);
        assert.match(snapshots.at(-1).tooltipBody, /错误停止/);
        const errorNode = root.find(node => node.data === "error");
        menuCallbacks.onEvent(errorNode.id, "clicked", undefined);
        assert.deepEqual(intents, [{ type: "session", sessionId: "error" }]);
        const titleCallCount = titleCalls.length;
        fixture.emit("session/created", subSession);
        fixture.emit("session/event", subSession, errorEnd(1, Date.now()));
        fixture.emit("session/disposed", subSession);
        fixture.emit("agent/status", { agent: { id: "sub", session: subSession }, status: "running" });
        fixture.emit("agent/error", { agent: { id: "sub", session: subSession } });
        fixture.emit("agent/status", { agent: { id: "phantom" }, status: "running" });
        fixture.emit("agent/error", { agent: { id: "phantom" } });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(titleCalls.length, titleCallCount);
        assert.equal(fixture.viewedWrites.some(args => JSON.stringify(args).includes("sub")), false);
        assert.equal(menuCallbacks.getRoot().some(node => node.data === "sub"), false);
    } finally {
        await fixture.dispose();
        TrayService.prototype.notifyWatcher = oldNotify;
        TrayService.prototype.refresh = oldRefresh;
        DbusMenuService.prototype.start = oldMenuStart;
        NavigationBroker.prototype.enqueue = oldEnqueue;
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("Host stream activation failure rolls back before registering HTTP or DBus", async () => {
    const fixture = hostFixture();
    const warnings = [];
    fixture.ctx.logger.warn = (...args) => warnings.push(args);
    fixture.ctx.plugin = () => ({
        async await() { throw new Error("stream startup failed"); },
        async dispose() { fixture.events.push("navigation-dispose"); },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => assert.fail("DBus must not start after stream activation failure");
    try {
        await apply(fixture.ctx, {});
        assert.equal(fixture.events.includes("rpc-register"), false);
        assert.ok(fixture.events.includes("navigation-dispose"));
        assert.ok(fixture.events.includes("store-close"));
        assert.ok(warnings.some(args => args.includes("stream startup failed")));
    } finally {
        await fixture.dispose();
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});

test("Host disposal during stream activation cannot register late RPC or DBus resources", async () => {
    const fixture = hostFixture();
    let release;
    let entered;
    const activation = new Promise(resolve => { entered = resolve; });
    fixture.ctx.plugin = () => ({
        async await() { entered(); await new Promise(resolve => { release = resolve; }); },
        async dispose() { fixture.events.push("navigation-dispose"); },
    });
    const oldAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldSessionBus = dbus.sessionBus;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/dsh-tray-test";
    dbus.sessionBus = () => assert.fail("DBus must not start after disposal");
    let applying;
    try {
        applying = apply(fixture.ctx, {});
        await activation;
        await fixture.dispose();
        release();
        await applying;
        assert.equal(fixture.events.includes("rpc-register"), false);
        assert.ok(fixture.events.includes("store-close"));
    } finally {
        release?.();
        await applying;
        await fixture.dispose();
        dbus.sessionBus = oldSessionBus;
        if (oldAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = oldAddress;
    }
});
