import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";
import * as primitives from "./fixtures/client-primitives.mjs";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
const require = createRequire(import.meta.url);
const { act, create } = /** @type {any} */ (require("react-test-renderer"));


function jsonValue(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function withBrowserPlugin(callback) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousConfig = globalThis.__DSH_GITNEXUS_CONFIG__;
  const html = renderIndexInjections("<html><head></head><body></body></html>", [
    { kind: "global", name: "__DSH_GITNEXUS_CONFIG__", value: { webUi: true } },
  ]);
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) runInThisContext(script);
  let apply;
  const styleNodes = [];
  const intervalCallbacks = new Set();
  globalThis.window = {
    location: { origin: "http://dsh.test" },
    __ModuleLoader__: {
      load(definition) {
        apply = definition.factory((id) => {
          if (id === "react") return React;
          if (id === "react/jsx-runtime") return jsxRuntime;
          if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
          return {};
        }).apply;
      },
    },
    setTimeout,
    clearTimeout,
    setInterval(callback) {
      intervalCallbacks.add(callback);
      return callback;
    },
    clearInterval(callback) {
      intervalCallbacks.delete(callback);
    },
  };
  globalThis.document = {
    createElement() {
      const node = {
        dataset: {},
        textContent: "",
        remove() {
          styleNodes.splice(styleNodes.indexOf(node), 1);
        },
      };
      styleNodes.push(node);
      return node;
    },
    head: { appendChild() { } },
  };
  try {
    await import("../lib/client.js?browser-test=" + Math.random());
    assert.equal(typeof apply, "function");
    return await callback(apply, styleNodes, () => {
      for (const callback of intervalCallbacks) callback();
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete globalThis.__DSH_GITNEXUS_CONFIG__;
    else globalThis.__DSH_GITNEXUS_CONFIG__ = previousConfig;
  }
}

function createContext() {
  let current = "session-current";
  let listener;
  let cleanup;
  const events = [];
  const toolRows = new Map();
  const toolEvents = [];
  const slotCleanups = [];
  let registeredView;
  const list = {
    getSnapshot: () => ({ current }),
    subscribe(callback) {
      listener = callback;
      return () => {
        if (listener === callback) listener = undefined;
      };
    },
  };
  const context = {
    sessions: { list },
    slots: {
      inject(name, callback) {
        assert.ok(["tool.call.toolview", "conversation.view"].includes(name));
        const result = callback();
        const disposers = typeof result === "function" ? [result] : [...result];
        let active = true;
        const dispose = () => {
          if (!active) return;
          active = false;
          for (const cleanup of disposers.reverse()) cleanup();
        };
        slotCleanups.push(dispose);
        return dispose;
      },
      register(_definition, component) {
        if (_definition.name === "tool.call.toolview") {
          assert.equal(toolRows.has(_definition.key), false);
          toolRows.set(_definition.key, component);
          toolEvents.push(["register", _definition.key]);
          return () => {
            toolRows.delete(_definition.key);
            toolEvents.push(["dispose", _definition.key]);
          };
        }
        events.push("register");
        registeredView = component;
        return () => {
          registeredView = undefined;
          events.push("dispose");
        };
      },
    },
    effect(effect) {
      cleanup = effect();
    },
  };
  return {
    context,
    events,
    toolRows,
    toolEvents,
    setCurrent(value) {
      current = value;
    },
    notify() {
      assert.equal(typeof listener, "function");
      listener();
    },
    cleanup() {
      cleanup?.();
      for (const dispose of slotCleanups) dispose();
    },
    isSubscribed() {
      return typeof listener === "function";
    },
    getView() {
      return registeredView;
    },
  };
}

test("registers from bootstrap without a session, subscription, or network request", { concurrency: false }, async () => {
  await withBrowserPlugin(async (apply, styles) => {
    const fixture = createContext();
    delete fixture.context.sessions;
    globalThis.fetch = () => { throw new Error("registration must not fetch"); };
    apply(fixture.context);
    assert.deepEqual(fixture.events, ["register"]);
    assert.equal(fixture.isSubscribed(), false);
    assert.equal(fixture.toolRows.size, 8);
    assert.equal(styles.length, 1);
    fixture.cleanup();
    assert.deepEqual(fixture.events, ["register", "dispose"]);
    assert.equal(styles.length, 0);
  });
});

test("missing, disabled, or malformed bootstrap hides only the view without probing", { concurrency: false }, async () => {
  for (const config of [undefined, null, {}, { webUi: false }, { webUi: "true" }, { webUi: 1 }]) {
    await withBrowserPlugin(async (apply, styles) => {
      globalThis.__DSH_GITNEXUS_CONFIG__ = config;
      const fixture = createContext();
      globalThis.fetch = () => { throw new Error("registration must not fetch"); };
      apply(fixture.context);
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.toolRows.size, 8);
      assert.equal(styles.length, 1);
      assert.equal(fixture.isSubscribed(), false);
      fixture.cleanup();
      assert.equal(fixture.toolRows.size, 0);
      assert.equal(styles.length, 0);
    });
  }
});

