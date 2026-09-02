/**
 * 呈现层纯函数(§7/§8):把状态机输出转换为
 *   - TraySnapshot(图标/状态/tooltip)
 *   - 菜单树(DBusMenu MenuNode)
 * 无 DBus 依赖,便于单测;图标渲染全部走 icons.ts(官方 SVG → 内存光栅化)。
 */
import { argbPixmap, type TrayIconState } from "./icons.js";
import { levelOf, type FocusResult, type SessionState } from "./state.js";
import type { MenuNode } from "./menu.js";
import type { SniStatus, TraySnapshot } from "./tray.js";

/** 图标关注点 → 人类可读状态行(tooltip/菜单共用)。 */
export function statusText(focus: Pick<FocusResult, "icon" | "session">): string {
  switch (focus.icon) {
    case "green":
      return "已完成,尚未查看";
    case "blue":
      return "运行中";
    case "yellow":
      return "需要人工介入";
    case "red":
      return "错误停止";
    default:
      return "空闲";
  }
}

export interface SnapshotOptions {
  iconSize: number;
  outline?: boolean;
  /** logo 填充色(hex)。 */
  iconColor?: string;
  /** 当前关注点状态点颜色(hex)。 */
  dotColor?: string;
}

/** 一次快照:状态点图标(多尺寸 ARGB32)+ SNI status + tooltip。 */
export function buildSnapshot(focus: FocusResult, opts: SnapshotOptions): TraySnapshot {
  const level0 = focus.level === 0;
  // 恒 "Active":waybar 隐藏 Passive;NeedsAttention 在 waybar 会触发 attention 样式(红点异常),不用
  const status: SniStatus = "Active";
  // 首帧光栅化 44px 很贵(~40ms,waybar icon-size 用不到);只发 16 + 目标尺寸
  const sizes = [...new Set([16, Math.max(16, opts.iconSize)])];
  const pixmap = argbPixmap(focus.icon, sizes, {
    ...(opts.outline === undefined ? {} : { outline: opts.outline }),
    ...(opts.iconColor !== undefined ? { iconColor: opts.iconColor } : {}),
    ...(opts.dotColor !== undefined ? { dotColor: opts.dotColor } : {}),
  });
  const title = "DeepSeek Harness";
  const body = level0
    ? "空闲 — 无活动会话"
    : statusText(focus) + " · " + (focus.session?.title ?? focus.session?.id ?? "?");
  return { status, pixmap, tooltipTitle: title, tooltipBody: body };
}

/** 会话在菜单里的状态点显示。 */
export function sessionIcon(s: SessionState): TrayIconState {
  const lv = levelOf(s);
  if (lv === 4) return "red";
  if (lv === 3) return "yellow";
  if (lv === 2) return "base"; // 运行中不显示点(用户规则)
  if (lv === 1) return "green";
  return "base";
}

/** 会话状态 → 系统主题图标名(菜单 icon-name;运行中无点 → 无图标)。 */
/** 状态图标名:本机唯一图标主题为 Adwaita,只有 symbolic(单色)形态;全组单色、图案区分状态。 */
const STATUS_ICON_NAMES: Partial<Record<TrayIconState, string>> = {
  green: "checkbox-checked-symbolic",
  yellow: "appointment-soon-symbolic",
  red: "window-close-symbolic",
};

/** 运行中的菜单图标(纯对齐用;无状态点)。 */
const RUNNING_ICON_NAME = "system-run-symbolic";

/** "未使用的会话":无标题(未命名)且无任何状态活动(空闲)——菜单里隐藏,由"新会话…"入口统一跳转。 */
export function isIdleUnused(s: SessionState): boolean {
  return !s.title && levelOf(s) === 0;
}

export function sessionMenuLabel(s: SessionState): string {
  // 未命名会话不暴露内部 id,统一显示"新会话";不加状态前缀(状态用左侧图标表达)
  return s.title || "新会话";
}

export interface MenuBuildResult {
  root: MenuNode[];
  /** 菜单 id → 承载 data(会话 id 或 "ws:<workspaceId>",供 Event 回调查找)。 */
  byId: Map<number, string>;
}

export interface WorkspaceEntry {
  id: string;
  title: string;
}

const NEW_SESSION_ID = 1;
const SEPARATOR_ID = 2;
const SESSION_START_ID = 100;

/** 构建右键菜单树。sessions 已按关注度排序;"新会话"展开为工作区子菜单。 */
export function buildMenuNodes(
  sessions: readonly SessionState[],
  opts: { workspaces?: readonly WorkspaceEntry[]; iconSize?: number } = {},
): MenuBuildResult {
  const byId = new Map<number, string>();
  let next = SESSION_START_ID;
  // 未使用的空闲会话不单独列出(重复的"新会话"会噪音化菜单);入口点击时跳转到它
  const visible = sessions.filter((s) => !isIdleUnused(s));
  const entries: MenuNode[] = visible.map((s) => {
    const id = next++;
    byId.set(id, s.id);
    const icon = sessionIcon(s);
    // 菜单里出现的非状态项 = 运行中(level0 已被 listMenu 过滤)→ 用对齐图标
    const iconName = STATUS_ICON_NAMES[icon] ?? (icon === "base" ? RUNNING_ICON_NAME : undefined);
    return {
      id,
      label: sessionMenuLabel(s),
      data: s.id,
      ...(iconName !== undefined ? { iconName } : {}),
      enabled: true,
    };
  });
  const wsChildren: MenuNode[] = (opts.workspaces ?? []).map((w) => {
    const id = next++;
    byId.set(id, "ws:" + w.id);
    return { id, label: w.title, data: "ws:" + w.id, enabled: true };
  });
  return {
    root: [
      {
        id: NEW_SESSION_ID,
        label: "新会话…",
        data: "new",
        enabled: wsChildren.length > 0,
        children: wsChildren,
      },
      // 没有可见会话时不放分隔符(只剩"新会话…")
      ...(entries.length > 0 ? [{ id: SEPARATOR_ID, label: "", separator: true, enabled: false }] : []),
      ...entries,
    ],
    byId,
  };
}

export { NEW_SESSION_ID, SEPARATOR_ID };