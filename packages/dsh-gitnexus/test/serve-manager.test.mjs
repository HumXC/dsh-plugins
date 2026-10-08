import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../lib/config.js";
import { GitNexusServeManager } from "../lib/serve-manager.js";
function fixture(t, { version = "1.6.10", servePort = 4747, timeout = false, spawnError = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-serve-"));
  const previous = globalThis.fetch, spawns = [], requests = [];
  let terminated = false, settle;
  const done = new Promise(resolve => { settle = resolve; });
  const ctx = { subprocess: { spawn(spec) {
    spawns.push(spec);
    const owners = readdirSync(join(root, ".gitnexus/backends"));
    assert.equal(owners.length, 1, "ownership must be published before spawn");
    const owner = JSON.parse(readFileSync(join(root, ".gitnexus/backends", owners[0]), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.token, "string");
    if (spawnError) throw new Error("spawn failed");
    return { done, collected: { stderr: { readFrom: () => ({ text: "address unavailable" }) } },
      terminate() { terminated = true; settle({ exitCode: null, signal: "SIGTERM" }); },
      waitForExit: async () => { await done; return true; } };
  } } };
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (timeout || spawns.length === 0) throw new Error("connection refused");
    return new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json" } });
  };
  const manager = new GitNexusServeManager(ctx, resolveConfig({ servePort, serveStartupTimeoutMs: timeout ? 20 : 1000 }), root);
  t.after(async () => { await manager.dispose(); globalThis.fetch = previous; rmSync(root, { recursive: true, force: true }); });
  return { manager, root, spawns, requests, terminated: () => terminated };
}
test("occupied preferred port starts an isolated owned backend without touching the listener", async t => {
  const external = createServer();
  await new Promise((resolve, reject) => {
    external.once("error", reject);
    external.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => external.close(resolve)));
  const port = external.address().port;
  let connections = 0;
  external.on("connection", socket => { connections++; socket.destroy(); });
  const f = fixture(t, { servePort: port });
  await f.manager.ensureStarted();
  const selectedPort = Number(f.spawns[0].argv.at(-1));
  assert.notEqual(selectedPort, port);
  assert.equal(f.manager.origin, `http://127.0.0.1:${selectedPort}`);
  assert.ok(f.requests.every(({ url }) => url.startsWith(f.manager.origin)));
  assert.equal(connections, 0);
  assert.equal(external.listening, true);
  const response = await f.manager.request("/api/cancel", {
    method: "DELETE", headers: { origin: `http://127.0.0.1:${port}` },
  });
  await response.text();
  assert.equal(new Headers(f.requests.at(-1).init.headers).get("origin"), f.manager.origin);
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
test("fails closed and terminates an incompatible owned server", async t => {
  const f = fixture(t, { version: "1.7.0" });
  await assert.rejects(f.manager.ensureStarted(), /unsupported/);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.terminated(), true);
});
test("terminates owned process on startup timeout", async t => {
  const f = fixture(t, { timeout: true });
  await assert.rejects(f.manager.ensureStarted(), /address unavailable/);
  assert.equal(f.terminated(), true);
});

test("transient health failure never replaces a live owned backend", async t => {
  const f = fixture(t);
  await f.manager.ensureStarted();
  const healthy = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("temporary probe failure"); };
  await assert.rejects(f.manager.ensureStarted(), /refusing to replace a live backend/);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.terminated(), false);
  globalThis.fetch = healthy;
  await f.manager.ensureStarted();
  assert.equal(f.spawns.length, 1);
});

test("ownership publication failure cannot start an unregistered backend", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".gitnexus"));
  writeFileSync(join(f.root, ".gitnexus/backends"), "not a directory");
  await assert.rejects(f.manager.ensureStarted(), /EEXIST|ENOTDIR/);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.terminated(), false);
});

test("spawn failure removes preregistration because no backend started", async t => {
  const f = fixture(t, { spawnError: true });
  await assert.rejects(f.manager.ensureStarted(), /spawn failed/);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(readdirSync(join(f.root, ".gitnexus/backends")), []);
});

test("an available configured port remains preferred", async t => {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const f = fixture(t, { servePort: port });
  await f.manager.ensureStarted();
  assert.equal(Number(f.spawns[0].argv.at(-1)), port);
  assert.equal(f.manager.origin, `http://127.0.0.1:${port}`);
});

test("a successful probe cannot adopt a server after the owned process exits", async t => {
  const f = fixture(t);
  const healthy = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await healthy(...args);
    await f.manager.dispose();
    return response;
  };
  await assert.rejects(f.manager.ensureStarted(), /did not become ready/);
  assert.equal(f.terminated(), true);
});
