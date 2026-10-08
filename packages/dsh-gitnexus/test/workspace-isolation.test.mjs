import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWorkspaceRepositories, prepareWorkspaceScope, scopedToolArguments, workspacePath } from "../lib/workspace-isolation.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { resolveConfig } from "../lib/config.js";

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "gitnexus-scope-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  mkdirSync(root); mkdirSync(outside);
  return { root, outside };
}
function index(path, extra = {}) {
  mkdirSync(join(path, ".gitnexus"), { recursive: true });
  writeFileSync(join(path, ".gitnexus", "meta.json"), JSON.stringify({ indexedAt: "2026-01-01", lastCommit: "abc", stats: {}, ...extra }));
}

test("local registry includes root and indexed descendants, never imports global entries", t => {
  const { root, outside } = fixture(t);
  index(root); index(join(root, "child")); index(outside);
  const prior = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = outside;
  writeFileSync(join(outside, "registry.json"), "not even valid JSON");
  t.after(() => { if (prior === undefined) delete process.env.GITNEXUS_HOME; else process.env.GITNEXUS_HOME = prior; });
  const scope = prepareWorkspaceScope(root);
  assert.deepEqual(scope.repositories.map(r => r.path).sort(), [root, join(root, "child")].sort());
  assert.equal(scope.env.GITNEXUS_HOME, join(root, ".gitnexus", "runtime"));
  assert.equal(readFileSync(join(outside, "registry.json"), "utf8"), "not even valid JSON");
  assert.deepEqual(JSON.parse(readFileSync(join(scope.home, "registry.json"), "utf8")).map(r => r.path), scope.repositories.map(r => r.path));
});

test("fresh workspace initializes empty local registry, then discovers first index", t => {
  const { root } = fixture(t);
  assert.deepEqual(prepareWorkspaceScope(root).repositories, []);
  assert.equal(prepareWorkspaceScope(root).env.GITNEXUS_MCP_DEFAULT_REPO, undefined);
  index(root);
  assert.equal(prepareWorkspaceScope(root).repositories.length, 1);
});

test("separate workspaces do not share registry contents or homes", t => {
  const { root, outside } = fixture(t);
  index(root); index(outside);
  const a = prepareWorkspaceScope(root), b = prepareWorkspaceScope(outside);
  assert.notEqual(a.home, b.home);
  assert.equal(a.repositories[0].path, root);
  assert.equal(b.repositories[0].path, outside);
});

test("repo, worktree, and filesystem selectors reject external paths before dispatch", async t => {
  const { root, outside } = fixture(t);
  index(root); index(join(root, "child")); index(outside);
  const scope = prepareWorkspaceScope(root);
  for (const key of ["repo", "worktree", "file", "file_path", "path"]) {
    assert.throws(() => scopedToolArguments(scope, "context", { [key]: outside }), /outside|not indexed/);
  }
  assert.equal(scopedToolArguments(scope, "query", { repo: "child" }).repo, join(root, "child"));
  assert.throws(() => scopedToolArguments(scope, "query", { repo: "@group" }), /Invalid/);
  let dispatched = false;
  const router = new McpConnectionRouter({ spawn() { dispatched = true; throw new Error("Unexpected backend spawn"); } }, resolveConfig(), new AbortController().signal, () => {});
  await assert.rejects(router.callTool(root, "context", { repo: outside }, new AbortController().signal), /outside/);
  assert.equal(dispatched, false);
});

test("directory links are not discovered and outward file links are rejected", t => {
  const { root, outside } = fixture(t);
  index(root); index(outside);
  symlinkSync(outside, join(root, "linked"), "dir");
  assert.equal(discoverWorkspaceRepositories(root).length, 1);
  assert.throws(() => workspacePath(root, "linked/nonexistent.ts"), /escapes/);
  symlinkSync(join(outside, "missing"), join(root, "dangling"));
  assert.throws(() => workspacePath(root, "dangling"), /dangling/);
});

test("index and runtime symlinks cannot redirect registry or database access", t => {
  const { root, outside } = fixture(t);
  symlinkSync(outside, join(root, ".gitnexus"), "dir");
  assert.throws(() => prepareWorkspaceScope(root), /symlink|symbolic/);
  rmSync(join(root, ".gitnexus"));
  index(root);
  symlinkSync(outside, join(root, ".gitnexus", "runtime"), "dir");
  assert.throws(() => prepareWorkspaceScope(root), /symlink|symbolic/);
  assert.equal(existsSync(join(outside, "registry.json")), false);
});

test("metadata cannot smuggle external storagePath and index file symlinks fail closed", t => {
  const { root, outside } = fixture(t);
  index(root, { storagePath: outside, path: outside });
  assert.equal(prepareWorkspaceScope(root).repositories[0].storagePath, join(root, ".gitnexus"));
  writeFileSync(join(outside, "lbug"), "sensitive");
  symlinkSync(join(outside, "lbug"), join(root, ".gitnexus", "lbug"));
  assert.throws(() => prepareWorkspaceScope(root), /symlink|symbolic/);
});

test("filesystem-capable Cypher procedures fail closed", t => {
  const { root } = fixture(t); index(root);
  const scope = prepareWorkspaceScope(root);
  assert.throws(() => scopedToolArguments(scope, "cypher", { statement: "CALL read_csv('/outside')" }), /filesystem/);
  assert.equal(scopedToolArguments(scope, "cypher", { statement: "MATCH (n) RETURN n LIMIT 1" }).repo, root);
});

test("private descendants do not block accessible root and nested indexes", { skip: process.getuid?.() === 0 }, t => {
  const { root } = fixture(t);
  const privateDirectory = join(root, "runtime-data");
  index(root);
  index(join(root, "child"));
  index(privateDirectory);
  chmodSync(privateDirectory, 0o000);
  try {
    const scope = prepareWorkspaceScope(root);
    assert.deepEqual(scope.repositories.map(repo => repo.path).sort(), [root, join(root, "child")].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(scope.home, "registry.json"), "utf8")).map(repo => repo.path), scope.repositories.map(repo => repo.path));
  } finally { chmodSync(privateDirectory, 0o700); }
});

test("unreadable workspace root still fails discovery", { skip: process.getuid?.() === 0 }, t => {
  const { root } = fixture(t);
  index(root);
  chmodSync(root, 0o000);
  try {
    assert.throws(() => discoverWorkspaceRepositories(root), { code: "EACCES" });
  } finally { chmodSync(root, 0o700); }
});

test("unreadable index storage and Git metadata still fail discovery", { skip: process.getuid?.() === 0 }, t => {
  const { root } = fixture(t);
  index(root);
  const storage = join(root, ".gitnexus");
  chmodSync(storage, 0o000);
  try {
    assert.throws(() => discoverWorkspaceRepositories(root), { code: "EACCES" });
  } finally { chmodSync(storage, 0o700); }
  const git = join(root, ".git");
  mkdirSync(git);
  chmodSync(git, 0o000);
  try {
    assert.throws(() => discoverWorkspaceRepositories(root), { code: "EACCES" });
  } finally { chmodSync(git, 0o700); }
});
