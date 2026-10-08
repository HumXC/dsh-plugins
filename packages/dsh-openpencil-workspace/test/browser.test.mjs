import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createElement, useEffect, act } from "react";
import { createRoot } from "react-dom/client";
import { apply } from "../lib/browser.js";
import { getBridge } from "../lib/contracts.js";
import { LAST_DOCUMENT_KEY } from "../lib/last-document.js";

test("compact toolbar, persistent iframe and last-file restoration survive page remounts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const window = new Window({ url: "http://127.0.0.1:3080" });
  for (const key of ["window", "document", "HTMLElement", "ResizeObserver", "Event"]) globalThis[key] = key === "window" ? window : window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 120, top: 64, width: 900, height: 650 });
  const views = [], entries = new Map(), disposers = [];
  let mounts = 0, unmounts = 0, closeCalls = 0, closeFailure = false, waitForClose = false, finishClose, lifecycleUpdate;
  const Editor = ({ grant, hideToolbar, workbenchActions, onLifecycleState, onLifecycleController }) => {
    useEffect(() => {
      mounts++; lifecycleUpdate = onLifecycleState; onLifecycleState({ phase: "ready", dirty: false });
      onLifecycleController({ requestClose: async () => {
        closeCalls++;
        if (closeFailure) return false;
        if (waitForClose) await new Promise(resolve => { finishClose = resolve; });
        return true;
      }});
      return () => { unmounts++; onLifecycleController(undefined); };
    }, []);
    assert.notEqual(hideToolbar, true);
    return createElement("section", null, createElement("div", { className: "dsh-openpencil-workspace-toolbar", "data-test-save-toolbar": true, style: {minHeight:48, padding:"8px 10px 8px 12px"} },
      createElement("strong", null, grant.sourcePath.split("/").at(-1)), createElement("button", {style:{minHeight:28,padding:"4px 8px",fontSize:12}}, "保存"), workbenchActions),
      createElement("iframe", { title: "test editor", src: "about:blank" }));
  };
  getBridge().runtime = { Editor, key: (g, s) => g.sourcePath + s, successor: () => false, preserve: async () => "clean", locale: x => x,
    options: { subscribeTheme: () => () => {}, getColorScheme: () => "dark", subscribeLocale: () => () => {}, getLocale: () => "zh-CN" } };
  const ctx = { inject: () => ({ dispose: async () => {} }), effect: fn => disposers.push(fn()), slots: { entries: name => entries.get(name) ?? [], subscribe: () => () => {}, inject: (name, fn) => fn(), register: (options, component) => { views.push(component); return () => {}; } } };
  window.localStorage.setItem("dsh-openpencil-workspace:documents:v1", "legacy file catalog");
  await act(async () => { apply(ctx); });
  assert.equal(window.localStorage.getItem("dsh-openpencil-workspace:documents:v1"), null);
  const View = views.at(-1), surface = window.document.createElement("main"); window.document.body.append(surface);
  const seatRoot = createRoot(surface), props = { sessionId: "s", completeViewRequest: () => {} };
  await act(async () => { seatRoot.render(createElement(View, props)); await getBridge().handler.open({ grant: { sourcePath: "/test/a.op" }, sessionId: "s" }, true); });
  const iframe = window.document.querySelector("iframe"), parent = iframe.parentNode, parking = window.document.querySelector("[data-openpencil-parking]");
  const button = label => [...window.document.querySelectorAll("button")].find(node => node.textContent === label);
  assert.equal(mounts, 1); assert.equal(parking.style.display, "flex");
  assert.equal(window.document.documentElement.style.marginRight, ""); assert.equal(window.document.querySelector("[data-openpencil-workbench-host]"), null);
  assert.equal(window.document.querySelector("strong").textContent, "a.op"); assert.ok(button("保存")); assert.ok(button("关闭"));
  assert.equal(window.document.querySelector("select"), null);
  assert.equal(button("全屏"), undefined);assert.equal(button("退出全屏"), undefined);
  const toolbar=window.document.querySelector(".dsh-openpencil-workspace-toolbar");
  assert.equal(window.getComputedStyle(toolbar).height,"36px");
  const saveStyle=window.getComputedStyle(button("保存")),closeStyle=window.getComputedStyle(button("关闭"));
  for(const property of ["height","minHeight","padding","borderRadius","fontSize","fontWeight","lineHeight","color","backgroundColor"]) assert.equal(saveStyle[property],closeStyle[property],property);
  assert.equal(saveStyle.height,"26px");
  await act(async () => { seatRoot.render(null); });
  assert.equal(parking.style.display, "none"); assert.equal(unmounts, 0);
  await act(async () => { seatRoot.render(createElement(View, { ...props, sessionId: "other" })); }); assert.equal(parking.style.display, "none");
  await act(async () => { seatRoot.render(createElement(View, props)); }); assert.equal(window.document.querySelector("iframe"), iframe); assert.equal(parking.style.display, "flex");
  await act(async () => { lifecycleUpdate({ phase: "saving", dirty: true }); });
  assert.equal(button("关闭").disabled, true);
  await act(async () => { button("关闭").click(); }); assert.equal(closeCalls, 0);
  await act(async () => { lifecycleUpdate({ phase: "ready", dirty: false }); });
  assert.equal(button("关闭").disabled, false);
  closeFailure = true;
  await act(async () => { button("关闭").click(); });
  assert.equal(closeCalls, 1); assert.equal(window.document.querySelector("iframe"), iframe);
  closeFailure = false; waitForClose = true;
  await act(async () => { button("关闭").click(); });
  assert.equal(button("正在关闭…").disabled, true); assert.equal(closeCalls, 2);
  await act(async () => { finishClose(); });
  assert.equal(window.document.querySelector("iframe"), null); assert.equal(parking.style.display, "none"); assert.equal(unmounts, 1);
  await act(async () => { await getBridge().handler.open({ grant: { sourcePath: "/test/a.op" }, sessionId: "s" }, false); });
  assert.equal(mounts, 2); assert.notEqual(window.document.querySelector("iframe"), iframe);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(LAST_DOCUMENT_KEY + "s")), { path: "/test/a.op" });
  await act(async () => { for (const dispose of disposers.reverse()) await dispose(); seatRoot.unmount(); });
  assert.equal(unmounts, 2); assert.equal(window.document.querySelector("[data-openpencil-parking]"), null);
  disposers.length = 0;
  let restoreCalls = 0;
  globalThis.fetch = async (_url, options) => {
    restoreCalls++; assert.deepEqual(JSON.parse(options.body), { sessionId: "s", path: "/test/a.op" });
    return { ok: true, json: async () => ({ grant: { sourcePath: "/test/a.op" } }) };
  };
  const runtime = getBridge().runtime; delete getBridge().runtime;
  await act(async () => { apply(ctx); });
  assert.equal(restoreCalls, 0);
  const ReloadedView = views.at(-1), reloadedRoot = createRoot(surface);
  await act(async () => { reloadedRoot.render(createElement(ReloadedView, props)); });
  assert.equal(restoreCalls, 0); assert.equal(window.document.querySelector("iframe"), null);
  await act(async () => { getBridge().runtime = runtime; window.dispatchEvent(new window.Event("dsh-openpencil-workspace:runtime")); });
  assert.equal(restoreCalls, 1); assert.equal(mounts, 3); assert.equal(window.document.querySelector("strong").textContent, "a.op");
  waitForClose = false;
  await act(async () => { button("关闭").click(); });
  await act(async () => { reloadedRoot.render(null); });
  await act(async () => { reloadedRoot.render(createElement(ReloadedView, props)); });
  assert.equal(restoreCalls, 1); assert.equal(window.document.querySelector("iframe"), null);
  await act(async () => { for (const dispose of disposers.reverse()) await dispose(); reloadedRoot.unmount(); });
  await window.happyDOM.close();
});
