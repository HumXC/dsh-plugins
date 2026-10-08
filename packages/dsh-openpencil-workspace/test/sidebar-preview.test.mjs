import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { create, act } from "react-test-renderer";
import { Context } from "@deepseek-ai/cordis";
import { captureSidebarCollapse, createSidebarPreview, registerSidebarPreview } from "../lib/sidebar-preview.js";
import { openDocument } from "../lib/chat-navigation.js";
import { Workspace } from "../lib/workspace.js";
import { getBridge } from "../lib/contracts.js";
const flush = () => new Promise(resolve => setImmediate(resolve));
const props = path => ({ scope: { sessionId: "session-a" }, path });
const text = tree => JSON.stringify(tree.toJSON());
function runtime() {
  getBridge().runtime = { key: (grant, session) => session + grant.sourcePath, successor: () => false, preserve: async () => "clean" };
}

test("optional viewer attaches when service arrives, unregisters on replacement and disposal", async () => {
  const ctx = new Context(), registered = [], removed = [];
  const release = registerSidebarPreview(ctx, new Workspace());
  await flush(); assert.equal(registered.length, 0);
  const service = label => ({ registerFileViewer(descriptor) { registered.push([label, descriptor]); return () => removed.push(label); } });
  const removeFirst = ctx.provide("betterSidebar", service("first")); await flush(); await flush();
  assert.equal(registered.length, 1);
  const descriptor = registered[0][1];
  assert.deepEqual(descriptor.exts, ["op"]); assert.equal(descriptor.fetchStrategy, "none"); assert.equal(descriptor.priority, 100);
  await removeFirst(); await flush();
  assert.deepEqual(removed, ["first"]);
  const removeSecond = ctx.provide("betterSidebar", service("second")); await flush(); await flush();
  assert.equal(registered.length, 2);
  await release(); assert.deepEqual(removed, ["first", "second"]);
  await removeSecond();
});

test("viewer hides intermediate content and collapses only after a successful open or retry", async () => {
  let fail = true, collapsed = 0, sessionId = "session-a"; const calls = [];
  const store = { getSnapshot: () => ({ sessionId }), update: mutate => { const state = { bottomOpen: true }; mutate(state); assert.equal(state.bottomOpen, false); collapsed++; } };
  const withStore = path => ({ ...props(path), store });
  const Preview = createSidebarPreview(async (session, path, signal) => {
    calls.push({ session, path, signal }); if (fail) throw new Error("请先保存当前画布");
  });
  let tree;
  await act(async () => { tree = create(createElement(Preview, withStore("/work/a.op"))); });
  assert.match(text(tree), /请先保存当前画布/); assert.match(text(tree), /重试/); assert.equal(collapsed, 0);
  fail = false;
  await act(async () => { tree.root.findByType("button").props.onClick(); });
  assert.equal(tree.toJSON(), null); assert.equal(collapsed, 1); assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true);
  await act(async () => { tree.update(createElement(Preview, withStore("/work/a.op"))); });
  assert.equal(calls.length, 2); assert.equal(collapsed, 1);
  sessionId = "session-b";
  await act(async () => { tree.update(createElement(Preview, { scope: { sessionId }, path: "/work/b.op", store })); });
  assert.equal(calls.at(-1).session, "session-b"); assert.equal(calls.at(-1).path, "/work/b.op"); assert.equal(collapsed, 2);
  await act(async () => { tree.unmount(); }); assert.equal(calls.at(-1).signal.aborted, true);
});

test("in-place file switch cancels the old request and ignores its late failure", async () => {
  const calls = [];
  const Preview = createSidebarPreview((session, path, signal) => new Promise((resolve, reject) => calls.push({ path, signal, resolve, reject })));
  let tree;
  await act(async () => { tree = create(createElement(Preview, props("/work/old.op"))); });
  await act(async () => { tree.update(createElement(Preview, props("/work/new.op"))); });
  assert.equal(calls[0].signal.aborted, true);
  await act(async () => { calls[1].resolve(); calls[0].reject(new Error("stale error")); });
  assert.equal(tree.toJSON(), null); assert.doesNotMatch(text(tree), /stale error/);
  await act(async () => { tree.unmount(); });
});

