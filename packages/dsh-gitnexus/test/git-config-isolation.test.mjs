import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkspaceScope } from "../lib/workspace-isolation.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { resolveConfig } from "../lib/config.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gitnexus-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git")); mkdirSync(join(root, ".gitnexus"));
  writeFileSync(join(root, ".gitnexus", "meta.json"), "{}");
  return root;
}
test("effective worktree and include overrides fail before detect_changes dispatch", async t => {
  const root = fixture(t);
  for (const contents of ['[core]\nworktree = /outside', '[includeif.gitdir:/outside]\npath=/outside/config', '[CoRe] worktree=/outside', '[include]\npath=/outside/config', '[includeIf "gitdir:*"]\npath=/outside/config']) {
    writeFileSync(join(root, ".git", "config"), contents);
    let dispatched = false;
    const router = new McpConnectionRouter({ spawn() { dispatched = true; throw new Error("Unexpected backend spawn"); } }, resolveConfig(), new AbortController().signal, () => {});
    await assert.rejects(router.callTool(root, "detect_changes", {}, new AbortController().signal), /configuration includes or worktree overrides/);
    assert.equal(dispatched, false);
  }
  writeFileSync(join(root, ".git", "config"), "[core]\nbare = false");
  writeFileSync(join(root, ".git", "config.worktree"), "[core]\nworktree=/outside");
  assert.throws(() => prepareWorkspaceScope(root), /worktree overrides/);
});
test("per-child environment disables injected Git and ripgrep configurations", t => {
  const root = fixture(t);
  const env = prepareWorkspaceScope(root).env;
  assert.equal(env.GIT_CONFIG_COUNT, "0"); assert.equal(env.GIT_CONFIG_PARAMETERS, "");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1"); assert.equal(env.GIT_CONFIG_GLOBAL, devNull); assert.equal(env.GIT_CONFIG_SYSTEM, devNull);
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_SHALLOW_FILE", "GIT_CONFIG", "RIPGREP_CONFIG_PATH"]) {
    assert.equal(Object.hasOwn(env, key), true); assert.equal(env[key], undefined);
  }
});
