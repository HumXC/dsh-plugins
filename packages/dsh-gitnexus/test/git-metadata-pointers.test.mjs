import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkspaceScope } from "../lib/workspace-isolation.js";
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "gitnexus-pointers-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace"), outside = join(base, "outside");
  mkdirSync(join(root, ".git", "objects", "info"), { recursive: true });
  mkdirSync(join(root, ".git", "refs")); mkdirSync(join(root, ".gitnexus")); mkdirSync(outside);
  writeFileSync(join(root, ".gitnexus", "meta.json"), "{}");
  writeFileSync(join(outside, "secret"), "outside");
  return { root, outside };
}
test("Git index HEAD refs and object links cannot escape the workspace", t => {
  const { root, outside } = fixture(t);
  for (const entry of ["index", "HEAD", "refs/external", "objects/external"]) {
    const link = join(root, ".git", entry);
    symlinkSync(join(outside, "secret"), link);
    assert.throws(() => prepareWorkspaceScope(root), /escapes/);
    rmSync(link);
  }
});
test("alternate object-store chains are recursively scoped and quoted pointers rejected", t => {
  const { root, outside } = fixture(t);
  const alternate = join(root, "cache", "objects");
  mkdirSync(join(alternate, "info"), { recursive: true });
  writeFileSync(join(root, ".git", "objects", "info", "alternates"), alternate);
  writeFileSync(join(alternate, "info", "alternates"), outside);
  assert.throws(() => prepareWorkspaceScope(root), /outside/);
  writeFileSync(join(alternate, "info", "alternates"), JSON.stringify(outside));
  assert.throws(() => prepareWorkspaceScope(root), /Unsupported quoted/);
});
test("contained metadata aliases and alternate cycles terminate safely", t => {
  const { root } = fixture(t);
  const alternate = join(root, "cache", "objects");
  mkdirSync(join(alternate, "info"), { recursive: true });
  symlinkSync(join(root, ".git"), join(root, ".git", "refs", "cycle"), "dir");
  writeFileSync(join(root, ".git", "objects", "info", "alternates"), alternate);
  writeFileSync(join(alternate, "info", "alternates"), join(root, ".git", "objects"));
  assert.equal(prepareWorkspaceScope(root).repositories.length, 1);
});
