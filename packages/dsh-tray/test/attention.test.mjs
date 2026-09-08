import test from "node:test";
import assert from "node:assert/strict";
import { SessionStateTracker } from "../lib/state.js";
import { NavigationBroker } from "../lib/navigation.js";

const presence = { clientId: "tab", focused: true, visible: true, currentSessionId: "done" };
const completed = time => ({ type: "turn/end", reasonKind: "completed", seq: 1, time });
const viewed = () => ({ lastViewedAt: () => undefined, markViewed() {} });

async function navigationActivity(broker) {
    const abort = new AbortController();
    const waiting = broker.next("tab", abort.signal);
    abort.abort();
    await waiting;
}

test("unread completion beats another running session without changing state codes", () => {
    const tracker = new SessionStateTracker(viewed());
    tracker.applyEvent("done", completed(1000));
    tracker.applyStatus("running", true);
    assert.equal(tracker.focus().icon, "green");
    assert.equal(tracker.focus().level, 1);
    assert.equal(tracker.focus().session.id, "done");
    assert.deepEqual(tracker.listMenu().map(state => state.id), ["done", "running"]);
    tracker.applyEvent("running", { type: "approval/asked", approvalId: "approval", seq: 1, time: 2000 });
    assert.equal(tracker.focus().icon, "yellow");
    tracker.applyEvent("error", { type: "turn/end", reasonKind: "error", seq: 1, time: 3000 });
    assert.equal(tracker.focus().icon, "red");
});

test("navigation activity preserves transport liveness but cannot renew viewing evidence", async () => {
    let now = 1000;
    const broker = new NavigationBroker({ now: () => now });
    try {
        broker.register(presence);
        now = 26000;
        await navigationActivity(broker);
        now = 46000;
        assert.equal(broker.isWatching("done"), true);
        now++;
        assert.equal(broker.clientsSnapshot().length, 1);
        assert.equal(broker.isWatching("done"), false);
        broker.register(presence);
        assert.equal(broker.isWatching("done"), true);
        broker.register({ ...presence, focused: false });
        assert.equal(broker.isWatching("done"), false);
        broker.register({ ...presence, currentSessionId: "other" });
        assert.equal(broker.isWatching("done"), false);
        assert.equal(broker.isWatching("other"), true);
    } finally { broker.dispose(); }
});

test("expired focus cannot auto-read completion even while navigation remains connected", async () => {
    let now = 1000;
    let writes = 0;
    const broker = new NavigationBroker({ now: () => now });
    const tracker = new SessionStateTracker({ lastViewedAt: () => undefined, markViewed() { writes++; } }, id => broker.isWatching(id));
    try {
        broker.register(presence);
        now = 26000;
        await navigationActivity(broker);
        now = 46001;
        tracker.applyEvent("done", completed(now));
        assert.equal(writes, 0);
        assert.equal(tracker.focus().icon, "green");
        broker.register(presence);
        tracker.applyEvent("done", completed(++now));
        assert.equal(writes, 1);
        assert.equal(tracker.focus().level, 0);
    } finally { broker.dispose(); }
});
