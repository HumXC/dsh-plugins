import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisCoordinator } from "../lib/analysis-coordinator.js";
import { resolveConfig } from "../lib/config.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";

const callResult = { content: [{ type: "text", text: "ok" }] };

test("does not evict a connection reserved by a concurrent tool call", async () => {
  let finishFirst;
  const firstCall = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const closed = [];
  const router = new McpConnectionRouter(
    {},
    resolveConfig({ maxConnections: 1 }),
    new AbortController().signal,
    () => {},
  );
  router.connections.set("/repo-a", {
    client: {
      callTool: () => firstCall,
      close: async () => closed.push("/repo-a"),
    },
    transport: { isClosed: false },
    activeCalls: 0,
    lastUsed: 0,
  });

  const activeCall = router.callTool(
    "/repo-a",
    "query",
    {},
    new AbortController().signal,
  );
  await assert.rejects(
    router.callTool("/repo-b", "query", {}, new AbortController().signal),
    /all 1 MCP connections are busy/,
  );
  assert.deepEqual(closed, []);

  finishFirst(callResult);
  assert.deepEqual(await activeCall, callResult);
  await router.dispose();
  assert.deepEqual(closed, ["/repo-a"]);
});

test("rejects calls and evicts an existing connection during analysis", async () => {
  const closed = [];
  const analysis = new AnalysisCoordinator();
  const router = new McpConnectionRouter(
    {},
    resolveConfig(),
    new AbortController().signal,
    () => {},
    analysis,
  );
  router.connections.set("/repo-a", {
    client: {
      close: async () => closed.push("/repo-a"),
    },
    transport: { isClosed: false },
    activeCalls: 0,
    lastUsed: 0,
  });

  analysis.begin("/repo-a");
  await assert.rejects(
    router.callTool("/repo-a", "query", {}, new AbortController().signal),
    /being rebuilt/,
  );
  await router.evict("/repo-a");

  assert.deepEqual(closed, ["/repo-a"]);
  assert.equal(router.connections.has("/repo-a"), false);
});
