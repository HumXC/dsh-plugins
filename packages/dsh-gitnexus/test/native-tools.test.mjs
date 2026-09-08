import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_COMMANDS } from '../lib/commands.js';
import { commandArguments } from '../lib/arguments.js';
import { routedToolDefinition } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';

const runtime = process.env.DSH_RUNTIME_ROOT ?? join(homedir(), '.npm-packages/lib/node_modules/@deepseek-ai/dsh');
const require = createRequire(join(runtime, 'package.json'));
const { renderToolsSdk, ToolRuntime } = await import(require.resolve('@deepseek-ai/dsh-tools'));
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { SystemPrompt } = await import(require.resolve('@deepseek-ai/dsh-system-prompt'));
const config = resolveConfig();
const names = ['list_repos', 'query', 'context', 'impact', 'detect_changes', 'rename', 'cypher', 'api_impact'];
const agent = { session: { header: { cwd: '/tmp' } } };
const signal = new AbortController().signal;
function definition(name, result = { content: [{ type: 'text', text: 'evidence' }] }, calls = []) {
  return routedToolDefinition({ name, description: 'UPSTREAM_VERBOSE_DO_NOT_EXPOSE', inputSchema: { type: 'object', properties: { upstream_only: { type: 'string' } } } }, {
    async callTool(root, name, args, signal) { calls.push({ root, name, args, signal }); return result; }
  }, config);
}

test('fixed native catalog is typed, compact, and never copies MCP metadata', () => {
  assert.deepEqual(NATIVE_COMMANDS.map(command => command.name), names);
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  const disposers = names.map(name => ctx.tools.register(definition(name)));
  try {
    const schemas = ctx.tools.schemas();
    assert.equal(schemas.length, 8);
    const sdk = renderToolsSdk(schemas);
    assert.doesNotMatch(sdk, /UPSTREAM_VERBOSE|upstream_only|mcp__|args: unknown/);
    for (const name of names) assert.ok(sdk.includes('gitnexus_' + name));
    assert.ok(sdk.length < 15000, 'native SDK character budget exceeded: ' + sdk.length);
    assert.match(sdk, /UNKNOWN/);
    assert.match(sdk, /partial/);
    assert.match(sdk, /dry_run/);
    console.log('Native tools SDK characters:', sdk.length);
  } finally { for (const dispose of disposers) dispose(); }
  assert.throws(() => definition('explain'), /Unsupported native/);
});

test('native arguments map aliases, default workspace and preserve cancellation', async () => {
  const calls = [];
  const args = Object.freeze({ query: 'routing', content: true });
  const output = await definition('query', undefined, calls).execute(args, { agent, signal });
  assert.deepEqual(output, { text: 'evidence' });
  assert.deepEqual(calls[0].args, { search_query: 'routing', include_content: true, repo: '/tmp' });
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].name, 'query');
  assert.deepEqual(args, { query: 'routing', content: true });
  assert.deepEqual(commandArguments('list_repos', { offset: 2 }, '/tmp'), { offset: 2 });
  assert.equal(commandArguments('context', { uid: 'id', repo: 'other' }, '/tmp').repo, 'other');
  assert.equal(commandArguments('impact', { target: 'run' }, '/tmp').direction, 'upstream');
  assert.equal(commandArguments('detect_changes', {}, '/tmp').scope, 'unstaged');
  assert.equal(commandArguments('rename', { symbol_name: 'a', new_name: 'b' }, '/tmp').dry_run, true);
  assert.equal(commandArguments('rename', { symbol_uid: 'a', new_name: 'b', dry_run: false }, '/tmp').dry_run, false);
});

test('native contract rejects invalid alternative selectors and bounds before dispatch', () => {
  for (const [name, args] of [
    ['context', {}], ['impact', {}], ['rename', { new_name: 'b' }], ['api_impact', {}],
    ['list_repos', { limit: 201 }], ['query', { query: 'a', limit: 0 }],
    ['impact', { target: 'x', minConfidence: 2 }], ['impact', { target: 'x', maxDepth: 33 }],
    ['detect_changes', { scope: 'compare' }], ['detect_changes', { base_ref: 'main' }],
    ['query', { query: ' ' }], ['query', { query: 'a', repo: '@group' }],
  ]) assert.throws(() => commandArguments(name, args, '/tmp'), undefined, name + JSON.stringify(args));
});

test('canonical results retain complete risk text and parsed JSON evidence', async () => {
  const data = { risk: 'UNKNOWN', epistemic: 'lower-bound', partial: true, truncated: true, boundaries: ['unresolved dispatch'], byDepth: {} };
  const text = JSON.stringify(data) + '\n\n---\nAdditional caveat';
  const tool = definition('impact', { content: [{ type: 'text', text }] });
  const value = await tool.execute({ target: 'run' }, { agent, signal });
  assert.deepEqual(value, { text, data });
  const content = tool.output.render({}, value);
  assert.equal(content[0].text, text);
  assert.deepEqual(tool.presentResult({}, { content, isError: false }).content, content);
  const structured = await definition('impact', { content: [{ type: 'text', text: 'summary' }], structuredContent: data }).execute({ target: 'run' }, { agent, signal });
  assert.deepEqual(structured.data, data);
  assert.match(structured.text, /UNKNOWN/);
  assert.match(structured.text, /summary/);
});

test('presenters distinguish rename preview and write; failures remain failures', async () => {
  const tool = definition('rename');
  assert.match(tool.presentCall({}).title, /Preview/);
  assert.equal(tool.presentCall({ dry_run: false }).kind, 'edit');
  const errorContent = [{ type: 'text', text: 'index unavailable' }];
  assert.match(tool.presentResult({}, { content: errorContent, isError: true }).title, /Failed/);
  await assert.rejects(definition('query', { content: errorContent, isError: true }).execute({ query: 'x' }, { agent, signal }), /index unavailable/);
});
