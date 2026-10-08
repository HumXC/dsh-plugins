import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../lib/workspace.js";
import { getBridge, isOpPath } from "../lib/contracts.js";
const request = (path, extras = {}) => ({ sessionId: "session-a", grant: { sourcePath: path, ...extras } });
const controller = (close = async () => true) => ({ requestClose: close, awaitExistingSave: async () => false, captureRecovery: async () => true, retainServerSessionOnUnmount() {} });
beforeEach(() => { getBridge().runtime = { key: (g,s) => s + g.sourcePath, successor: (a,b) => a.sessionId === b.sessionId && a.grant.liveDraft && b.grant.liveDraft === false && a.grant.draftId === b.grant.draftId, preserve: async (state, c) => state.dirty ? (await c.captureRecovery() ? "recovered" : "unrecovered") : "clean" }; });
test("background opening preserves Chat; explicit opening activates the top tab", async () => {
  const workspace = new Workspace(), navigations = [];
  workspace.navigators.set("session-a", (...args) => navigations.push(args));
  assert.equal(await workspace.open(request("a.op"), true), true); assert.deepEqual(navigations, []);
  assert.equal(await workspace.open(request("a.op"), false), true);
  assert.deepEqual(navigations, [["openpencil", "a.op"]]); assert.equal(workspace.getSnapshot().automatic, false);
});
test("automatic requests cannot replace another document or another session", async () => {
  const workspace = new Workspace(); await workspace.open(request("a.op"), false); workspace.onController(controller());
  assert.equal(await workspace.open(request("b.op"), true), false);
  assert.equal(await workspace.open({ ...request("a.op"), sessionId: "session-b" }, true), false);
  assert.equal(workspace.getSnapshot().grant.sourcePath, "a.op");
});
test("failed close keeps current editor and queues replacements", async () => {
  const workspace = new Workspace(); await workspace.open(request("a.op"), false);
  let closes = 0; workspace.onController(controller(async () => { closes++; return false; }));
  assert.deepEqual(await Promise.all([workspace.open(request("b.op"), false), workspace.open(request("c.op"), false)]), [false,false]);
  assert.equal(closes, 2); assert.equal(workspace.getSnapshot().grant.sourcePath, "a.op");
});
test("published successor closes the live attachment before replacement", async () => {
  const workspace = new Workspace(); await workspace.open(request("live.op", {liveDraft:true,draftId:"draft"}), true);
  let closed = false; workspace.onController(controller(async () => { closed = true; return true; }));
  assert.equal(await workspace.open(request("published.op", {liveDraft:false,draftId:"draft"}), true), true);
  assert.equal(closed, true); assert.equal(workspace.getSnapshot().grant.sourcePath, "published.op");
});
test("HMR recovery preserves unsaved data and permits a later runtime", async () => {
  const workspace = new Workspace(); await workspace.open(request("a.op"), false);
  let recoveries = 0; workspace.onController({...controller(),captureRecovery:async()=>{recoveries++;return true;}});
  workspace.onState({phase:"ready",dirty:true}); await workspace.release();
  assert.equal(recoveries, 1); assert.equal(workspace.getSnapshot(), undefined);
  assert.equal(await workspace.open(request("b.op"), false), true);
  await workspace.dispose(); assert.equal(await workspace.open(request("c.op"), false), false);
});
test(".op routing accepts local paths and leaves URLs and other files alone", () => {
  for (const path of ["design.op", "/tmp/设计稿.OP"]) assert.equal(isOpPath(path), true);
  for (const path of ["https://example.com/design.op", "file:///tmp/a.op", "a.op.txt", "a.op\0"]) assert.equal(isOpPath(path), false);
});
