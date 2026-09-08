import test from "node:test";
import assert from "node:assert/strict";
import { NavigationBroker } from "../lib/navigation.js";

const presence = (clientId, focused = false, visible = true) => ({ clientId, focused, visible, currentSessionId: null });

test("broker delivers one queued intent to one ranked waiter", async () => {
    const broker = new NavigationBroker({ waitTimeoutMs: 50 });
    assert.equal(broker.register(presence("hidden")).ok, true);
    assert.equal(broker.register(presence("focused", true)).ok, true);
    const hidden = broker.next("hidden");
    const focused = broker.next("focused");
    broker.enqueue({ type: "session", sessionId: "session-1" }, "intent-1");
    assert.equal((await focused).value.intent.sessionId, "session-1");
    const idle = await hidden;
    assert.equal(idle.value.kind, "idle");
});

test("new focused waiter joins ranking before pending intent dispatch", async () => {
    const broker = new NavigationBroker({ waitTimeoutMs: 50 });
    broker.enqueue({ type: "session", sessionId: "ranked-session" }, "ranked-intent");
    broker.register(presence("background"));
    const dispatch = broker.dispatch;
    broker.dispatch = () => { };
    const background = broker.next("background");
    broker.dispatch = () => { };
    broker.register(presence("focused", true));
    broker.dispatch = dispatch;
    const focused = broker.next("focused");
    assert.equal((await focused).value.intent.sessionId, "ranked-session");
    assert.equal((await background).value.kind, "idle");
    broker.dispose();
});
test("broker supports cancellation, at-most-once ack, and disposal", async () => {
    const broker = new NavigationBroker({ waitTimeoutMs: 1000 });
    broker.register(presence("tab"));
    const abort = new AbortController();
    const wait = broker.next("tab", abort.signal); abort.abort();
    assert.equal((await wait).ok, false);
    const wait2 = broker.next("tab");
    broker.enqueue({ type: "session", sessionId: "session-2" }, "intent-2");
    const delivered = await wait2;
    assert.equal(broker.ack({ clientId: "tab", intentId: "intent-2", outcome: "success", sessionId: "session-2" }).ok, true);
    assert.equal(broker.ack({ clientId: "tab", intentId: "intent-2", outcome: "success", sessionId: "session-2" }).ok, false);
    const waiting = broker.next("tab"); broker.dispose();
    assert.equal((await waiting).error.code, "tray/disposed");
    assert.equal(delivered.value.kind, "intent");
});

test("broker handles 1/2/5/10 clients without broadcast fan-out", async () => {
    for (const count of [1, 2, 5, 10]) {
        const broker = new NavigationBroker({ waitTimeoutMs: 100 });
        for (let i = 0; i < count; i += 1) broker.register(presence(`tab-${i}`, i === 0));
        const waits = Array.from({ length: count }, (_, i) => broker.next(`tab-${i}`));
        broker.enqueue({ type: "new-session", workspaceId: "workspace", sessionId: "session-preallocated" }, `intent-${count}`);
        const results = await Promise.all(waits);
        assert.equal(results.filter(r => r.ok && r.value.kind === "intent").length, 1);
        assert.equal(results.filter(r => r.ok && r.value.kind === "idle").length, count - 1);
    }
});

test("pending intent retries authenticated launch after eligible client disappears", async () => {
    const launches = [];
    const broker = new NavigationBroker({ launchCooldownMs: 10, launch: intent => launches.push(intent.intentId) });
    broker.enqueue({ type: "session", sessionId: "s1" }, "first");
    broker.register(presence("tab", true));
    broker.enqueue({ type: "session", sessionId: "s2" }, "second");
    broker.disconnect("tab");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(launches, ["first", "second"]);
    broker.dispose();
});
