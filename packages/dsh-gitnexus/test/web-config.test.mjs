import assert from "node:assert/strict";
import test from "node:test";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";
import { runInNewContext } from "node:vm";
import { apply } from "../lib/index.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { NATIVE_COMMANDS } from "../lib/commands.js";

test("host bootstrap publishes only normalized Web display permission before discovery", async (t) => {
  for (const webUi of [undefined, "auto", true, false]) {
    const handlers = new Map();
    const cleanups = [];
    const routes = [];
    let registeredTools = 0;
    const ctx = {
      on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
      tools: { register() { registeredTools++; return () => {}; } },
      subprocess: {},
      logger: { debug() {}, info() {} },
      inject(services) { routes.push(services); },
      effect(effect) { cleanups.push(effect()); },
    };
    const mock = t.mock.method(McpConnectionRouter.prototype, "discoverTools", async () => {
      assert.ok(handlers.has("webserver/index-inject"), "config must be available before async discovery");
      return NATIVE_COMMANDS.map(({ name, parameters }) => ({ name, inputSchema: parameters }));
    });
    try {
      await apply(ctx, { webUi, autoAugment: false });
      const rows = [];
      handlers.get("webserver/index-inject")(rows);
      assert.deepEqual(rows, [{ kind: "global", name: "__DSH_GITNEXUS_CONFIG__", value: { webUi: webUi !== false } }]);
      const html = renderIndexInjections("<html><head></head><body></body></html>", rows);
      const sandbox = {};
      for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) runInNewContext(script, sandbox);
      assert.equal(sandbox.__DSH_GITNEXUS_CONFIG__.webUi, webUi !== false);
      assert.deepEqual(Object.keys(sandbox.__DSH_GITNEXUS_CONFIG__), ["webUi"]);
      assert.equal(registeredTools, 8);
      assert.equal(routes.length, webUi === false ? 0 : 1);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      mock.mock.restore();
    }
  }
});
