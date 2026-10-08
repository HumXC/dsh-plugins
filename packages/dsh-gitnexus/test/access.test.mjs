import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitNexusAccess, INDEX_STATUS_TOOL } from '../lib/access.js';
import { resolveConfig } from '../lib/config.js';
import { routedToolDefinition, apply } from '../lib/index.js';
import { AutoAugmentController } from '../lib/augment.js';
import { McpConnectionRouter } from '../lib/mcp-router.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Deliberately test the deployed registry, not the plugin's older development SDK.
const runtime = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), '.npm-packages/lib/node_modules/@deepseek-ai/dsh');
const require = createRequire(join(runtime, 'package.json'));
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { ToolRuntime, renderToolsSdk } = await import(require.resolve('@deepseek-ai/dsh-tools'));
const { SystemPrompt } = await import(require.resolve('@deepseek-ai/dsh-system-prompt'));
const { createScope, scopeTarget, bindScopeParent } = await import(require.resolve('@deepseek-ai/dsh-scope'));

const query = 'gitnexus_query';
const rename = 'gitnexus_rename';
const nativeNames = ['list_repos', 'query', 'context', 'impact', 'detect_changes', 'rename', 'cypher', 'api_impact'];
const config = resolveConfig({ accessMode: 'explicit-subagent-grant', webUi: false });
function descriptor(allow = [INDEX_STATUS_TOOL, query], extra = {}) {
  return { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', toolFilter: { allow }, ...extra } };
}
function fixture() {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  const agents = [];
  ctx.provide('agents', { list: () => agents });
  const composed = new WeakMap();
  ctx.provide('agentPresets', { composedPreset: context => composed.get(context) });
  const standingKey = {};
  const standing = createScope(ctx, standingKey);
  const calls = [];
  const access = new GitNexusAccess(config);
  for (const [name, raw] of [[query, 'query'], [rename, 'rename']]) {
    standing.ctx.tools.register(routedToolDefinition({ name: raw, inputSchema: { type: 'object', properties: {} } }, {
      async callTool(root, name, args, signal) { calls.push({ root, name, args, signal }); if (args.search_query === 'fail') throw new Error('upstream failed'); return { content: [{ type: 'text', text: 'graph evidence' }] }; }
    }, config, access));
  }
  for (const name of [INDEX_STATUS_TOOL, 'read', 'explore_code']) standing.ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { return 'ok'; } });
  const dispose = access.install(standing.ctx, [INDEX_STATUS_TOOL, query, rename]);
  function agent(events = [], filter, options = {}) {
    const result = { id: `test-${agents.length}`, session: { header: { origin: 'subagent', parentSession: 'parent', agentPreset: 'coding', cwd: '/tmp', ...options.header }, inheritedEventCount: options.offset ?? 0, snapshotEvents(offset) { return events.slice(offset); }, append() {} } };
    const scope = createScope(ctx, result);
    const binding = bindScopeParent(result, options.blank ? {} : standingKey);
    result.ctx = scope.ctx;
    composed.set(result.ctx, options.blank ? 'other' : 'coding');
    if (filter) result.ctx.tools.restrict(filter);
    agents.push(result);
    ctx.emit(scopeTarget(result, result), 'agent/created', { agent: result });
    return { agent: result, scope, binding };
  }
  return { ctx, agents, composed, standingKey, standing, agent, calls, access, dispose };
}
function run(tools, agent, name, args = name === query ? { query: 'graph' } : {}, signal = new AbortController().signal) {
  return tools.execute({ agent, name, arguments: args, callId: `call-${Math.random()}`, signal });
}

