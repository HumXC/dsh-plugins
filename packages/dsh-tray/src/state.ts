/**
 * 会话状态跟踪器(§5)。
 * 纯逻辑、零 DSH/外部依赖:输入是结构化事件 + 状态提示,由宿主(index.ts)把
 * ctx.sessions 事件流转换为 TrayEvent。这样 unit 测试不需要 cordis。
 */

/** 需要人工介入的类别。 */
export type PendingKind = "approval" | "question" | "plan-review";

/** 状态机接收的最小事件(宿主把真实 SessionEvent 折叠成这个形状)。 */
export interface TrayEvent {
  type: string;
  seq: number;
  time: number;
  /** turn/end 的 reason.kind。 */
  reasonKind?: string | undefined;
  /** tool/call 的 callId,或 tool/result 的 ToolResultBlock.toolCallId。 */
  callId?: string | undefined;
  /** tool/call 的工具名。 */
  toolName?: string | undefined;
  /** approval/asked 与 approval/decided 的配对 id。 */
  approvalId?: string | undefined;
}

export interface LastTurn {
  kind: string;
  seq: number;
  time: number;
}

export interface SessionState {
  id: string;
  live: boolean;
  running: boolean;
  /** 当前待裁决的介入点(多个时取最先)。 */
  pending: PendingKind | undefined;
  pendingCount: number;
  /** 最近一次 turn/end 的结果。 */
  lastTurn: LastTurn | undefined;
  /** 最近一次错误发生的时刻;红点需"错误晚于已查看"才亮(用户查看过即代表知情)。 */
  lastErrorAt: number | undefined;
  /** 最近一次正常完成的时刻(epoch ms);绿点提醒判定依据。 */
  lastCompletedAt: number | undefined;
  lastViewedAt: number | undefined;
  title: string | undefined;
  cwd: string | undefined;
  /** 最后状态变更时刻,用于同优先级排序。 */
  updatedAt: number;
}

/** 空前关注度:4 红 > 3 黄 > 2 蓝 > 1 绿 > 0 无。 */
export type FocusLevel = 0 | 1 | 2 | 3 | 4;
export type FocusIcon = "red" | "yellow" | "blue" | "green" | "base";

export interface FocusResult {
  level: FocusLevel;
  icon: FocusIcon;
  session: SessionState | undefined;
}

export interface ViewedStoreLike {
  lastViewedAt(id: string): number | undefined;
  markViewed(id: string, at?: number): void;
}

const PENDING_TOOLS: Readonly<Record<string, PendingKind>> = {
  ask_user_question: "question",
  exit_plan_mode: "plan-review",
};

export function levelOf(st: SessionState): FocusLevel {
  // 红点 = 存在比"已查看"更新的错误(查看过即知情,不再提示)
  if (st.lastErrorAt !== undefined && st.lastErrorAt > (st.lastViewedAt ?? 0)) return 4;
  if (st.running && st.pending) return 3;
  if (st.running) return 2;
  if (st.lastCompletedAt !== undefined && st.lastCompletedAt > (st.lastViewedAt ?? 0) && !st.running) return 1;
  return 0;
}

export class SessionStateTracker {
  private map = new Map<string, SessionState>();
  /** 未决介入点:approval 请求 id → 类别;tool:callId → 类别。 */
  private pending = new Map<string, PendingKind>();
  /** 浏览器侧"在场"状态:窗口聚焦且可见(用户正看着页面)。 */
  private presence = false;
  /** 浏览器侧"当前会话":用户正在查看的会话 id(来源 localStorage dsh.sessions.current)。 */
  private current: string | undefined;

  constructor(readonly viewed: ViewedStoreLike) {}

  /** 浏览器上报"页面被看着/离开"。 */
  setPresence(on: boolean): void {
    this.presence = on;
  }

  /** 浏览器上报"当前查看的会话"。 */
  setCurrent(id: string): void {
    this.current = id;
  }

  /** 完成瞬间的自动已读判定用:是否在场且看的就是该会话。 */
  isWatching(id: string): boolean {
    return this.presence && this.current === id;
  }

  private ensure(id: string): SessionState {
    let st = this.map.get(id);
    if (!st) {
      st = {
        id,
        live: false,
        running: false,
        pending: undefined,
        pendingCount: 0,
        lastTurn: undefined,
        lastErrorAt: undefined,
        lastCompletedAt: undefined,
        lastViewedAt: this.viewed.lastViewedAt(id),
        title: undefined,
        cwd: undefined,
        updatedAt: Date.now(),
      };
      this.map.set(id, st);
    }
    return st;
  }

  private recomputePending(st: SessionState): void {
    st.pending = this.pending.values().next().value;
  }

  /** 会话出现/复活。 */
  upsert(id: string, init: { live?: boolean; title?: string; cwd?: string; updatedAt?: number } = {}): SessionState {
    const st = this.ensure(id);
    if (init.live !== undefined) st.live = init.live;
    st.cwd = init.cwd ?? st.cwd;
    st.title = init.title ?? st.title;
    if (init.updatedAt !== undefined) st.updatedAt = Math.max(st.updatedAt, init.updatedAt);
    return st;
  }

  setTitle(id: string, title: string | undefined): void {
    const st = this.ensure(id);
    st.title = title;
    st.updatedAt = Date.now();
  }

