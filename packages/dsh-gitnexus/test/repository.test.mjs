import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceRoute } from "../lib/repository.js";

test("does not ascend to an ancestor GitNexus index", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-route-"));
  try {
    mkdirSync(join(root, ".gitnexus"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(resolveWorkspaceRoute(nested), {
      cwd: nested,
      root: nested,
      hasIndex: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not escape a git root to use an indexed parent directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "dsh-gitnexus-route-"));
  try {
    mkdirSync(join(parent, ".gitnexus"));
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, ".git"), "gitdir: elsewhere");
    const nested = join(root, "src");
    mkdirSync(nested);

    assert.deepEqual(resolveWorkspaceRoute(nested), {
      cwd: nested,
      root: nested,
      hasIndex: false,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("does not ascend to a parent git root", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-route-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: elsewhere");
    const nested = join(root, "src");
    mkdirSync(nested);

    const route = resolveWorkspaceRoute(nested);
    assert.equal(route.root, nested);
    assert.equal(route.hasIndex, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
