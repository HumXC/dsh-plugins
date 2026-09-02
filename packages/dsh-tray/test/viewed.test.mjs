import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ViewedStore } = require("../lib/viewed.js");

function fakeUnit(seed = {}) {
  const tables = structuredClone(seed);
  const calls = [];
  return {
    tables,
    calls,
    async loadAll() {
      calls.push("loadAll");
      return { tables, global: undefined };
    },
    async putRecord(table, key, value) {
      calls.push(["putRecord", table, key, value]);
      tables[table] ??= {};
      tables[table][key] = value;
    },
    async close() {},
  };
}

test("markViewed → lastViewedAt;open 重载持久化 round-trip", async () => {
  const unit = fakeUnit();
  const store = await ViewedStore.open(unit);
  assert.equal(store.lastViewedAt("s1"), undefined);
  store.markViewed("s1", 12345);
  assert.equal(store.lastViewedAt("s1"), 12345);
  await new Promise((res) => setImmediate(res)); // 等待异步落盘
  assert.equal(unit.tables.viewed.s1.at, 12345);

  const store2 = await ViewedStore.open(fakeUnit(unit.tables));
  assert.equal(store2.lastViewedAt("s1"), 12345);
});

test("损坏账本容忍:loadAll 抛错 → 空账本,不阻塞", async () => {
  const bad = {
    async loadAll() { throw new Error("db corrupt"); },
    async putRecord() {},
    async close() {},
  };
  const store = await ViewedStore.open(bad);
  assert.equal(store.snapshot().size, 0);
});
