import test from "node:test";
import assert from "node:assert/strict";
import { buildMenuNodes, MenuIdRegistry, NEW_SESSION_ID, SEPARATOR_ID } from "../lib/present.js";

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
    assert.equal(r.byId.get(NEW_SESSION_ID), "new");
    assert.equal(r.root[0].separator, undefined);
});

test("idle reusable session keeps new-session action enabled", () => {
    const idle = { ...visibleSession("idle"), title: "", lastCompletedAt: undefined };
    const r = buildMenuNodes([idle], { canReuseIdle: true });
    assert.equal(r.root[0].enabled, true);
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

test("semantic menu IDs remain stable across reorder", () => {
    const registry = new MenuIdRegistry();
    const first = buildMenuNodes([visibleSession("a"), visibleSession("b")], { registry });
    const second = buildMenuNodes([visibleSession("b"), visibleSession("a")], { registry });
    const idA = first.root.find(n => n.data === "a").id;
    const idAgain = second.root.find(n => n.data === "a").id;
    assert.equal(idAgain, idA);
});