import test from "node:test";
import assert from "node:assert/strict";
let clientModulePromise;
async function clientModule() {
    if (!clientModulePromise) clientModulePromise = import("../lib/client-internal.js");
    return clientModulePromise;
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function harness({ intents = [], create = async () => "session-created", open = () => { }, phase = "ready" } = {}) {
    const events = [];
    const acks = [];
    const opens = [];
    const creates = [];
    const runtimeListeners = new Map();
    const documentListeners = new Map();
    const subscriptions = new Set();
    const next = [...intents];
    let current = "current-session";
    const sessions = {
        list: {
            getSnapshot: () => ({ phase, current }),
            subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
        },
        open(id) { opens.push(id); return open(id); },
        async create(options) { creates.push(options); return create(options); },
    };
    const connection = {
        rpc: {
            async call(_channel, endpoint, payload, signal) {
                events.push({ endpoint, payload });
                if (endpoint === "presence/update") return { ok: true, value: { accepted: true } };
                if (endpoint === "navigation/ack") { acks.push(payload); return { ok: true, value: { accepted: true } }; }
                if (endpoint === "presence/disconnect") return { ok: true, value: { removed: true } };
                throw new Error(`Unexpected HTTP RPC: ${endpoint}`);
            },
        },
    };
    const remote = {
        trayNavigation: {
            async *watch(payload, signal) {
                events.push({ endpoint: "stream/watch", payload });
                yield { type: "ready" };
                for (const intent of next) {
                    if (signal.aborted) return;
                    yield { type: "intent", intent };
                }
                if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
            },
        },
        $stream(options) {
            const abort = new AbortController();
            return {
                async *[Symbol.asyncIterator]() {
                    for await (const value of options.open(abort.signal)) {
                        yield { value, generation: 1, signal: abort.signal, accept() {} };
                    }
                },
                async dispose() { abort.abort(); },
            };
        },
    };
    const runtime = {
        streamEnded: () => new Error("stream ended"),
        document: {
            visibilityState: "visible",
            hasFocus: () => true,
            addEventListener: (event, listener) => documentListeners.set(event, listener),
            removeEventListener: event => documentListeners.delete(event),
        },
        addEventListener: (event, listener) => runtimeListeners.set(event, listener),
        removeEventListener: event => runtimeListeners.delete(event),
    };
    return { sessions, connection, remote, runtime, events, acks, opens, creates, runtimeListeners, documentListeners, subscriptions, setCurrent(id) { current = id; for (const listener of subscriptions) listener(); } };
}

async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for client execution");
        await new Promise(resolve => setImmediate(resolve));
    }
}

function sessionIntent(intentId = "intent-session") {
    return { intentId, type: "session", sessionId: "session-1" };
}
function newSessionIntent(intentId = "intent-new") {
    return { intentId, type: "new-session", workspaceId: "workspace-1", sessionId: "session-preallocated" };
}

async function start(h) {
    const { createClientController } = await clientModule();
    return createClientController({ sessions: h.sessions, connection: h.connection, remote: h.remote }, h.runtime);
}

test("opens an existing session and acknowledges success", async () => {
    const h = harness({ intents: [sessionIntent()] });
    const controller = await start(h);
    await waitFor(() => h.acks.length === 1);
    assert.deepEqual(h.opens, ["session-1"]);
    assert.deepEqual(h.acks[0], { clientId: h.acks[0].clientId, intentId: "intent-session", outcome: "success", sessionId: "session-1" });
    await controller.dispose();
});
test("updates presence when current session changes and stops after disposal", async () => {
    const h = harness();
    const controller = await start(h);
    await waitFor(() => h.events.some(event => event.endpoint === "presence/update" && event.payload.currentSessionId === "current-session"));
    h.setCurrent("next-session");
    await waitFor(() => h.events.some(event => event.endpoint === "presence/update" && event.payload.currentSessionId === "next-session"));
    const updates = h.events.filter(event => event.endpoint === "presence/update").length;
    await controller.dispose();
    h.setCurrent("after-disposal");
    h.runtimeListeners.get("focus")?.();
    h.documentListeners.get("visibilitychange")?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.events.filter(event => event.endpoint === "presence/update").length, updates);
});


