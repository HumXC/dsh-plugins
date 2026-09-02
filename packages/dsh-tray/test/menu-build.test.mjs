import test from "node:test";
import assert from "node:assert/strict";
import { buildMenuNodes, NEW_SESSION_ID, SEPARATOR_ID } from "../lib/present.js";

/** 一个"可见"会话:绿点(完成未查看),保证 level > 0 进菜单。 */
function visibleSession(id) {
  return {
    id,
    live: false,
    running: false,
    pending: undefined,
    pendingCount: 0,
    lastTurn: undefined,
    lastErrorAt: undefined,
    lastCompletedAt: 5000,
    lastViewedAt: undefined,
    title: id,
    cwd: undefined,
    updatedAt: 1,
  };
}

test("无可见会话:菜单只有新会话,无分隔符", () => {
  const r = buildMenuNodes([], {});
  assert.equal(r.root.length, 1);
  assert.equal(r.root[0].id, NEW_SESSION_ID);
  assert.equal(r.root[0].separator, undefined);
});

test("有可见会话:新会话 + 分隔符 + 会话项", () => {
  const r = buildMenuNodes([visibleSession("s1")], {});
  assert.equal(r.root.length, 3);
  assert.equal(r.root[0].id, NEW_SESSION_ID);
  assert.equal(r.root[1].id, SEPARATOR_ID);
  assert.equal(r.root[1].separator, true);
  assert.equal(r.root[2].data, "s1");
});

test("会话项图标:绿=checkbox-checked-symbolic,红=window-close-symbolic,运行中=system-run-symbolic;label 无前缀", () => {
  const green = buildMenuNodes([visibleSession("g1")], {}).root[2];
  assert.equal(green.iconName, "checkbox-checked-symbolic");
  assert.equal(green.label, "g1"); // 无状态字符前缀

  const red = buildMenuNodes([{ ...visibleSession("r1"), lastErrorAt: 9000, lastCompletedAt: undefined }], {}).root[2];
  assert.equal(red.iconName, "window-close-symbolic");

  const running = buildMenuNodes([{ ...visibleSession("b1"), running: true, lastCompletedAt: undefined }], {}).root[2];
  assert.equal(running.iconName, "system-run-symbolic");
  assert.equal(running.label, "b1");
});