function viewStatus(state, extra = {}) {
  return {
    state,
    workspace: { name: "current", path: "/workspace/current" },
    gateway: "/gitnexus/session/view",
    repo: { name: "current" },
    ...extra,
  };
}

function button(renderer, text) {
  return renderer.root.findAllByType("button").find((item) => item.props.children === text);
}

test(
  "GitNexusView recovery and preview lifecycle",
  { concurrency: false },
  async () => {
    await withBrowserPlugin(async (apply, _styleNodes, runIntervals) => {
      const fixture = createContext();
      const checkpoint =
        "Runtime exception: Cannot open database in read-only mode while checkpoint is in progress. Please retry later.";
      const statuses = [
        viewStatus("unavailable", { reason: checkpoint, canRebuild: true }),
        viewStatus("analyzing", { analysis: { status: "running", progress: 35 } }),
        viewStatus("ready"),
      ];
      const requests = [];
      let resolveAnalyze;
      const analyzeResponse = new Promise((resolve) => {
        resolveAnalyze = () => resolve(jsonValue({ status: "analyzing" }, 202));
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input), "http://dsh.test");
        requests.push({ url, init });
        if (url.pathname === "/gitnexus/session/open") {
          assert.equal(init.method, "POST");
          return jsonValue({ gateway: "/gitnexus/session/view" });
        }
        if (url.pathname === "/gitnexus/session/view/dsh/status") {
          return jsonValue(statuses.shift() ?? viewStatus("ready"));
        }
        if (url.pathname === "/gitnexus/session/view/dsh/analyze") return analyzeResponse;
        throw new Error("unexpected browser request: " + url.pathname);
      };
      apply(fixture.context);
      await flush();
      const renderer = create(React.createElement(fixture.getView(), { sessionId: "session-current" }));
      await act(async () => { await flush(); });
      let rebuild = button(renderer, "重建索引");
      assert.ok(rebuild);
      assert.equal(button(renderer, "重试"), undefined);
      const click = rebuild.props.onClick();
      await act(async () => { await flush(); });
      rebuild = renderer.root.findAllByType("button")[0];
      assert.equal(rebuild.props.disabled, true);
      assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/dsh/analyze")).length, 1);
      resolveAnalyze();
      await act(async () => { await click; await flush(); });
      await act(async () => { runIntervals(); await flush(); });
      const iframe = renderer.root.findByType("iframe");
      assert.ok(iframe);
      assert.match(iframe.props.src, /server=/);
      const analyzeRequest = requests.find(({ url }) => url.pathname.endsWith("/dsh/analyze"));
      assert.deepEqual(JSON.parse(analyzeRequest.init.body), { force: true });
      await act(async () => { renderer.unmount(); });
    });

    await withBrowserPlugin(async (apply) => {
      const fixture = createContext();
      const statuses = [viewStatus("unavailable", { reason: "network unavailable", canRebuild: false }), viewStatus("ready")];
      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input), "http://dsh.test");
        requests.push({ url, init });
        if (url.pathname === "/gitnexus/session/open") {
          assert.equal(init.method, "POST");
          return jsonValue({ gateway: "/gitnexus/session/view" });
        }
        if (url.pathname === "/gitnexus/session/view/dsh/status") return jsonValue(statuses.shift() ?? viewStatus("ready"));
        throw new Error("unexpected browser request: " + url.pathname);
      };
      apply(fixture.context);
      await flush();
      const renderer = create(React.createElement(fixture.getView(), { sessionId: "session-current" }));
      await act(async () => { await flush(); });
      assert.ok(button(renderer, "重试"));
      assert.equal(button(renderer, "重建索引"), undefined);
      await act(async () => { await button(renderer, "重试").props.onClick(); await flush(); });
      assert.ok(renderer.root.findByType("iframe"));
      assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/dsh/analyze")).length, 0);
      await act(async () => { renderer.unmount(); });
    });

    await withBrowserPlugin(async (apply, _styleNodes, runIntervals) => {
      const fixture = createContext();
      const statuses = [
        viewStatus("failed", { analysis: { status: "failed", error: "index failed" } }),
        viewStatus("analyzing", { analysis: { status: "running", progress: 20 } }),
        viewStatus("ready"),
      ];
      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input), "http://dsh.test");
        requests.push({ url, init });
        if (url.pathname === "/gitnexus/session/open") {
          assert.equal(init.method, "POST");
          return jsonValue({ gateway: "/gitnexus/session/view" });
        }
        if (url.pathname === "/gitnexus/session/view/dsh/status") return jsonValue(statuses.shift() ?? viewStatus("ready"));
        if (url.pathname === "/gitnexus/session/view/dsh/analyze") return jsonValue({ status: "analyzing" }, 202);
        throw new Error("unexpected browser request: " + url.pathname);
      };
      apply(fixture.context);
      await flush();
      const renderer = create(React.createElement(fixture.getView(), { sessionId: "session-current" }));
      await act(async () => { await flush(); });
      await act(async () => { await button(renderer, "重新分析当前工作区").props.onClick(); await flush(); });
      assert.ok(button(renderer, "确认重新分析"));
      await act(async () => { await button(renderer, "确认重新分析").props.onClick(); await flush(); });
      await act(async () => { runIntervals(); await flush(); });
      assert.ok(renderer.root.findByType("iframe"));
      const analyzeRequest = requests.find(({ url }) => url.pathname.endsWith("/dsh/analyze"));
      assert.deepEqual(JSON.parse(analyzeRequest.init.body), { force: true });
      await act(async () => { renderer.unmount(); });
    });

    await withBrowserPlugin(async (apply, _styleNodes, runIntervals) => {
      const fixture = createContext();
      const checkpoint =
        "Runtime exception: Cannot open database in read-only mode while checkpoint is in progress. Please retry later.";
      const statuses = [
        viewStatus("unavailable", { reason: checkpoint, canRebuild: true }),
        viewStatus("analyzing", { analysis: { status: "running", progress: 35 } }),
        viewStatus("unavailable", { reason: "upstream network unavailable", canRebuild: false }),
      ];
      let resolveAnalyze;
      const analyzeResponse = new Promise((resolve) => {
        resolveAnalyze = () => resolve(jsonValue({ status: "analyzing" }, 202));
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input), "http://dsh.test");
        if (url.pathname === "/gitnexus/session/open") {
          assert.equal(init.method, "POST");
          return jsonValue({ gateway: "/gitnexus/session/view" });
        }
        if (url.pathname === "/gitnexus/session/view/dsh/status") return jsonValue(statuses.shift() ?? statuses.at(-1));
        if (url.pathname === "/gitnexus/session/view/dsh/analyze") return analyzeResponse;
        throw new Error("unexpected browser request: " + url.pathname);
      };
      apply(fixture.context);
      await flush();
      const renderer = create(React.createElement(fixture.getView(), { sessionId: "session-current" }));
      await act(async () => { await flush(); });
      const click = button(renderer, "重建索引").props.onClick();
      await act(async () => { await flush(); });
      resolveAnalyze();
      await act(async () => { await click; await flush(); });
      await act(async () => { runIntervals(); await flush(); });
      assert.throws(() => renderer.root.findByType("iframe"));
      assert.ok(button(renderer, "重试"));
      assert.equal(button(renderer, "重建索引"), undefined);
      assert.equal(renderer.root.findAllByType("div")[0].props.children.props.description, "upstream network unavailable");
      await act(async () => { renderer.unmount(); });
    });
  },
);

