import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installUsageGuidance, renderUsageGuidance } from "../lib/guidance.js";
import { publicToolName } from "../lib/naming.js";

// Exercise the deployed public services, including their actual scoped resolver.
const runtime = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), ".npm-packages/lib/node_modules/@deepseek-ai/dsh");
const require = createRequire(join(runtime, "package.json"));
const { Context } = await import(require.resolve("@deepseek-ai/cordis"));
const { SystemPrompt, renderPrompt } = await import(require.resolve("@deepseek-ai/dsh-system-prompt"));
const { ToolRuntime } = await import(require.resolve("@deepseek-ai/dsh-tools"));
const { createScope } = await import(require.resolve("@deepseek-ai/dsh-scope"));

const commands = ["query", "context", "impact", "detect_changes", "status", "analyze"];
const config = { serverName: "custom-graph" };
const names = commands.map(name => publicToolName(config.serverName, name));
const schema = name => ({ name });
const references = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);

function fixture(t) {
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false });
  new ToolRuntime(ctx);
  const executions = [];
  ctx.provide("ptcRuntime", {
    language: "typescript", isolation: "guidance-test",
    resolve(request) { return request; },
    async run() { throw new Error("guidance must not execute tools"); },
  });
  for (const name of [...names, "grep", "read", "unrelated_query"]) {
    ctx.tools.register({
      name, description: name, parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      async execute() { executions.push(name); return "ok"; },
    });
  }
  t.after(async () => {
    assert.deepEqual(executions, [], "prompt assembly must not inspect state by executing tools");
    await ctx.fiber.dispose();
  });
  return ctx;
}

async function guidance(ctx, scope) {
  const assembly = await ctx.systemPrompt.assemble({ scope });
  return assembly.sections.find(section => section.name === "gitnexus:usage-guidance")?.text ?? "";
}

test("pure guidance gives the concise workflow and only visible custom names", () => {
  const text = renderUsageGuidance([...names, "grep", "read"].map(schema), config);
  assert.ok(text.indexOf("`custom-graph_query`") < text.indexOf("`custom-graph_context`"));
  assert.match(text, /verify the evidence against current source before editing/);
  assert.match(text, /Exact symbol or file lookups.*`grep` and `read` directly/);
  assert.match(text, /Before public-interface changes, deletion, or cross-file refactors.*`custom-graph_impact`/);
  assert.match(text, /After code changes.*`custom-graph_detect_changes`/);
  assert.match(text, /`custom-graph_status`.*does not establish index freshness or backend readiness/);
  assert.match(text, /`custom-graph_analyze`.*relevant to the work is missing or confirmed stale; do not reindex for every task/);
  assert.deepEqual(new Set(references(text)), new Set([...names, "grep", "read"]));
  assert.doesNotMatch(text, /gitnexus_|index is ready|backend is ready|index is fresh/);
});

test("pure guidance omits absent tools and unrelated server namespaces", () => {
  for (const raw of commands) {
    const name = publicToolName(config.serverName, raw);
    const text = renderUsageGuidance([schema(name)], config);
    assert.deepEqual(references(text), [name]);
  }
  assert.equal(renderUsageGuidance([schema("grep"), schema("read"), schema("unrelated_query")], config), "");
  assert.equal(renderUsageGuidance([], config), "");
  const text = renderUsageGuidance([schema("custom-graph_query"), schema("read")], config);
  assert.deepEqual(references(text), ["custom-graph_query", "read"]);
});

test("actual prompt and tool runtime reflect native, PTC, and both scoped visibility", async t => {
  const ctx = fixture(t);
  installUsageGuidance(ctx, config);
  for (const mode of ["native", "ptc", "both"]) {
    const key = {};
    const scope = createScope(ctx, key);
    const allowed = [names[0], names[1], "read"];
    scope.ctx.tools.restrict({ allow: allowed });
    scope.ctx.tools.presentAs(mode);
    const text = await guidance(ctx, key);
    assert.deepEqual(references(text), allowed, mode);
    const assembly = await ctx.systemPrompt.assemble({ scope: key });
    const wireNames = assembly.tools.map(tool => tool.name);
    if (mode === "ptc") {
      assert.deepEqual(wireNames, ["run_code"]);
      assert.match(renderPrompt(assembly), /custom-graph_query/);
    } else {
      assert.ok(wireNames.includes(names[0]));
    }
    const restriction = scope.ctx.tools.restrict({ deny: [names[1]] });
    assert.deepEqual(references(await guidance(ctx, key)), [names[0], "read"], mode + " changed restriction");
    restriction();
    assert.deepEqual(references(await guidance(ctx, key)), allowed, mode + " restored restriction");
    await scope.dispose();
  }
  const hiddenKey = {};
  const hidden = createScope(ctx, hiddenKey);
  hidden.ctx.tools.restrict({ allow: ["read"] });
  assert.equal(await guidance(ctx, hiddenKey), "");
  assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble({ scope: hiddenKey })), /GitNexus usage|custom-graph_/);
  await hidden.dispose();
});

test("guidance follows scoped tool registration, removal, and composition ancestry", async t => {
  const ctx = fixture(t);
  const ownerKey = {};
  const owner = createScope(ctx, ownerKey);
  installUsageGuidance(owner.ctx, config);
  const childKey = {};
  const child = createScope(ctx, childKey, { parent: ownerKey });
  child.ctx.tools.restrict({ allow: ["read"] });
  assert.equal(await guidance(ctx, childKey), "");
  const remove = child.ctx.tools.register({
    name: names[2], description: "scoped impact", parameters: { type: "object", properties: {} },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() { throw new Error("guidance must not execute tools"); },
  });
  assert.deepEqual(references(await guidance(ctx, childKey)), ["read", names[2]]);
  assert.equal(await guidance(ctx, {}), "", "unrelated scopes do not inherit the owner section");
  remove();
  assert.equal(await guidance(ctx, childKey), "");
  await owner.dispose();
  assert.equal((await ctx.systemPrompt.assemble({ scope: childKey })).sections.some(section => section.name === "gitnexus:usage-guidance"), false);
  await child.dispose();
});

test("Cordis plugin lifecycle owns cleanup without manually calling the returned disposer", async t => {
  const ctx = fixture(t);
  const fiber = ctx.plugin({
    name: "guidance-owner", inject: ["tools", "systemPrompt"],
    apply(owner) { installUsageGuidance(owner, config); },
  });
  await fiber;
  assert.match(await guidance(ctx), /GitNexus usage/);
  await fiber.dispose();
  assert.equal(await guidance(ctx), "");
  const dispose = installUsageGuidance(ctx, config);
  assert.match(await guidance(ctx), /GitNexus usage/);
  dispose();
  assert.equal(await guidance(ctx), "");
});