test("openDocument forwards session and cancellation, rejects stale responses and server errors", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls = [], controller = new AbortController();
  const workspace = new Workspace();
  workspace.open = async (...args) => { calls.push(args); return true; };
  globalThis.fetch = async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { sessionId: "s", path: "/work/file.op" });
    assert.equal(options.signal, controller.signal);
    return { ok: true, json: async () => { controller.abort(); return { grant: { sourcePath: "/work/file.op" } }; } };
  };
  await assert.rejects(openDocument(workspace, "s", "/work/file.op", controller.signal), { name: "AbortError" });
  assert.equal(calls.length, 0);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: "文件访问被拒绝" }) });
  await assert.rejects(openDocument(workspace, "s", "/work/file.op"), /文件访问被拒绝/);
  assert.equal(calls.length, 0);
  const valid = new AbortController();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ grant: { sourcePath: "/work/file.op" } }) });
  await openDocument(workspace, "s", "/work/file.op", valid.signal);
  assert.equal(calls[0][1], false); assert.equal(calls[0][2], valid.signal);
});

test("sidebar switching keeps dirty document when close is cancelled", async t => {
  runtime(); const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ grant: { sourcePath: "/work/new.op" } }) });
  const workspace = new Workspace(() => false), focused = [];
  workspace.navigators.set("s", (...args) => focused.push(args));
  await workspace.open({ sessionId: "s", grant: { sourcePath: "/work/original.op" } }, false);
  workspace.onController({ requestClose: async () => { throw new Error("must not close"); } });
  workspace.onState({ phase: "ready", dirty: true });
  await assert.rejects(openDocument(workspace, "s", "/work/new.op"), /保存或关闭/);
  assert.equal(workspace.getSnapshot().grant.sourcePath, "/work/original.op"); assert.equal(focused.length, 1);
});

test("aborted navigation during asynchronous close cannot reopen a stale file", async () => {
  runtime(); const workspace = new Workspace(), focused = [], controller = new AbortController();
  workspace.navigators.set("s", (...args) => focused.push(args));
  await workspace.open({ sessionId: "s", grant: { sourcePath: "/work/original.op" } }, false);
  let finishClose;
  workspace.onController({ requestClose: () => new Promise(resolve => { finishClose = resolve; }) });
  workspace.onState({ phase: "ready", dirty: false });
  const stale = workspace.open({ sessionId: "s", grant: { sourcePath: "/work/stale.op" } }, false, controller.signal);
  await flush(); controller.abort();
  const latest = workspace.open({ sessionId: "s", grant: { sourcePath: "/work/latest.op" } }, false);
  finishClose(true);
  assert.equal(await stale, false); assert.equal(await latest, true);
  assert.equal(workspace.getSnapshot().grant.sourcePath, "/work/latest.op");
  assert.deepEqual(focused.map(args => args[1]), ["/work/original.op", "/work/latest.op"]);
});

function nativeSurface() {
  let sessionId = "session-a", expanded = true, tab = { id: "file-tab", contentId: "file-a" }, toggles = 0;
  const remaining = [{ id: "readme-tab", contentId: "readme" }], closed = [];
  const sidebar = { mounted: { getSnapshot: () => sessionId }, active: () => tab, isExpanded: () => expanded,
    close: () => { throw new Error("must close through Better Sidebar to release its records"); },
    toggleExpanded: () => { expanded = !expanded; toggles++; } };
  const betterSidebar = { closeTab(id, scope) { assert.equal(scope.sessionId, sessionId); closed.push(id); if (tab?.id === id) tab = remaining[0]; } };
  return { ctx: { get: name => name === "sidebarRight" ? sidebar : name === "betterSidebar" ? betterSidebar : undefined }, closed, remaining,
    get toggles() { return toggles; }, get expanded() { return expanded; },
    setSession: value => { sessionId = value; }, setTab: value => { tab = value; } };
}