test('actual registry: main and six roles hidden, explorer visible, PTC bindings and nested dispatch isolated', async () => {
  const f = fixture();
  try {
    const main = f.agent([], undefined, { header: { origin: undefined, parentSession: undefined } }).agent;
    const others = ['research_web', 'operate_browser', 'worker_code', 'verify_code', 'review_code', 'commit_git'].map(role => f.agent([descriptor([query], { label: role })], { allow: ['read'] }).agent);
    const explorer = f.agent([descriptor()], { allow: ['read', INDEX_STATUS_TOOL, query] }).agent;
    assert.ok(f.ctx.tools.schemas(explorer).some(t => t.name === query));
    for (const agent of [main, ...others]) {
      assert.ok(f.ctx.tools.schemas(agent).some(t => t.name === 'read'), 'nonempty schemas prevent false mount success');
      assert.equal(f.ctx.tools.get(query, agent), undefined);
      assert.doesNotMatch(renderToolsSdk(f.ctx.tools.schemas(agent)), /gitnexus_/);
      assert.equal((await run(f.ctx.tools, agent, query)).isError, true);
    }
    assert.match(renderToolsSdk(f.ctx.tools.schemas(explorer)), /gitnexus_query/);
    assert.equal(f.ctx.tools.get(rename, explorer), undefined);
    assert.equal((await run(f.ctx.tools, explorer, query)).isError, false);
    assert.equal(f.calls.length, 1);
    assert.equal((await run(f.ctx.tools, main, 'explore_code', { run_in_background: false })).isError, true);
    let seen;
    f.ctx.provide("ptcRuntime", { language: "typescript", isolation: "test", resolve(request) { return request; }, async run({ bindings }) {
      const functions = bindings[0].functions;
      seen = Object.keys(functions);
      if (functions[query]) await functions[query]({ query: 'graph' });
      return { logs: [], value: 'done' };
    } });
    for (const agent of [main, explorer, ...others]) {
      agent.ctx.tools.presentAs('ptc');
      assert.equal((await run(f.ctx.tools, agent, 'run_code', { code: 'test', description: 'test' })).isError, false);
      assert.equal(seen.includes(query), agent === explorer);
    }
    assert.equal(f.calls.length, 2);
    assert.equal((await run(f.ctx.tools, explorer, query)).isError, true, 'PTC direct endpoints cannot bypass run_code');
  } finally { f.dispose(); await f.ctx.fiber.dispose(); }
});

test('durable grants: cold resume, inherited descriptor exclusion, legacy/foreground/malformed fail closed', async () => {
  const f = fixture();
  try {
    const cold = f.agent([descriptor()]).agent;
    assert.equal(f.access.allows(cold, query), true);
    for (const events of [[], [descriptor([query])], [descriptor(undefined, { version: 2 })], [descriptor(undefined, { mode: 'one-shot' })], [descriptor(undefined, { provider: 'fork' })], [descriptor(undefined, { toolFilter: { allow: [INDEX_STATUS_TOOL, query], deny: [INDEX_STATUS_TOOL] } })]]) {
      const candidate = f.agent(events).agent;
      assert.equal(f.access.allows(candidate, query), false);
      assert.equal(f.ctx.tools.get(query, candidate), undefined);
    }
    assert.equal(f.access.allows(f.agent([descriptor()], undefined, { offset: 1 }).agent), false);
    const firstWins = f.agent([descriptor([query]), descriptor()]).agent;
    assert.equal(f.access.allows(firstWins), false);
    f.composed.set(cold.ctx, 'other');
    assert.equal(f.access.allows(cold), false, 'cached grant cannot survive a different current composition');
    const blank = f.agent([], undefined, { blank: true, header: { origin: undefined } });
    blank.binding.rebind(f.standingKey);
    f.composed.set(blank.agent.ctx, 'coding');
    f.ctx.emit('tools/change');
    assert.equal(f.ctx.tools.get(query, blank.agent), undefined, 'blank recompose must hide schemas synchronously');
    assert.equal(new GitNexusAccess(resolveConfig()).allows(undefined), true);
  } finally { f.dispose(); await f.ctx.fiber.dispose(); }
});

