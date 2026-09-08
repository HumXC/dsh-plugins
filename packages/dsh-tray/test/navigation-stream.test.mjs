import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { NavigationBroker } from "../lib/navigation.js";
import { TrayNavigationService } from "../lib/navigation-service.js";
import { TYPERT } from "../lib/typert.host.js";
import { TYPERT_REMOTE } from "../lib/typert.remote-client.js";

const presence = clientId => ({ clientId, focused: true, visible: true, currentSessionId: null });

async function fixture(t, options = {}) {
    const ctx = new Context();
    const registry = new TypertRegistry(ctx);
    const unregister = registry.register(TYPERT);
    const broker = new NavigationBroker(options);
    t.after(async () => { broker.dispose(); await unregister(); await ctx.fiber.dispose(); });
    await ctx.plugin(TrayNavigationService, broker).await();
    await ctx.plugin(TypertGatewayService, {}).await();
    const gateway = ctx.typertGateway;
    return { broker, async open(clientId, signal) {
        const stream = await gateway.stream({ namespace: "trayNavigation", method: "watch", args: { request: presence(clientId) }, signal });
        return stream[Symbol.asyncIterator]();
    }, gateway };
}

test("generated contract selects the cancellable Gateway stream, not unary RPC", () => {
    assert.equal(TYPERT_REMOTE.descriptors.length, 1);
    const descriptor = TYPERT_REMOTE.descriptors[0];
    assert.equal(descriptor.namespace, "trayNavigation");
    assert.equal(descriptor.method, "watch");
    assert.equal(descriptor.mode, "stream");
    assert.deepEqual(descriptor.cancellation, { parameter: "signal" });
    assert.equal(descriptor.result.schema.safeParse({ type: "ready" }).success, true);
    assert.equal(descriptor.result.schema.safeParse({ type: "intent", intent: { type: "session" } }).success, false);
});

test("actual Host registry and Gateway stream deliver once and propagate cancellation", async t => {
    const h = await fixture(t);
    const abort = new AbortController();
    t.after(() => abort.abort());
    const stream = await h.open("gateway-tab", abort.signal);
    assert.deepEqual((await stream.next()).value, { type: "ready" });
    const delivery = stream.next();
    h.broker.enqueue({ type: "session", sessionId: "session-1" }, "stream-intent");
    assert.deepEqual((await delivery).value, { type: "intent", intent: { intentId: "stream-intent", type: "session", sessionId: "session-1" } });
    const waiting = stream.next();
    abort.abort();
    await assert.rejects(waiting, error => error.code === "gateway/cancelled");
    const reconnect = new AbortController();
    t.after(() => reconnect.abort());
    const next = await h.open("gateway-tab", reconnect.signal);
    assert.deepEqual((await next.next()).value, { type: "ready" });
    const noReplay = next.next();
    h.broker.enqueue({ type: "session", sessionId: "session-2" }, "stream-next");
    assert.equal((await noReplay).value.intent.intentId, "stream-next");
    reconnect.abort();
    await next.return();
});

test("many tab streams consume one intent only once without HTTP navigation requests", async t => {
    const h = await fixture(t);
    const aborts = Array.from({ length: 12 }, () => new AbortController());
    t.after(() => aborts.forEach(abort => abort.abort()));
    const streams = await Promise.all(aborts.map((abort, i) => h.open(`tab-${i}`, abort.signal)));
    await Promise.all(streams.map(async stream => assert.deepEqual((await stream.next()).value, { type: "ready" })));
    const results = streams.map(stream => stream.next().catch(error => ({ error })));
    h.broker.enqueue({ type: "session", sessionId: "shared-session" }, "only-once");
    const first = await Promise.race(results);
    assert.equal(first.value.intent.intentId, "only-once");
    aborts.forEach(abort => abort.abort());
    const settled = await Promise.all(results);
    assert.equal(settled.filter(result => result.value?.type === "intent").length, 1);
    await Promise.all(streams.map(stream => stream.return()));
});

test("page close removes presence immediately without a disconnect RPC", async t => {
    const launches = [];
    const h = await fixture(t, { launch: intent => launches.push(intent.intentId) });
    const abort = new AbortController();
    t.after(() => abort.abort());
    const stream = await h.open("closing-tab", abort.signal);
    await stream.next();
    // Simulate socket close while the generator is suspended at its ready yield.
    abort.abort();
    assert.equal(h.broker.clientsSnapshot().length, 0);
    h.broker.enqueue({ type: "session", sessionId: "completed" }, "after-close");
    assert.deepEqual(launches, ["after-close"]);
    await stream.return();
});

test("late teardown of an old stream does not disconnect its replacement", async t => {
    const h = await fixture(t);
    const oldAbort = new AbortController();
    const newAbort = new AbortController();
    t.after(() => { oldAbort.abort(); newAbort.abort(); });
    const oldStream = await h.open("reconnecting-tab", oldAbort.signal);
    await oldStream.next();
    const newStream = await h.open("reconnecting-tab", newAbort.signal);
    await newStream.next();
    oldAbort.abort();
    await oldStream.return();
    assert.equal(h.broker.clientsSnapshot().length, 1);
    const delivery = newStream.next();
    h.broker.enqueue({ type: "session", sessionId: "completed" }, "replacement");
    assert.equal((await delivery).value.intent.intentId, "replacement");
    newAbort.abort();
    assert.equal(h.broker.clientsSnapshot().length, 0);
    await newStream.return();
});

test("normal stream return releases presence without a disconnect RPC", async t => {
    const h = await fixture(t);
    const abort = new AbortController();
    t.after(() => abort.abort());
    const stream = await h.open("returning-tab", abort.signal);
    await stream.next();
    await stream.return();
    assert.equal(h.broker.clientsSnapshot().length, 0);
});

test("Gateway rejects malformed presence before registering a browser", async t => {
    const { gateway } = await fixture(t);
    await assert.rejects(gateway.stream({ namespace: "trayNavigation", method: "watch", args: { request: { clientId: 42 } } }), error => error.code === "gateway/input-invalid");
});
