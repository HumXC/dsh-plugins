/** Pure tray and DBusMenu presentation helpers. */
import { argbPixmap, type TrayIconState } from "./icons.js";
import { levelOf, type FocusResult, type SessionState } from "./state.js";
import type { MenuNode } from "./menu.js";
import type { TraySnapshot } from "./tray.js";

export function statusText(focus: Pick<FocusResult, "icon" | "session">): string {
    switch (focus.icon) {
        case "green": return "已完成,尚未查看";
        case "blue": return "运行中";
        case "yellow": return "需要人工介入";
        case "red": return "错误停止";
        default: return "空闲";
    }
}
export interface SnapshotOptions { iconSize: number; outline?: boolean; iconColor?: string; dotColor?: string }
export function buildSnapshot(focus: FocusResult, opts: SnapshotOptions): TraySnapshot {
    // Keep a small baseline pixmap to avoid an expensive 44px first-frame rasterization.
    const sizes = [...new Set([16, Math.max(16, opts.iconSize)])];
    const pixmap = argbPixmap(focus.icon, sizes, {
        ...(opts.outline === undefined ? {} : { outline: opts.outline }),
        ...(opts.iconColor === undefined ? {} : { iconColor: opts.iconColor }),
        ...(opts.dotColor === undefined ? {} : { dotColor: opts.dotColor }),
    });
    // StatusNotifier hosts such as waybar hide Passive items.
    return {
        status: "Active",
        pixmap,
        tooltipTitle: "DeepSeek Harness",
        tooltipBody: focus.level === 0
            ? "空闲 — 无活动会话"
            : statusText(focus) + " · " + (focus.session?.title ?? focus.session?.id ?? "?"),
    };
}
export function sessionIcon(s: SessionState): TrayIconState {
    const level = levelOf(s); return level === 4 ? "red" : level === 3 ? "yellow" : level === 1 ? "green" : "base";
}
const STATUS_ICON_NAMES: Partial<Record<TrayIconState, string>> = {
    green: "checkbox-checked-symbolic",
    yellow: "appointment-soon-symbolic",
    red: "window-close-symbolic",
};
const RUNNING_ICON_NAME = "system-run-symbolic";
export function isIdleUnused(s: SessionState): boolean { return s.live && s.titleKnown && !s.title && levelOf(s) === 0; }
export function sessionMenuLabel(s: SessionState): string { return s.title || (s.titleKnown ? "新会话" : "加载中…"); }

export interface MenuBuildResult { root: MenuNode[]; byId: Map<number, string> }
export interface WorkspaceEntry { id: string; title: string }
export class MenuIdRegistry {
    private readonly ids = new Map<string, number>();
    private next = 100;
    idFor(target: string): number {
        const current = this.ids.get(target); if (current !== undefined) return current;
        const id = this.next++; this.ids.set(target, id); return id;
    }
}
export const NEW_SESSION_ID = 1;
export const SEPARATOR_ID = 2;

export function buildMenuNodes(
    sessions: readonly SessionState[],
    opts: {
        workspaces?: readonly WorkspaceEntry[];
        canReuseIdle?: boolean;
        iconSize?: number;
        registry?: MenuIdRegistry;
    } = {},
): MenuBuildResult {
    const registry = opts.registry ?? new MenuIdRegistry();
    const byId = new Map<number, string>();
    byId.set(NEW_SESSION_ID, "new");
    const visible = sessions.filter(s => !isIdleUnused(s));
    const entries = visible.map(s => {
        const id = registry.idFor("session:" + s.id);
        byId.set(id, s.id);
        const icon = sessionIcon(s);
        const iconName = STATUS_ICON_NAMES[icon] ?? (icon === "base" ? RUNNING_ICON_NAME : undefined);
        return {
            id,
            label: sessionMenuLabel(s),
            data: s.id,
            ...(iconName === undefined ? {} : { iconName }),
            enabled: true,
        };
    });
    const wsChildren = (opts.workspaces ?? []).map((w) => {
        const id = registry.idFor("workspace:" + w.id);
        byId.set(id, "ws:" + w.id);
        return { id, label: w.title, data: "ws:" + w.id, enabled: true };
    });
    return {
        root: [
            {
                id: NEW_SESSION_ID,
                label: "新会话…",
                data: "new",
                enabled: wsChildren.length > 0 || opts.canReuseIdle === true,
                children: wsChildren,
            },
            ...(entries.length ? [{ id: SEPARATOR_ID, label: "", separator: true, enabled: false }] : []),
            ...entries,
        ],
        byId,
    };
}