test("creates with the exact preallocated session id before opening", async () => {
    const h = harness({ intents: [newSessionIntent()], create: async options => { assert.equal(options.sessionId, "session-preallocated"); return options.sessionId; } });
    const controller = await start(h);
    await waitFor(() => h.acks.length === 1);
    assert.deepEqual(h.creates, [{ workspaceId: "workspace-1", sessionId: "session-preallocated" }]);
    assert.deepEqual(h.opens, ["session-preallocated"]);
    assert.equal(h.acks[0].outcome, "success");
    await controller.dispose();
});

test("fails and replays a returned-id mismatch", async () => {
    const intent = newSessionIntent("intent-mismatch");
    const h = harness({ intents: [intent, intent], create: async () => "different-id" });
    const controller = await start(h);
    await waitFor(() => h.acks.length === 2);
    assert.equal(h.acks[0].outcome, "failure");
    assert.match(h.acks[0].message, /different preallocated id/);
    assert.deepEqual(h.acks[1], h.acks[0]);
    assert.deepEqual(h.opens, []);
    await controller.dispose();
});

test("acknowledges open failures", async () => {
    const h = harness({ intents: [sessionIntent("intent-failure")], open: () => { throw new Error("open failed"); } });
    const controller = await start(h);
    await waitFor(() => h.acks.length === 1);
    assert.deepEqual({ ...h.acks[0], clientId: "client" }, { clientId: "client", intentId: "intent-failure", outcome: "failure", message: "open failed" });
    await controller.dispose();
});

test("replays completed successes without reopening", async () => {
    const intent = sessionIntent("intent-duplicate");
    const h = harness({ intents: [intent, intent] });
    const controller = await start(h);
    await waitFor(() => h.acks.length === 2);
    assert.equal(h.opens.length, 1);
    assert.deepEqual(h.acks[1], h.acks[0]);
    await controller.dispose();
});

test("does not acknowledge or open after disposal during create", async () => {
    const pending = deferred();
    const h = harness({ intents: [newSessionIntent("intent-dispose-create")], create: () => pending.promise });
    const controller = await start(h);
    await waitFor(() => h.creates.length === 1);
    const disposePromise = controller.dispose();
    pending.resolve("session-preallocated");
    await disposePromise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.acks, []);
    assert.deepEqual(h.opens, []);
});

test("does not acknowledge after disposal during open or react after disposal", async () => {
    let controller;
    const h = harness({ intents: [sessionIntent("intent-dispose-open")], open: () => { void controller.dispose(); } });
    controller = await start(h);
    await waitFor(() => h.opens.length === 1);
    await controller.dispose();
    const updates = h.events.filter(event => event.endpoint === "presence/update").length;
    h.runtimeListeners.get("focus")?.();
    h.documentListeners.get("visibilitychange")?.();
    for (const listener of h.subscriptions) listener();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.acks, []);
    assert.equal(h.events.filter(event => event.endpoint === "presence/update").length, updates);
});

test("ignores unchanged presence notifications but reports a real focus change", async () => {
    const h = harness();
    const controller = await start(h);
    try {
        await waitFor(() => h.events.some(event => event.endpoint === "presence/update"));
        const before = h.events.filter(event => event.endpoint === "presence/update").length;
        for (let i = 0; i < 100; i++) {
            for (const listener of h.subscriptions) listener();
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(h.events.filter(event => event.endpoint === "presence/update").length, before);
        h.runtime.document.hasFocus = () => false;
        h.runtimeListeners.get("blur")({ type: "blur" });
        await waitFor(() => h.events.filter(event => event.endpoint === "presence/update").length === before + 1);
        assert.equal(h.events.at(-1).payload.focused, false);
    } finally {
        await controller.dispose();
    }
});

test("unchanged presence still renews its heartbeat", async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness();
    const controller = await start(h);
    try {
        await waitFor(() => h.events.some(event => event.endpoint === "presence/update"));
        const before = h.events.filter(event => event.endpoint === "presence/update").length;
        t.mock.timers.tick(20_000);
        await waitFor(() => h.events.filter(event => event.endpoint === "presence/update").length === before + 1);
    } finally {
        await controller.dispose();
    }
});
