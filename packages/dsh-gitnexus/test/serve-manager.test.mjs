import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../lib/config.js";
import { GitNexusServeManager } from "../lib/serve-manager.js";
function fixture(t, { version = "1.6.10", external = false, timeout = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-serve-"));
  const previous = globalThis.fetch, spawns = [];
  let terminated = false, settle;
  const done = new Promise(resolve => { settle = resolve; });
  const ctx = { subprocess: { spawn(spec) {
    spawns.push(spec);
    return { done, collected: { stderr: { readFrom: () => ({ text: "address unavailable" }) } },
      terminate() { terminated = true; settle({ exitCode: null, signal: "SIGTERM" }); },
      waitForExit: async () => { await done; return true; } };
  } } };
  globalThis.fetch = async () => {
    if (timeout || (!external && spawns.length === 0)) throw new Error("connection refused");
    return new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json" } });
  };
  const manager = new GitNexusServeManager(ctx, resolveConfig({ serveStartupTimeoutMs: timeout ? 20 : 1000 }), root);
  t.after(async () => { await manager.dispose(); globalThis.fetch = previous; rmSync(root, { recursive: true, force: true }); });
  return { manager, root, spawns, terminated: () => terminated };
}
test("refuses compatible but unscoped external GitNexus servers", async t => {
  const f = fixture(t, { external: true });
  await assert.rejects(f.manager.ensureStarted(), /unscoped external/);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.terminated(), false);
});
test("owned serve uses workspace cwd and local registry environment", async t => {
  const f = fixture(t);
  await f.manager.ensureStarted(); await f.manager.ensureStarted();
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].cwd, f.root);
  assert.equal(f.spawns[0].env.GITNEXUS_HOME, join(f.root, ".gitnexus", "runtime"));
  assert.equal(f.spawns[0].env.GITNEXUS_MCP_ALLOWED_REPOS, undefined);
  await f.manager.dispose(); assert.equal(f.terminated(), true);
});
test("fails closed for incompatible servers", async t => {
  const f = fixture(t, { external: true, version: "1.7.0" });
  await assert.rejects(f.manager.ensureStarted(), /unsupported/);
  assert.equal(f.spawns.length, 0);
});
test("terminates owned process on startup timeout", async t => {
  const f = fixture(t, { timeout: true });
  await assert.rejects(f.manager.ensureStarted(), /address unavailable/);
  assert.equal(f.terminated(), true);
});