test('routed body independently denies unauthorized callers and propagates errors/cancellation', async () => {
  const f = fixture();
  try {
    const explorer = f.agent([descriptor()]).agent;
    const definition = f.ctx.tools.get(query, explorer);
    await assert.rejects(definition.execute({}, { agent: undefined }), /access denied/);
    const failed = await run(f.ctx.tools, explorer, query, { query: 'fail' });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /upstream failed/);
    const controller = new AbortController();
    controller.abort();
    const before = f.calls.length;
    assert.equal((await run(f.ctx.tools, explorer, query, { query: 'graph' }, controller.signal)).isError, true);
    assert.equal(f.calls.length, before);
  } finally { f.dispose(); await f.ctx.fiber.dispose(); }
});

test('autoaugmentation runs only for explicitly granted explorer, not main/legacy/sibling', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'gitnexus-access-'));
  mkdirSync(join(root, '.gitnexus'));
  writeFileSync(join(root, '.gitnexus', 'meta.json'), '{}');
  const spawns = [];
  f.ctx.provide('subprocess', { spawn(spec) {
    spawns.push(spec);
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'AuthService -> DB', lossy: false }) }, stderr: { readFrom: () => ({ text: '' }) } } };
  } });
  const augmenter = new AutoAugmentController(f.standing.ctx, config, undefined, f.access);
  augmenter.start();
  try {
    const main = f.agent([], undefined, { header: { cwd: root, origin: undefined } }).agent;
    const legacy = f.agent([descriptor([query])], undefined, { header: { cwd: root } }).agent;
    const explorer = f.agent([descriptor()], { allow: ['read', INDEX_STATUS_TOOL, query] }, { header: { cwd: root } }).agent;
    for (const agent of [main, legacy]) {
      const result = await run(f.ctx.tools, agent, 'read', { file_path: 'src/AuthService.ts' });
      assert.equal(result.isError, false);
      assert.equal(result.additionalContexts, undefined);
    }
    assert.equal(spawns.length, 0);
    const result = await run(f.ctx.tools, explorer, 'read', { file_path: 'src/AuthService.ts' });
    assert.equal(result.isError, false);
    assert.equal(spawns.length, 1);
    assert.match(JSON.stringify(result.additionalContexts), /AuthService -> DB/);
    await run(f.ctx.tools, main, 'read', { file_path: 'src/OtherService.ts' });
    assert.equal(spawns.length, 1);
  } finally { await augmenter.dispose(); f.dispose(); await f.ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('complete apply registers real index-status output, gates already-live agent and unwinds on unload', async t => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  const agents = [];
  ctx.provide('agents', { list: () => agents });
  ctx.provide('agentPresets', { composedPreset: () => 'coding' });
  ctx.provide('subprocess', {});
  const key = {};
  const standing = createScope(ctx, key);
  const main = { session: { header: {} } };
  main.ctx = createScope(ctx, main, { parent: key }).ctx;
  agents.push(main);
  t.mock.method(McpConnectionRouter.prototype, 'discoverTools', async () => nativeNames.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })));
  await apply(standing.ctx, { ...config, autoAugment: false });
  try {
    assert.equal(ctx.tools.get(query, main), undefined);
    assert.equal(ctx.tools.get(INDEX_STATUS_TOOL, main), undefined);
    const explorer = { session: { header: { cwd: '/tmp', origin: 'subagent', parentSession: 'main', agentPreset: 'coding' }, inheritedEventCount: 0, snapshotEvents: () => [descriptor()] } };
    explorer.ctx = createScope(ctx, explorer, { parent: key }).ctx;
    explorer.ctx.tools.restrict({ allow: [INDEX_STATUS_TOOL, query] });
    agents.push(explorer);
    ctx.emit(scopeTarget(explorer, explorer), 'agent/created', { agent: explorer });
    const result = await run(ctx.tools, explorer, INDEX_STATUS_TOOL);
    assert.equal(result.isError, false);
    assert.equal(typeof result.value.root, 'string');
    assert.equal(typeof result.value.hasIndex, 'boolean');
    assert.match(renderToolsSdk(ctx.tools.schemas(explorer)), /gitnexus_index_status/);
    await standing.dispose();
    assert.equal(ctx.tools.get(INDEX_STATUS_TOOL, explorer), undefined);
  } finally { await ctx.fiber.dispose(); }
});
