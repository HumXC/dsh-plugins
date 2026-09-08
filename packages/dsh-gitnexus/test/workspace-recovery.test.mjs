import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { prepareWorkspaceScope } from "../lib/workspace-isolation.js";
import { ManagedStdioTransport } from "../lib/managed-stdio-transport.js";
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "gitnexus-recovery-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace"), outside = join(base, "outside");
  mkdirSync(join(root, ".gitnexus"), { recursive: true }); mkdirSync(outside);
  return { root, outside };
}
test("corrupt metadata remains recoverable without registering invalid index", t => {
  const { root } = fixture(t);
  writeFileSync(join(root, ".gitnexus", "gitnexus.json"), "{broken");
  assert.deepEqual(prepareWorkspaceScope(root).repositories, []);
  writeFileSync(join(root, ".gitnexus", "gitnexus.json"), "{}");
  assert.equal(prepareWorkspaceScope(root).repositories.length, 1);
});
test("nested branch runtime symlink is validated rather than skipped", t => {
  const { root, outside } = fixture(t);
  mkdirSync(join(root, ".gitnexus", "branches"));
  symlinkSync(outside, join(root, ".gitnexus", "branches", "runtime"), "dir");
  assert.throws(() => prepareWorkspaceScope(root), /symlink|symbolic/);
});
test("Git metadata cannot point to external worktree/common storage", t => {
  const { root, outside } = fixture(t);
  writeFileSync(join(root, ".git"), "gitdir: " + outside);
  assert.throws(() => prepareWorkspaceScope(root), /outside/);
  rmSync(join(root, ".git")); mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "commondir"), outside);
  assert.throws(() => prepareWorkspaceScope(root), /outside/);
});
test("managed MCP transport forwards only explicit workspace environment overrides", async t => {
  const { root } = fixture(t), scope = prepareWorkspaceScope(root);
  let spec, settle;
  const done = new Promise(resolve => { settle = resolve; });
  const transport = new ManagedStdioTransport({ spawn(options) {
    spec = options;
    return { stdin: new PassThrough(), stdout: new PassThrough(), collected: {}, done,
      terminate() { settle({ exitCode: null, signal: "SIGTERM" }); }, waitForExit: async () => true };
  } }, { argv: ["gitnexus", "mcp"], cwd: root, env: scope.env, signal: new AbortController().signal, graceMs: 1, stderrMaxBytes: 1024 });
  await transport.start();
  assert.equal(spec.env.GITNEXUS_HOME, join(root, ".gitnexus", "runtime"));
  assert.equal(spec.env.GIT_CEILING_DIRECTORIES, dirname(root));
  assert.equal(spec.env.GIT_DIR, undefined);
  assert.equal(spec.cwd, root);
  await transport.close();
});
