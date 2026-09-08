import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as primitives from "./fixtures/client-primitives.mjs";

// Integration prerequisite matches access.test.mjs: installed DSH, or DSH_RUNTIME_ROOT.
// Exercise the real workspace SDK SlotRegistry with deployed Cordis and deployed
// shell-seeded SlotCore. No declaration ledger, registration, or effect mocks.
// Only the visual primitives are stubbed; these tests do not render components.
const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), ".npm-packages/lib/node_modules/@deepseek-ai/dsh");
const deployedRequire = createRequire(join(runtimeRoot, "package.json"));
const localRequire = createRequire(import.meta.url);
const cordis = await import(deployedRequire.resolve("@deepseek-ai/cordis"));

async function deployedSlotCore() {
  const frontend = dirname(deployedRequire.resolve("@deepseek-ai/dsh-web-frontend/package.json"));
  const dist = join(frontend, "dist");
  const html = await readFile(join(dist, "index.html"), "utf8");
  const asset = [...html.matchAll(/<script[^>]+src="([^"?]+)(?:[?][^"]*)?"/g)]
    .map(([, src]) => src).find(src => src.includes("/assets/index-") && src.endsWith(".js"));
  assert.ok(asset, "deployed HTML must identify its current shell entry");
  const source = await readFile(join(dist, asset.startsWith("/") ? asset.slice(1) : asset), "utf8");
  // Discover names from the real module export table, never hardcode minifier ids.
  const exports = [...source.matchAll(/(?:const|var) ([A-Za-z0-9_$]+)=Object[.]freeze[(]Object[.]defineProperty[(][{]__proto__:null,SlotCore:([A-Za-z0-9_$]+),SlotOwnershipError:([A-Za-z0-9_$]+),StaleAuthorizationError:([A-Za-z0-9_$]+),resolveSlotLabel:([A-Za-z0-9_$]+),standardHookPropName:([A-Za-z0-9_$]+)[}],Symbol[.]toStringTag,[{]value:"Module"[}][)][)]/g)];
  assert.equal(exports.length, 1, "expected one real SlotCore export section; update fixture if DSH packaging changes");
  const match = exports[0];
  const start = source.lastIndexOf("function " + match[6] + "(", match.index);
  const end = match.index + match[0].length;
  assert.ok(start >= 0 && end - start < 100_000, "SlotCore must remain a bounded standalone source section");
  const section = source.slice(start, end);
  assert.match(section, /subscribeDeclaration/);
  assert.match(section, /is not declared/);
  return runInNewContext(section + "; " + match[1], { queueMicrotask, console }, { timeout: 1000 });
}

const slotCore = await deployedSlotCore();
const runtimeClient = localRequire.resolve("@deepseek-ai/dsh-client-runtime/client");
const runtimeSource = await readFile(runtimeClient, "utf8");
let runtimeFactory;
runInNewContext(runtimeSource, { queueMicrotask, console, window: { __ModuleLoader__: { load(row) { runtimeFactory = row.factory; } } } });
assert.equal(typeof runtimeFactory, "function");
const { SlotRegistry } = runtimeFactory(id => {
  if (id === "@deepseek-ai/cordis") return cordis;
  if (id === "@deepseek-ai/dsh-client-ui-slots") return slotCore;
  throw new Error("unexpected runtime factory dependency: " + id);
});
assert.equal(typeof SlotRegistry, "function");
const pluginSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

