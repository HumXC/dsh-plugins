import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SessionStateTracker } = require("../lib/state.js");

function makeViewed() {
  const map = new Map();
  return {
    lastViewedAt: (id) => map.get(id),
    markViewed: (id, at) => map.set(id, at),
    _map: map,
  };
}

function ev(type, over = {}) {
  return { type, seq: 1, time: 1000, ...over };
}

test("完成未查看 → 绿点(level 1);markViewed 后消失", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("s1", ev("turn/end", { reasonKind: "completed", time: 5000 }));
  let f = t.focus();
  assert.equal(f.icon, "green");
  assert.equal(f.session.id, "s1");
  t.markViewed("s1", 6000);
  f = t.focus();
  assert.equal(f.icon, "base");
  assert.equal(f.level, 0);
});

test("running → 不显示点(level 2 → base);pending → 黄点(level 3)", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("s1", ev("turn/start"));
  t.applyStatus("s1", true);
  assert.equal(t.focus().icon, "base"); // 运行中不显示点
  t.applyEvent("s1", ev("approval/asked", { approvalId: "a1", toolName: "fs_edit", time: 2000 }));
  assert.equal(t.focus().icon, "yellow");
  assert.equal(t.focus().session.pending, "approval");
  t.applyEvent("s1", ev("approval/decided", { approvalId: "a1", time: 3000 }));
  assert.equal(t.focus().icon, "base"); // 运行中不显示点
});

test("ask_user_question 未回 → 黄点;tool/result 配对清除", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("s1", ev("tool/call", { callId: "c1", toolName: "ask_user_question", time: 4000 }));
  t.applyStatus("s1", true);
  assert.equal(t.focus().icon, "yellow");
  assert.equal(t.focus().session.pending, "question");
  t.applyEvent("s1", ev("tool/result", { callId: "c1", time: 5000 }));
  assert.equal(t.focus().icon, "base"); // 运行中不显示点
});

test("turn/end error → 红点(level 4,优先于 running/黄)", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyStatus("s1", true);
  t.applyEvent("s1", ev("approval/asked", { approvalId: "a1", toolName: "x", time: 2000 }));
  t.applyEvent("s1", ev("turn/end", { reasonKind: "error", time: 3000 }));
  const f = t.focus();
  assert.equal(f.icon, "red");
  assert.equal(f.level, 4);
  assert.equal(f.session.lastTurn.kind, "error");
});

test("turn/start 清除上一轮结果(红点消失)", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("s1", ev("turn/end", { reasonKind: "error", time: 1000 }));
  assert.equal(t.focus().icon, "red");
  t.applyEvent("s1", ev("turn/start", { time: 2000 }));
  t.applyStatus("s1", true);
  assert.equal(t.focus().icon, "base"); // 运行中不显示点
  assert.equal(t.focus().session.lastTurn, undefined);
});

test("多会话选取最高优先级且同级别选最近变更", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("green", ev("turn/end", { reasonKind: "completed", time: 5000 }));
  t.applyEvent("blue", ev("turn/start", { time: 6000 }));
  t.applyStatus("blue", true);
  t.applyEvent("yellow", ev("turn/start", { time: 7000 }));
  t.applyStatus("yellow", true);
  t.applyEvent("yellow", ev("approval/asked", { approvalId: "a1", toolName: "tool", time: 7001 }));
  // yellow 会话最近变化应胜出
  assert.equal(t.focus().icon, "yellow");
  assert.equal(t.focus().session.id, "yellow");
  // 黄消失后 → 蓝
  t.applyEvent("yellow", ev("approval/decided", { approvalId: "a1", time: 9000 }));
  assert.equal(t.focus().icon, "base"); // 运行中不显示点
});

