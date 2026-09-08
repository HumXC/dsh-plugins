import assert from "node:assert/strict";
import test from "node:test";
import { workspaceDisplayName, workspaceDisplayMessage } from "../lib/workspace-display.js";

test("workspace labels show only the name on POSIX and Windows", () => {
  for (const path of ["/home/private/project", "/home/private/project/", "C:\\Users\\private\\project\\"]) {
    assert.equal(workspaceDisplayName(path), "project");
  }
  assert.equal(workspaceDisplayName("/"), "当前工作区");
});

test("recovery diagnostics retain the error without leaking absolute paths", () => {
  const root = "/home/private/my project";
  assert.equal(workspaceDisplayMessage("Cannot open " + root + "/.gitnexus/lbug", root), "Cannot open my project/.gitnexus/lbug");
  assert.equal(workspaceDisplayMessage("ENOENT: stat '/other/private space/index'", root), "ENOENT: stat 'index'");
  assert.equal(workspaceDisplayMessage("Failed at /other/private/index"), "Failed at index");
  assert.equal(workspaceDisplayMessage("Failed at C:\\Users\\private\\index"), "Failed at index");
  assert.equal(workspaceDisplayMessage("upstream network unavailable"), "upstream network unavailable");
  assert.equal(workspaceDisplayMessage("retry http://127.0.0.1:4747"), "retry http://127.0.0.1:4747");
});