async function fixture(t, webUi = true) {
  const styles = new Set();
  let fetchCount = 0;
  let plugin;
  const sandbox = {
    console, AbortController, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout,
    fetch() { fetchCount++; throw new Error("slot registration must never fetch"); },
    __DSH_GITNEXUS_CONFIG__: { webUi },
    document: {
      createElement() {
        const style = { dataset: {}, textContent: "", remove() { styles.delete(style); } };
        return style;
      },
      head: { appendChild(style) { styles.add(style); } },
    },
    window: { __ModuleLoader__: { load(row) {
      plugin = row.factory(id => {
        if (id === "react") return React;
        if (id === "react/jsx-runtime") return jsxRuntime;
        if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
        throw new Error("unexpected plugin factory dependency: " + id);
      });
    } } },
  };
  runInNewContext(pluginSource, sandbox);
  const root = new cordis.Context();
  const service = root.plugin(SlotRegistry);
  await service;
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose();
    await service.dispose();
  });
  function owner(children) {
    const fiber = root.plugin({ name: "slot-owner", inject: ["slots"], apply(ctx) {
      ctx.slots.register({ name: "root", children }, () => null);
    } });
    fibers.push(fiber);
    return fiber;
  }
  function load() {
    const fiber = root.plugin({ name: "dsh-gitnexus-under-test", inject: plugin.inject, apply: plugin.apply });
    fibers.push(fiber);
    return fiber;
  }
  return { root, owner, load, styles, fetchCount: () => fetchCount,
    views: () => root.slots.entriesOfSlot("conversation.view"),
    tools: () => root.slots.entriesOfSlot("tool.call.toolview"),
  };
}

const conversation = { "conversation.view": { kind: "list", scope: "session" } };
const allSlots = { ...conversation, "tool.call.toolview": { kind: "keyed", scope: "session" } };

test("real core negative control rejects the former eager registration", async t => {
  const f = await fixture(t);
  assert.throws(() => f.root.slots.register({ name: "conversation.view", id: "gitnexus" }, () => null),
    /slot "conversation[.]view" is not declared/);
});

test("plugin waits for late declaration, then survives owner collapse and redeclaration", async t => {
  const f = await fixture(t);
  const consumer = f.load();
  await consumer; // OLD lib/client.js must reject here with the production error.
  assert.equal(f.views().length, 0);
  assert.equal(f.fetchCount(), 0);
  assert.equal(f.styles.size, 1);
  const first = f.owner(allSlots);
  await first;
  assert.equal(f.views().length, 1);
  assert.equal(f.views()[0].options.id, "gitnexus");
  assert.equal(f.tools().length, 8);
  await first.dispose();
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 0);
  const second = f.owner(allSlots);
  await second;
  assert.equal(f.views().length, 1);
  assert.equal(f.tools().length, 8);
  await consumer.dispose();
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 0);
  assert.equal(f.styles.size, 0);
  assert.equal(f.fetchCount(), 0);
});

test("unloading a pending plugin prevents later declaration from resurrecting it", async t => {
  const f = await fixture(t);
  const consumer = f.load();
  await consumer;
  await consumer.dispose();
  assert.equal(f.styles.size, 0);
  await f.owner(allSlots);
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 0);
  assert.equal(f.fetchCount(), 0);
});

test("already-declared slots activate immediately and active unload removes contributions", async t => {
  const f = await fixture(t);
  const owner = f.owner(allSlots);
  await owner;
  const consumer = f.load();
  await consumer;
  assert.equal(f.views().length, 1);
  assert.equal(f.tools().length, 8);
  await consumer.dispose();
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 0);
  await owner.dispose();
  await f.owner(allSlots);
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 0);
  assert.equal(f.styles.size, 0);
});

test("disabled view still owns native tool rows and styles across declaration epochs", async t => {
  const f = await fixture(t, false);
  const consumer = f.load();
  await consumer;
  assert.equal(f.styles.size, 1);
  const owner = f.owner(allSlots);
  await owner;
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 8);
  await owner.dispose();
  assert.equal(f.tools().length, 0);
  await f.owner(allSlots);
  assert.equal(f.views().length, 0);
  assert.equal(f.tools().length, 8);
  await consumer.dispose();
  assert.equal(f.tools().length, 0);
  assert.equal(f.styles.size, 0);
  assert.equal(f.fetchCount(), 0);
});
