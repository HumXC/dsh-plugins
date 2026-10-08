import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LastDocument, LAST_DOCUMENT_KEY } from "../lib/last-document.js";
import { Workspace } from "../lib/workspace.js";
import { getBridge } from "../lib/contracts.js";
import { openDocument } from "../lib/chat-navigation.js";
const originalFetch = globalThis.fetch;
const request = (path, sessionId = "a", extras = {}) => ({ sessionId, grant: { sourcePath: path, ...extras } });
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };
const response = (grant, code) => ({ ok: !!grant, json: async () => grant ? { grant } : { code, error: "unavailable" } });
const signal = () => new AbortController().signal;
const closeController = { requestClose: async () => true };
beforeEach(() => { getBridge().runtime = { key: (g, s) => s + g.sourcePath, successor: () => false }; });
afterEach(() => { globalThis.fetch = originalFetch; });

test("only ready file opens persist, across instances and isolated by session", async () => {
  const store = storage(), history = new LastDocument(() => store);
  const workspace = new Workspace(undefined, value => history.remember(value));
  await workspace.open(request("/design/菜单.op"), false);
  assert.equal(history.get("a"), undefined);
  workspace.onState({ phase: "error", dirty: false });
  assert.equal(history.get("a"), undefined);
  workspace.onState({ phase: "ready", dirty: false });
  const reloaded = new LastDocument(() => store);
  assert.equal(reloaded.get("a"), "/design/菜单.op"); assert.equal(reloaded.get("b"), undefined);
  history.remember(request("/private/draft.op", "a", { liveDraft: true, draftId: "private" }));
  history.remember({ sessionId: "a", grant: { draftId: "no-file" } });
  assert.equal(reloaded.get("a"), "/design/菜单.op");
  assert.deepEqual(JSON.parse(store.getItem(LAST_DOCUMENT_KEY + "a")), { path: "/design/菜单.op" });
});

test("an empty fresh workspace restores once through the existing grant route without focusing Chat", async () => {
  const store = storage(); new LastDocument(() => store).remember(request("/design/a.op"));
  const history = new LastDocument(() => store), workspace = new Workspace(), navigations = [];
  workspace.navigators.set("a", (...args) => navigations.push(args));
  let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(url, "/_dsh/openpencil-workspace/open"); assert.deepEqual(JSON.parse(options.body), { sessionId: "a", path: "/design/a.op" }); return response({ sourcePath: "/design/a.op", editor: "fresh capability" }); };
  await history.restore(workspace, "a", signal());
  assert.equal(workspace.getSnapshot().grant.sourcePath, "/design/a.op"); assert.deepEqual(navigations, []);
  workspace.onController(closeController); await workspace.close();
  await history.restore(workspace, "a", signal());
  assert.equal(workspace.getSnapshot(), undefined); assert.equal(calls, 1);
});

test("deleted file removes only its stale record; permission and network failures retain it", async () => {
  for (const code of ["FILE_NOT_FOUND", "DENIED", "network"]) {
    const store = storage(), history = new LastDocument(() => store), workspace = new Workspace();
    history.remember(request("/design/a.op")); history.remember(request("/design/b.op", "b"));
    let calls = 0; globalThis.fetch = async () => { calls++; if (code === "network") throw new Error("offline"); return response(undefined, code); };
    await history.restore(workspace, "a", signal()); await history.restore(workspace, "a", signal());
    assert.equal(workspace.getSnapshot(), undefined); assert.equal(calls, 1);
    assert.equal(history.get("a"), code === "FILE_NOT_FOUND" ? undefined : "/design/a.op"); assert.equal(history.get("b"), "/design/b.op");
  }
});

test("existing editors, manual opens and explicit closes win over delayed restore", async () => {
  for (const action of ["existing", "manual", "closed", "other-session", "dispose"]) {
    const store = storage(), history = new LastDocument(() => store), workspace = new Workspace();
    history.remember(request("/design/old.op"));
    let resolve, calls = 0; globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
    if (action === "existing") await workspace.open(request("/design/new.op"), false);
    const restoring = history.restore(workspace, "a", signal());
    if (action === "existing") { await restoring; assert.equal(calls, 0); continue; }
    if (action === "manual" || action === "other-session") await workspace.open(request("/design/new.op", action === "manual" ? "a" : "b"), false);
    if (action === "closed") await workspace.close();
    if (action === "dispose") await workspace.dispose();
    resolve(response({ sourcePath: "/design/old.op" })); await restoring;
    assert.equal(workspace.getSnapshot()?.grant.sourcePath, action === "manual" || action === "other-session" ? "/design/new.op" : undefined);
  }
});

test("manual HTTP navigation wins before its new file grant has arrived", async () => {
  const store = storage(), history = new LastDocument(() => store), workspace = new Workspace();
  history.remember(request("/design/old.op"));
  const pending = new Map();
  globalThis.fetch = (_url, options) => new Promise(done => pending.set(JSON.parse(options.body).path, done));
  const restoring = history.restore(workspace, "a", signal());
  const manual = openDocument(workspace, "a", "/design/new.op");
  pending.get("/design/old.op")(response({ sourcePath: "/design/old.op" }));
  await restoring; assert.equal(workspace.getSnapshot(), undefined);
  pending.get("/design/new.op")(response({ sourcePath: "/design/new.op" }));
  await manual; assert.equal(workspace.getSnapshot().grant.sourcePath, "/design/new.op");
});

test("unmounted restore can retry; stale aborted response cannot override the new attempt", async () => {
  const store = storage(), history = new LastDocument(() => store), workspace = new Workspace(); history.remember(request("/design/a.op"));
  const pending = []; globalThis.fetch = () => new Promise(done => pending.push(done));
  const old = new AbortController(), restoring = history.restore(workspace, "a", old.signal); old.abort();
  const retry = history.restore(workspace, "a", signal()); assert.equal(pending.length, 2);
  pending[0](response({ sourcePath: "/stale.op" })); await restoring; assert.equal(workspace.getSnapshot(), undefined);
  pending[1](response({ sourcePath: "/design/a.op" })); await retry; assert.equal(workspace.getSnapshot().grant.sourcePath, "/design/a.op");
});

test("a stale missing response does not clear a more recently recorded path", async () => {
  const store = storage(), history = new LastDocument(() => store), workspace = new Workspace(); history.remember(request("/design/old.op"));
  let resolve; globalThis.fetch = () => new Promise(done => { resolve = done; });
  const restoring = history.restore(workspace, "a", signal()); history.remember(request("/design/new.op"));
  resolve(response(undefined, "FILE_NOT_FOUND")); await restoring; assert.equal(history.get("a"), "/design/new.op");
});

test("malformed or unavailable storage never blocks manual opening", async () => {
  const store = storage();
  for (const value of ["{", "null", JSON.stringify({ path: "https://example.com/a.op" }), JSON.stringify({ path: "a.txt" })]) { store.setItem(LAST_DOCUMENT_KEY + "a", value); assert.equal(new LastDocument(() => store).get("a"), undefined); }
  const history = new LastDocument(() => { throw new Error("storage disabled"); }), workspace = new Workspace(undefined, value => history.remember(value));
  assert.equal(history.get("a"), undefined); await history.restore(workspace, "a", signal());
  assert.equal(await workspace.open(request("/design/a.op"), false), true); workspace.onState({ phase: "ready", dirty: false });
  assert.equal(workspace.getSnapshot().grant.sourcePath, "/design/a.op");
});