  /** agent/status 驱动:running 翻转(权威来源)。 */
  applyStatus(id: string, running: boolean): void {
    const st = this.ensure(id);
    const changed = st.running !== running;
    st.running = running;
    if (changed) st.updatedAt = Date.now();
  }

  /** agent/error:直接红点(与 turn/end error 等价,兜底)。 */
  applyAgentError(id: string, time = Date.now()): void {
    const st = this.ensure(id);
    st.lastTurn = { kind: "error", seq: st.lastTurn?.seq ?? 0, time };
    st.lastErrorAt = Math.max(st.lastErrorAt ?? 0, time);
    st.updatedAt = time;
  }

  /** 当前跟踪的所有会话 id(供清扫对比)。 */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /** 真正移除(会话已不存在时;区别于 dispose 的保留语义)。 */
  remove(id: string): boolean {
    return this.map.delete(id);
  }

  /** 会话被 dispose(live 关闭;不清历史,持久会话仍需菜单条目)。 */
  dispose(id: string): void {
    const st = this.ensure(id);
    st.live = false;
    st.running = false;
    st.updatedAt = Date.now();
  }

  /** 托盘自身触发"已查看"记账(web 端打开不算,见 §6)。 */
  markViewed(id: string, at = Date.now()): void {
    const st = this.ensure(id);
    st.lastViewedAt = at;
    this.viewed.markViewed(id, at);
  }

  applyEvent(id: string, ev: TrayEvent): void {
    const st = this.ensure(id);
    st.updatedAt = Math.max(st.updatedAt, ev.time);
    switch (ev.type) {
      case "turn/start":
        // 新一轮启动,running 由 agent/status 权威翻转;清除上一轮结果(红点/完成)
        st.lastTurn = undefined;
        st.lastErrorAt = undefined;
        break;
      case "turn/end":
        st.lastTurn = { kind: ev.reasonKind ?? "unknown", seq: ev.seq, time: ev.time };
        if (ev.reasonKind === "error") {
          st.lastErrorAt = Math.max(st.lastErrorAt ?? 0, ev.time);
        } else {
          // 非错误结束:错误告警解除(新轮正常收敛)
          st.lastErrorAt = undefined;
        }
        if (ev.reasonKind === "completed") {
          st.lastCompletedAt = ev.time;
          // 完成瞬间用户正看着该会话(在场且当前)→ 自动已读,不亮绿点
          if (this.isWatching(id)) this.markViewed(id);
        }
        break;
      case "approval/asked":
        if (ev.approvalId) {
          this.pending.set("a:" + ev.approvalId, "approval");
          this.recomputePending(st);
        }
        break;
      case "approval/decided":
        if (ev.approvalId) {
          this.pending.delete("a:" + ev.approvalId);
        }
        break;
      case "tool/call":
        if (ev.callId && ev.toolName && PENDING_TOOLS[ev.toolName]) {
          this.pending.set("t:" + ev.callId, PENDING_TOOLS[ev.toolName]!);
        }
        break;
      case "tool/result":
        if (ev.callId) {
          this.pending.delete("t:" + ev.callId);
        }
        break;
      default:
        break;
    }
    if (ev.type === "approval/decided" || ev.type === "tool/result") this.recomputePending(st);
    if (ev.type === "approval/asked" || ev.type === "tool/call") {
      const values = [...this.pending.values()];
      st.pending = values[0];
      st.pendingCount = values.length;
    }
    if (ev.type === "approval/decided" || ev.type === "tool/result") {
      st.pending = this.pending.values().next().value;
      st.pendingCount = this.pending.size;
    }
  }

  /** 全局关注点:最高优先级会话。 */
  focus(): FocusResult {
    let best: { level: FocusLevel; st: SessionState } | undefined;
    for (const st of this.map.values()) {
      const level = levelOf(st) as FocusLevel;
      if (level === 0) continue;
      if (!best || level > best.level || (level === best.level && st.updatedAt > best.st.updatedAt)) {
        best = { level, st };
      }
    }
    if (!best) return { level: 0, icon: "base", session: undefined };
    // 运行中(level 2)不显示状态点(用户规则);完成(level 1)绿点、人工黄点、异常红点
    const icon: FocusIcon = (
      best.level === 4 ? "red" :
      best.level === 3 ? "yellow" :
      best.level === 2 ? "base" : "green"
    ) as FocusIcon;
    return { level: best.level, icon, session: best.st };
  }

  /** 菜单列表:仅"运行中 + 有事件"的会话(红>黄>运行>绿(未查看));
   *  已读且无事件的旧会话不占菜单;排序:关注度优先,再按最近变更。 */
  listMenu(limit = 50): SessionState[] {
    const all = [...this.map.values()]
      .map((st) => ({ st, level: levelOf(st) as FocusLevel }))
      .filter(({ level }) => level > 0)
      .sort((a, b) => {
        if (b.level !== a.level) return b.level - a.level;
        return b.st.updatedAt - a.st.updatedAt;
      });
    return all.slice(0, limit).map(({ st }) => st);
  }

  get(id: string): SessionState | undefined {
    return this.map.get(id);
  }

  all(): SessionState[] {
    return [...this.map.values()];
  }

  clear(): void {
    this.map.clear();
    this.pending.clear();
  }
}