test("successful redirect removes only its preview tab and collapses the native column", async () => {
  const surface = nativeSurface(); let finishOpen;
  const collapseAgain = captureSidebarCollapse({ ...props("/work/a.op"), ctx: surface.ctx });
  const Preview = createSidebarPreview(() => new Promise(resolve => { finishOpen = resolve; }));
  let tree;
  await act(async () => { tree = create(createElement(Preview, { ...props("/work/a.op"), ctx: surface.ctx })); });
  assert.equal(tree.toJSON(), null); assert.equal(surface.expanded, true); assert.deepEqual(surface.closed, []);
  await act(async () => { finishOpen(); });
  assert.equal(surface.expanded, false); assert.equal(surface.toggles, 1); assert.equal(tree.toJSON(), null);
  assert.deepEqual(surface.closed, ["file-tab"]); assert.deepEqual(surface.remaining.map(tab => tab.id), ["readme-tab"]);
  collapseAgain();
  assert.equal(surface.toggles, 1); assert.deepEqual(surface.closed, ["file-tab"]);
  await act(async () => { tree.unmount(); });
});

test("late successful opens cannot collapse another session or newly selected sidebar tab", async () => {
  for (const change of [s => s.setSession("session-b"), s => s.setTab({ id: "another-tab", contentId: "file-b" }), s => s.setTab({ id: "file-tab", contentId: "file-b" })]) {
    const surface = nativeSurface(); let finishOpen;
    const Preview = createSidebarPreview(() => new Promise(resolve => { finishOpen = resolve; }));
    let tree;
    await act(async () => { tree = create(createElement(Preview, { ...props("/work/a.op"), ctx: surface.ctx })); });
    change(surface);
    await act(async () => { finishOpen(); });
    assert.equal(surface.expanded, true); assert.equal(surface.toggles, 0); assert.deepEqual(surface.closed, []);
    await act(async () => { tree.unmount(); });
  }
});

test("unmounting before a successful response leaves sidebar open", async () => {
  const surface = nativeSurface(); let finishOpen;
  const Preview = createSidebarPreview(() => new Promise(resolve => { finishOpen = resolve; }));
  let tree;
  await act(async () => { tree = create(createElement(Preview, { ...props("/work/a.op"), ctx: surface.ctx })); });
  await act(async () => { tree.unmount(); });
  await act(async () => { finishOpen(); });
  assert.equal(surface.expanded, true); assert.equal(surface.toggles, 0); assert.deepEqual(surface.closed, []);
});

test("legacy workbench collapse is scoped to its original session", () => {
  let updates = 0;
  const store = { getSnapshot: () => ({ sessionId: "session-b" }), update: () => { updates++; } };
  captureSidebarCollapse({ ...props("/work/a.op"), store })();
  assert.equal(updates, 0);
});

test("failed native open preserves the preview tab and its retry button", async () => {
  const surface = nativeSurface();
  const Preview = createSidebarPreview(async () => { throw new Error("已取消画布切换"); });
  let tree;
  await act(async () => { tree = create(createElement(Preview, { ...props("/work/a.op"), ctx: surface.ctx })); });
  assert.match(text(tree), /已取消画布切换/); assert.match(text(tree), /重试/);
  assert.deepEqual(surface.closed, []); assert.equal(surface.expanded, true);
  await act(async () => { tree.unmount(); });
});

test("legacy workbench closes the exact redirected tab and retains other files", () => {
  const leaf = { kind: "leaf", id: "pane", active: "op", tabs: [{ id: "op", path: "/work/a.op" }, { id: "notes", path: "/work/notes.md" }] };
  const state = { activePane: "pane", bottomSplits: { kind: "split", children: [leaf] }, bottomOpen: true }, closed = [];
  const store = { getSnapshot: () => ({ sessionId: "session-a", state }), update: fn => fn(state) };
  const ctx = { get: name => name === "betterSidebar" ? { closeTab(id) { closed.push(id); leaf.tabs = leaf.tabs.filter(tab => tab.id !== id); leaf.active = "notes"; } } : undefined };
  captureSidebarCollapse({ ...props("/work/a.op"), ctx, store })();
  assert.deepEqual(closed, ["op"]); assert.deepEqual(leaf.tabs.map(tab => tab.id), ["notes"]); assert.equal(state.bottomOpen, false);
});
