import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = mkdtempSync(join(tmpdir(), "gitnexus-router-"));
const repoA = join(base, "a"), repoB = join(base, "b");
for (const root of [repoA, repoB]) { mkdirSync(join(root, ".gitnexus"), { recursive: true }); writeFileSync(join(root, ".gitnexus", "meta.json"), "{}"); }
after(() => rmSync(base, { recursive: true, force: true }));
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
  router.connections.set(repoA, {
    client: {
      callTool: () => firstCall,
      close: async () => closed.push(repoA),
    },
    transport: { isClosed: false },
    activeCalls: 0,
    lastUsed: 0,
  });

  const activeCall = router.callTool(
    repoA,
    "query",
    {},
    new AbortController().signal,
  );
  await assert.rejects(
    router.callTool(repoB, "query", {}, new AbortController().signal),
    /all 1 MCP connections are busy/,
  );
  assert.deepEqual(closed, []);

  finishFirst(callResult);
  assert.deepEqual(await activeCall, callResult);
  await router.dispose();
  assert.deepEqual(closed, [repoA]);
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
  router.connections.set(repoA, {
    client: {
      close: async () => closed.push(repoA),
    },
    transport: { isClosed: false },
    activeCalls: 0,
    lastUsed: 0,
  });

  analysis.begin(repoA);
  await assert.rejects(
    router.callTool(repoA, "query", {}, new AbortController().signal),
    /being rebuilt/,
  );
  await router.evict(repoA);

  assert.deepEqual(closed, [repoA]);
  assert.equal(router.connections.has(repoA), false);
});