test("menu 仅含运行中 + 有事件会话:红 > 黄 > 蓝(运行) > 绿(未查看);已读空闲会话不进菜单", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyEvent("s-red", ev("turn/end", { reasonKind: "error", time: 1000 }));
  t.applyEvent("s-green", ev("turn/end", { reasonKind: "completed", time: 1000 }));
  t.applyEvent("s-blue", ev("turn/start", { time: 1000 }));
  t.applyStatus("s-blue", true);
  t.applyEvent("s-yellow", ev("turn/start", { time: 1000 }));
  t.applyStatus("s-yellow", true);
  t.applyEvent("s-yellow", ev("approval/asked", { approvalId: "a", toolName: "tool", time: 1500 }));
  // 已读且不运行的完成会话:不应出现在菜单
  t.applyEvent("s-done-viewed", ev("turn/end", { reasonKind: "completed", time: 1000 }));
  t.markViewed("s-done-viewed", 9000);
  let ids = t.listMenu().map((s) => s.id);
  assert.deepEqual(ids, ["s-red", "s-yellow", "s-blue", "s-green"]);
  // 重新运行(applyStatus true → running):重新出现在菜单;
  // 同步等待 5ms 保证其 updatedAt 严格晚于同级会话,运行组内按最近变更优先
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  t.applyStatus("s-done-viewed", true);
  ids = t.listMenu().map((s) => s.id);
  assert.deepEqual(ids, ["s-red", "s-yellow", "s-done-viewed", "s-blue", "s-green"]);
});

test("完成瞬间用户正看该会话(在场+当前)→ 自动已读,不亮绿点", () => {
  const t = new SessionStateTracker(makeViewed());
  t.setPresence(true);
  t.setCurrent("s1");
  t.applyEvent("s1", ev("turn/end", { reasonKind: "completed", time: 5000 }));
  assert.equal(t.focus().level, 0);
  assert.equal(t.focus().icon, "base");
});

test("完成时不在场 → 绿点;在场但看着别的会话 → 该会话仍绿", () => {
  const t = new SessionStateTracker(makeViewed());
  t.setPresence(false);
  t.applyEvent("s1", ev("turn/end", { reasonKind: "completed", time: 5000 }));
  assert.equal(t.focus().icon, "green");
  // 在场但看着别的会话:s2 完成且用户正看 s2 → s2 自动已读;s1 保持绿
  t.setPresence(true);
  t.setCurrent("s2");
  t.applyEvent("s2", ev("turn/end", { reasonKind: "completed", time: 6000 }));
  assert.equal(t.focus().icon, "green");
  assert.equal(t.focus().session.id, "s1");
  // 之后用户切回 s1 查看(打开上报路径,等同 setCurrent + markViewed)→ 绿消
  t.setCurrent("s1");
  t.markViewed("s1", 7000);
  assert.equal(t.focus().icon, "base");
});

test("isWatching:presence+current 同时满足才为真", () => {
  const t = new SessionStateTracker(makeViewed());
  assert.equal(t.isWatching("s1"), false);
  t.setPresence(true);
  assert.equal(t.isWatching("s1"), false);
  t.setCurrent("s1");
  assert.equal(t.isWatching("s1"), true);
  t.setPresence(false);
  assert.equal(t.isWatching("s1"), false);
});

test("agent/error 兜底红点", () => {
  const t = new SessionStateTracker(makeViewed());
  t.applyAgentError("s1", 1234);
  assert.equal(t.focus().icon, "red");
});

test("查看过的错误会话不再红(红点需错误晚于已查看)", () => {
  const viewed = { lastViewedAt: () => undefined, markViewed: () => {} };
  const tr = new SessionStateTracker(viewed);
  tr.applyEvent("s-e", { type: "turn/end", seq: 1, time: 1000, reasonKind: "error" });
  assert.equal(tr.focus().level, 4, "新错误 → 红");
  tr.markViewed("s-e", 2000);
  assert.equal(tr.focus().level, 0, "查看后红点消失");
  tr.applyEvent("s-e", { type: "turn/end", seq: 2, time: 3000, reasonKind: "error" });
  assert.equal(tr.focus().level, 4, "查看后又出错 → 再红");
  tr.applyEvent("s-e", { type: "turn/start", seq: 3, time: 4000 });
  assert.equal(tr.focus().level, 0, "新一轮开始清除红点");
});