import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as cordis from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { NavigationBroker } from "../lib/navigation.js";
import { TrayNavigationService } from "../lib/navigation-service.js";
import { TYPERT } from "../lib/typert.host.js";

const require = createRequire(import.meta.url);
const gatewaySource = await readFile(require.resolve("@deepseek-ai/dsh-api-gateway/client"), "utf8");
const traySource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

async function until(check) {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("client bootstrap did not reach its expected state");
}

test("real Cordis and Gateway mount before navigation injection and clean up on reload", { timeout: 10000 }, async () => {
    const host = new cordis.Context();
    const client = new cordis.Context();
    const listeners = new Set();
    const subscriptions = new Set();
    const intervals = new Set();
    const errors = [];
    const opened = [];
    const launches = [];
    const broker = new NavigationBroker({ launch: intent => launches.push(intent.intentId) });
    const vm = {
        AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder,
        setInterval(...args) { const id = setInterval(...args); intervals.add(id); return id; },
        clearInterval(id) { intervals.delete(id); clearInterval(id); },
        console: { ...console, error: (...args) => errors.push(args) },
        document: {
            visibilityState: "visible", hasFocus: () => true,
            addEventListener: (_event, listener) => listeners.add(listener),
            removeEventListener: (_event, listener) => listeners.delete(listener),
        },
        addEventListener: (_event, listener) => listeners.add(listener),
        removeEventListener: (_event, listener) => listeners.delete(listener),
    };
    function load(source, dependencies) {
        let result;
        runInNewContext(source, { ...vm, window: { __ModuleLoader__: { load({ factory }) {
            result = factory(id => {
                assert.ok(Object.hasOwn(dependencies, id), id);
                return dependencies[id];
            });
        } } } });
        return result;
    }
    const gateway = load(gatewaySource, { "@deepseek-ai/cordis": cordis });
    const tray = load(traySource, { "@deepseek-ai/dsh-api-gateway/client": gateway });
    const sessions = {
        list: {
            getSnapshot: () => ({ phase: "ready", current: "old-session" }),
            subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
        },
        open(id) { opened.push(id); },
    };
    try {
        new TypertRegistry(host).register(TYPERT);
        new TypertRegistry(client);
        await host.plugin(TrayNavigationService, broker);
        await host.plugin(TypertGatewayService, {});
        const sessionProvider = { apply(ctx) { ctx.provide("sessions", sessions); } };
        let sessionFiber = client.plugin(sessionProvider);
        await sessionFiber;
        client.provide("connection", {
            generation: { getSnapshot: () => ({}) },
            registerGenerationSource: () => () => {},
            start: () => ({ stop() {} }),
            rpc: {
                async *open(channel, endpoint, payload, signal) {
                    assert.equal(channel, "/api");
                    assert.equal(endpoint, "trayNavigation/watch");
                    yield* await host.typertGateway.stream({ namespace: "trayNavigation", method: "watch", args: payload.args, signal });
                },
                async call(channel, endpoint, payload) {
                    assert.equal(channel, "/dsh-tray");
                    if (endpoint === "presence/update") return broker.register(payload);
                    if (endpoint === "presence/disconnect") return broker.disconnect(payload.clientId);
                    if (endpoint === "navigation/ack") return broker.ack(payload);
                    assert.fail(endpoint);
                },
            },
        });
        await client.plugin(gateway);
        // Exercise the complete boot scheduler, not tray.apply() on a plain object.
        for (let cycle = 0; cycle < 2; cycle++) {
            const fiber = client.plugin(tray);
            await until(() => broker.clientsSnapshot().some(c => c.waiter));
            await fiber;
            assert.equal(intervals.size, 1);
            const intentId = "navigate-" + cycle;
            assert.equal(broker.enqueue({ type: "session", sessionId: "done-" + cycle }, intentId).ok, true);
            await until(() => broker.get(intentId)?.state === "acknowledged");
            assert.equal(opened.at(-1), "done-" + cycle);
            assert.equal(launches.length, 0, "connected page must consume navigation without another launch");
            // Dependency loss must dispose the child controller, not leave its heartbeat alive.
            await sessionFiber.dispose();
            await until(() => intervals.size === 0 && broker.clientsSnapshot().length === 0);
            sessionFiber = client.plugin(sessionProvider);
            await sessionFiber;
            await until(() => broker.clientsSnapshot().some(c => c.waiter));
            await fiber.dispose();
            assert.equal(intervals.size, 0);
            assert.equal(listeners.size, 0);
            assert.equal(subscriptions.size, 0);
            assert.equal(broker.clientsSnapshot().length, 0);
            assert.equal(client.get("remote.trayNavigation"), undefined);
        }
        assert.equal(broker.enqueue({ type: "session", sessionId: "no-page" }, "launch").ok, true);
        assert.deepEqual(launches, ["launch"], "after page teardown a tray intent must launch the browser");
        assert.deepEqual(errors, []);
    } catch (error) {
        console.error("bootstrap diagnostics:", { errors, intervals: intervals.size, clients: broker.clientsSnapshot().map(c => ({ id: c.clientId, waiting: !!c.waiter })), subscriptions: subscriptions.size });
        throw error;
    } finally {
        await client.fiber.dispose();
        broker.dispose();
        await host.fiber.dispose();
        for (const id of intervals) clearInterval(id);
    }
});
