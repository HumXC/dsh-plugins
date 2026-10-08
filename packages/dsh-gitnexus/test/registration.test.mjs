import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { apply } from "../lib/index.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { NATIVE_COMMANDS } from "../lib/commands.js";
import { publicToolName } from "../lib/naming.js";

const runtime = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), ".npm-packages/lib/node_modules/@deepseek-ai/dsh");
const require = createRequire(join(runtime, "package.json"));
const { Context } = await import(require.resolve("@deepseek-ai/cordis"));
const { SystemPrompt, renderPrompt } = await import(require.resolve("@deepseek-ai/dsh-system-prompt"));
const { ToolRuntime, renderToolsSdk } = await import(require.resolve("@deepseek-ai/dsh-tools"));
const { createScope } = await import(require.resolve("@deepseek-ai/dsh-scope"));

async function fixture(t, serverName = "gitnexus") {
  const cwd = mkdtempSync(join(tmpdir(), "gitnexus-registration-"));
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false });
  new ToolRuntime(ctx);
  let spawns = 0;
  let boundNames = [];
  ctx.provide("subprocess", { spawn() { spawns++; throw new Error("backend is unavailable"); } });
  ctx.provide("ptcRuntime", {
    language: "typescript", isolation: "registration-test",
    resolve(request) { return request; },
    async run({ bindings }) { boundNames = Object.keys(bindings[0].functions); return { logs: [], value: "done" }; },
  });
  const discovery = t.mock.method(McpConnectionRouter.prototype, "discoverTools", async () => { throw new Error("startup discovery must not happen"); });
  await apply(ctx, { serverName, webUi: false, autoAugment: false });
  const agent = { session: { header: { cwd } } };
  agent.ctx = createScope(ctx, agent).ctx;
  t.after(async () => { await ctx.fiber.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  const names = ["analyze", "cli", ...NATIVE_COMMANDS.map(tool => tool.name), "status"].map(name => publicToolName(serverName, name));
  return { ctx, agent, cwd, names, discovery, spawns: () => spawns, bindings: () => boundNames };
}

function execute(ctx, agent, name, args = {}) {
  return ctx.tools.execute({ agent, name, arguments: args, callId: "registration-test", signal: new AbortController().signal });
}

test("actual SDK and assembled prompt expose all schemas before backend discovery, including PTC bindings", async t => {
  const f = await fixture(t, "custom-graph");
  assert.equal(f.discovery.mock.callCount(), 0);
  assert.equal(f.spawns(), 0);
  for (const name of f.names) assert.ok(f.ctx.tools.schemas(f.agent).some(schema => schema.name === name), name);
  const sdk = renderToolsSdk(f.ctx.tools.schemas(f.agent));
  for (const name of f.names) assert.ok(sdk.includes(name), name);
  const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }));
  assert.match(prompt, /custom-graph_query/);
  assert.match(prompt, /custom-graph_context/);
  assert.match(prompt, /custom-graph_impact/);
  assert.match(prompt, /do not reindex for every task/);
  f.agent.ctx.tools.presentAs("ptc");
  assert.equal((await execute(f.ctx, f.agent, "run_code", { code: "test", description: "test" })).isError, false);
  for (const name of f.names) assert.ok(f.bindings().includes(name), name);
  assert.equal(f.spawns(), 0);
});

test("status stays read-only and reports actual scope visibility and unknown freshness", async t => {
  const f = await fixture(t);
  f.agent.ctx.tools.restrict({ allow: ["gitnexus_status", "gitnexus_query"] });
  const result = await execute(f.ctx, f.agent, "gitnexus_status");
  assert.equal(result.isError, false);
  assert.equal(result.value.workspace, basename(f.cwd));
  assert.deepEqual(result.value.registeredTools, f.names);
  assert.deepEqual(result.value.visibleTools, ["gitnexus_query", "gitnexus_status"]);
  assert.deepEqual(result.value.index, { present: false, freshness: "unknown" });
  assert.deepEqual(result.value.backend, { state: "unknown", supportedTools: [], lastError: null });
  mkdirSync(join(f.cwd, ".gitnexus"));
  assert.deepEqual((await execute(f.ctx, f.agent, "gitnexus_status")).value.index, { present: false, freshness: "unknown" });
  writeFileSync(join(f.cwd, ".gitnexus", "meta.json"), "{}");
  assert.deepEqual((await execute(f.ctx, f.agent, "gitnexus_status")).value.index, { present: true, freshness: "unknown" });
  assert.equal(f.spawns(), 0);
  assert.equal(f.discovery.mock.callCount(), 0);
  const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent });
  const guidance = assembly.sections.find(section => section.name === "gitnexus:usage-guidance").text;
  assert.match(guidance, /gitnexus_query/);
  assert.doesNotMatch(guidance, /gitnexus_context|gitnexus_impact|gitnexus_analyze/);
  assert.equal((await execute(f.ctx, f.agent, "gitnexus_status", { cwd: "/tmp" })).isError, true);
});

test("status sanitizes cached errors and remains bounded to the caller workspace", async t => {
  const f = await fixture(t);
  let root;
  t.mock.method(McpConnectionRouter.prototype, "getDiagnostics", cwd => { root = cwd; return { state: "unavailable", supportedTools: ["query"], lastError: "failed to initialize " + cwd }; });
  const result = await execute(f.ctx, f.agent, "gitnexus_status");
  assert.equal(result.isError, false);
  assert.equal(root, f.cwd);
  assert.equal(result.value.backend.state, "unavailable");
  assert.match(result.value.backend.lastError, /failed to initialize/);
  assert.ok(!JSON.stringify(result.value).includes(f.cwd));
  assert.equal(f.spawns(), 0);
});
