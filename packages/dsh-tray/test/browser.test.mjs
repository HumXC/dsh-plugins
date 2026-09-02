import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveBaseUrl, sessionUrl, workspaceNewSessionUrl } = require("../lib/browser.js");
const { JumpRouter } = require("../lib/jump.js");

test("resolveBaseUrl 优先级:config > env > 127.0.0.1:port", () => {
  const old = process.env.DSH_WEB_URL;
  delete process.env.DSH_WEB_URL;
  assert.equal(resolveBaseUrl({ port: 1234 }), "http://127.0.0.1:1234");
  process.env.DSH_WEB_URL = "http://env-host:9/";
  assert.equal(resolveBaseUrl({ port: 1 }), "http://env-host:9", "env 优先于 port 派生");
  assert.equal(
    resolveBaseUrl({ port: 1, webBaseUrl: "http://cfg-host:7" }),
    "http://cfg-host:7",
    "config 优先于 env",
  );
  if (old === undefined) delete process.env.DSH_WEB_URL;
  else process.env.DSH_WEB_URL = old;
});

test("深链参数带 tray- 前缀", () => {
  assert.equal(sessionUrl("http://b", "s-1"), "http://b/?tray-session=s-1");
  assert.equal(
    workspaceNewSessionUrl("http://b", "w-2"),
    "http://b/?tray-workspace=w-2&tray-new=1",
  );
});

test("JumpRouter:页面开着广播,否则 open 新开(深链)", async () => {
  let broadcasted = null;
  let opened = null;
  const channel = {
    open: false,
    broadcast: (p) => { broadcasted = p; },
  };
  const router = new JumpRouter(channel, { baseUrl: "http://b", open: async (u) => { opened = u; } });
  router.route({ type: "session", sessionId: "s1" });
  await sleep(10);
  assert.equal(opened, "http://b/?tray-session=s1");
  assert.equal(broadcasted, null);

  channel.open = true;
  router.route({ type: "new-session", workspaceId: "w2" });
  await sleep(10);
  assert.deepEqual(broadcasted, { type: "navigate", workspaceId: "w2", newSession: true });
  assert.equal(opened, "http://b/?tray-session=s1", "广播时不新开");
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
