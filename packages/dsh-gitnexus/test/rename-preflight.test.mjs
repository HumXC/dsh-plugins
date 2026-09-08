import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkspaceScope } from "../lib/workspace-isolation.js";
import { validateRenamePaths } from "../lib/rename-preflight.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { resolveConfig } from "../lib/config.js";
const reply = (paths, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify({ markdown: "| paths |\n| --- |\n| " + JSON.stringify(paths) + " |", row_count: 1, ...extra }) + "\nNext: context({name: ...})" }] });
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "gitnexus-rename-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace"), outside = join(base, "outside");
  mkdirSync(join(root, ".gitnexus"), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, ".gitnexus", "meta.json"), "{}");
  writeFileSync(join(outside, "secret.ts"), "outside");
  return { root, outside };
}
test("name/uid-only rename rejects derived outward paths before preview and apply", async t => {
  const { root, outside } = fixture(t);
  symlinkSync(join(outside, "secret.ts"), join(root, "source.ts"));
  symlinkSync(outside, join(root, "node_modules"), "dir");
  for (const path of ["source.ts", "node_modules/secret.ts"]) for (const dry_run of [undefined, true, false]) {
    const calls = [], router = new McpConnectionRouter({}, resolveConfig(), new AbortController().signal, () => {});
    router.withConnection = async (_cwd, operation) => operation({ client: { callTool: async spec => { calls.push(spec.name); return reply([path]); } } });
    await assert.rejects(router.callTool(root, "rename", { symbol_uid: "Function:source.ts:X", new_name: "Y", dry_run }, new AbortController().signal), /escapes/);
    assert.deepEqual(calls, ["cypher"]);
  }
});
test("preflight paginates complete JSON paths preserving pipes and newlines", async t => {
  const { root } = fixture(t), scope = prepareWorkspaceScope(root), queries = [];
  await validateRenamePaths(scope, root, async statement => {
    queries.push(statement);
    return reply(queries.length === 1 ? Array.from({ length: 256 }, (_, i) => "file" + i + ".ts") : ["pipe|and\nnewline.ts"]);
  });
  assert.equal(queries.length, 2); assert.match(queries[1], /SKIP 256 LIMIT 256 RETURN collect/);
});
test("preflight refuses truncated malformed unsupported and over-limit responses", async t => {
  const { root } = fixture(t), scope = prepareWorkspaceScope(root);
  for (const response of [reply([], { truncated: true }), reply([], { partial: true }), reply([], { row_count: 0 }), reply([null]), { content: [{ type: "text", text: '{"markdown":' }] }]) await assert.rejects(validateRenamePaths(scope, root, async () => response));
  await assert.rejects(validateRenamePaths(scope, root, async () => reply(Array.from({ length: 256 }, (_, i) => "file" + i))), /incomplete/);
});
test("safe preview passes through unchanged after path validation", async t => {
  const { root } = fixture(t), calls = [], expected = { content: [{ type: "text", text: "preview" }] };
  const router = new McpConnectionRouter({}, resolveConfig(), new AbortController().signal, () => {});
  router.withConnection = async (_cwd, operation) => operation({ client: { callTool: async spec => { calls.push(spec); return spec.name === "cypher" ? reply(["src/safe.ts"]) : expected; } } });
  assert.equal(await router.callTool(root, "rename", { symbol_name: "X", new_name: "Y", dry_run: true }, new AbortController().signal), expected);
  assert.deepEqual(calls.map(c => c.name), ["cypher", "rename"]); assert.equal(calls[1].arguments.dry_run, true);
});