test("registers all eight keyed tool rows without a session or enabled graph capability", { concurrency: false }, async () => {
  for (const current of [null, "session-current"]) {
    await withBrowserPlugin(async (apply) => {
      const fixture = createContext();
      fixture.setCurrent(current);
      globalThis.__DSH_GITNEXUS_CONFIG__ = { webUi: false };
      globalThis.fetch = () => { throw new Error("disabled view must not fetch"); };
      apply(fixture.context);
      await flush();
      const expected = ["list_repos", "query", "context", "impact", "detect_changes", "rename", "cypher", "api_impact"].map(name => "gitnexus_" + name).sort();
      assert.deepEqual([...fixture.toolRows.keys()].sort(), expected);
      assert.equal(fixture.toolEvents.length, 8);
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.isSubscribed(), false);
      await flush();
      assert.equal(fixture.toolEvents.length, 8);
      fixture.cleanup();
      assert.equal(fixture.toolRows.size, 0);
      assert.equal(fixture.toolEvents.filter(([event]) => event === "dispose").length, 8);
      assert.equal(fixture.isSubscribed(), false);
    });
  }
});

test("recovery screens render workspace name without absolute paths", { concurrency: false }, async () => {
  for (const state of ["unindexed", "unavailable", "analyzing", "failed", "cancelled"]) {
    await withBrowserPlugin(async (apply) => {
      const fixture = createContext();
      const path = "/home/sensitive-person/private-project";
      const status = viewStatus(state, {
        workspace: { name: "private-project", path },
        repo: undefined,
        canRebuild: true,
        reason: "Cannot open " + path + "/.gitnexus/lbug",
        analysis: { status: state === "analyzing" ? "running" : state, message: "Analyzing " + path, error: "Failed reading '" + path + "/.gitnexus/lbug'" },
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input), "http://dsh.test");
        if (url.pathname === "/gitnexus/session/open") {
          assert.equal(init.method, "POST");
          return jsonValue({ gateway: "/gitnexus/session/view" });
        }
        if (url.pathname.endsWith("/dsh/status")) return jsonValue(status);
        throw new Error("unexpected browser request: " + url.pathname);
      };
      apply(fixture.context);
      await flush();
      let renderer;
      await act(async () => {
        renderer = create(React.createElement(fixture.getView(), { sessionId: "session-current" }));
        await flush();
      });
      try {
        const dom = JSON.stringify(renderer.toJSON());
        assert.ok(dom.includes("private-project"), state);
        assert.ok(!dom.includes("/home/"), state + " leaked an absolute path");
        assert.ok(!dom.includes("sensitive-person"), state + " leaked a parent directory");
        assert.equal(renderer.root.findByType("code").children.join(""), "private-project");
      } finally { await act(async () => renderer.unmount()); }
    });
  }
});