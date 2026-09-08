import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as cordis from "@deepseek-ai/cordis";

const require = createRequire(import.meta.url);
const gatewaySource = await readFile(require.resolve("@deepseek-ai/dsh-api-gateway/client"), "utf8");
const traySource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

function load(source, dependencies) {
    let result;
    runInNewContext(source, { AbortController, AbortSignal, setTimeout, clearTimeout, console,
        window: { __ModuleLoader__: { load({ factory }) {
            result = factory(id => {
                assert.ok(Object.hasOwn(dependencies, id), `unexpected browser external: ${id}`);
                return dependencies[id];
            });
        } } },
    });
    return result;
}
const gateway = load(gatewaySource, { "@deepseek-ai/cordis": cordis });

test("published browser bundle loads with Gateway only and keeps codecs bundled", () => {
    const tray = load(traySource, { "@deepseek-ai/dsh-api-gateway/client": gateway });
    assert.deepEqual(Object.keys(tray).sort(), ["apply", "inject", "name"]);
    assert.ok(tray.inject.includes("remote"));
    assert.equal(tray.inject.includes("remote.trayNavigation"), false, "entry must mount its own namespace before requiring it");
});

test("client disposal during Remote mount unmounts exactly once without starting navigation", async () => {
    const tray = load(traySource, { "@deepseek-ai/dsh-api-gateway/client": gateway });
    let release;
    let dispose;
    let unmounts = 0;
    const mounting = new Promise(resolve => { release = resolve; });
    const applying = tray.apply({
        effect(execute) { dispose = execute(); return dispose; },
        remote: { $mount() { return mounting; }, $stream() { assert.fail("navigation must not start after disposal"); } },
    });
    await dispose();
    release(async () => { unmounts++; });
    await applying;
    await dispose();
    assert.equal(unmounts, 1);
});

test("official browser RemoteStream reconnects a failed carrier and cancels its pending read", async () => {
    let opens = 0;
    const signals = [];
    const stream = new gateway.RemoteStream({ generation: { getSnapshot: () => ({}) } }, {
        name: "tray-test",
        async *open(signal) {
            signals.push(signal);
            const generation = ++opens;
            yield { type: "ready" };
            if (generation === 1) throw new gateway.RemoteStreamCarrierError("isolated carrier failure");
            if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        },
        ended: () => new gateway.RemoteStreamCarrierError("ended"),
    });
    try {
        const reader = stream[Symbol.asyncIterator]();
        const first = (await reader.next()).value;
        first.accept();
        const second = (await reader.next()).value;
        second.accept();
        assert.equal(first.generation, 1);
        assert.equal(second.generation, 2);
        assert.equal(signals[0].aborted, true);
        const pending = reader.next();
        await stream.dispose();
        assert.equal((await pending).done, true);
        assert.equal(signals[1].aborted, true);
        assert.equal(opens, 2);
    } finally { await stream.dispose(); }
});

test("official browser RemoteStream surfaces terminal failures without a retry loop", async () => {
    let opens = 0;
    const stream = new gateway.RemoteStream({ generation: { getSnapshot: () => ({}) } }, {
        name: "tray-terminal-test",
        async *open() { opens++; throw new Error("invalid service"); },
        ended: () => new Error("unexpected end"),
    });
    try {
        await assert.rejects(stream[Symbol.asyncIterator]().next(), error => error.code === "gateway/internal");
        assert.equal(opens, 1);
    } finally { await stream.dispose(); }
});
