import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveWorkspaceRoute } from "../lib/repository.js";

test("prefers the nearest ancestor with a GitNexus index", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-route-"));
  try {
    mkdirSync(join(root, ".gitnexus"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    assert.deepEqual(resolveWorkspaceRoute(nested), {
      cwd: nested,
      root,
      hasIndex: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the git root when no GitNexus index exists", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-route-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: elsewhere");
    const nested = join(root, "src");
    mkdirSync(nested);

    const route = resolveWorkspaceRoute(nested);
    assert.equal(route.root, root);
    assert.equal(route.hasIndex, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
