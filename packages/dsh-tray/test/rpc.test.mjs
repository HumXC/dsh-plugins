import test from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS, isPresenceUpdate, isNavigationAck, validateEndpoint } from "../lib/rpc.js";

test("RPC validators reject malformed and unknown fields", () => {
    const good = { clientId: "tab-1", focused: true, visible: true, currentSessionId: null };
    assert.equal(isPresenceUpdate(good), true);
    assert.equal(isPresenceUpdate({ ...good, extra: true }), false);
    assert.equal(validateEndpoint(ENDPOINTS.presenceUpdate, good), true);
    assert.equal(validateEndpoint("unknown", good), false);
});

test("ack validator enforces outcome shape and bounded failure message", () => {
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "success", sessionId: "s" }), true);
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "success" }), false);
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "failure", message: "no" }), true);
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "failure" }), false);
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "failure", sessionId: "s" }), false);
    assert.equal(isNavigationAck({ clientId: "tab", intentId: "intent", outcome: "failure", message: "x".repeat(513) }), false);
});
