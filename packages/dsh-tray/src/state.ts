/** Per-session tray attention state. Browser topology is supplied through isWatching. */

export type PendingKind = "approval" | "question" | "plan-review";

export interface TrayEvent {
    type: string;
    seq: number;
    time: number;
    reasonKind?: string | undefined;
    callId?: string | undefined;
    toolName?: string | undefined;
    approvalId?: string | undefined;
    title?: string | undefined;
}

export interface LastTurn { kind: string; seq: number; time: number }

export interface SessionState {
    id: string;
    live: boolean;
    running: boolean;
    pending: PendingKind | undefined;
    pendingCount: number;
    lastTurn: LastTurn | undefined;
    lastErrorAt: number | undefined;
    lastCompletedAt: number | undefined;
    lastViewedAt: number | undefined;
    title: string | undefined;
    titleKnown: boolean;
    cwd: string | undefined;
    updatedAt: number;
}

export type FocusLevel = 0 | 1 | 2 | 3 | 4;
export type FocusIcon = "red" | "yellow" | "blue" | "green" | "base";
export interface FocusResult { level: FocusLevel; icon: FocusIcon; session: SessionState | undefined }

export interface ViewedStoreLike {
    lastViewedAt(id: string): number | undefined;
    markViewed(id: string, at?: number): void;
}

const PENDING_TOOLS: Readonly<Record<string, PendingKind>> = {
    ask_user_question: "question",
    exit_plan_mode: "plan-review",
};

// State codes also select icons; attention priority must not renumber them.
const FOCUS_PRIORITY = [0, 2, 1, 3, 4] as const;

export function levelOf(st: SessionState): FocusLevel {
    // Running sessions intentionally use the base icon; attention dots are for actionable state.
    if (st.lastErrorAt !== undefined && st.lastErrorAt > (st.lastViewedAt ?? 0)) return 4;
    if (st.running && st.pending) return 3;
    if (st.running) return 2;
    if (st.lastCompletedAt !== undefined && st.lastCompletedAt > (st.lastViewedAt ?? 0) && !st.running) return 1;
    return 0;
}

export class SessionStateTracker {
    private readonly map = new Map<string, SessionState>();
    private readonly pending = new Map<string, Map<string, PendingKind>>();
    private readonly injectedWatching: (id: string) => boolean;
    private readonly tombstones = new Set<string>();
    private rememberTombstone(id: string): void {
        this.tombstones.add(id);
        while (this.tombstones.size > 1024) {
            this.tombstones.delete(this.tombstones.keys().next().value!);
        }
    }

    constructor(readonly viewed: ViewedStoreLike, isWatching: (id: string) => boolean = () => false) {
        this.injectedWatching = isWatching;
    }
    isWatching(id: string): boolean {
        return this.injectedWatching(id);
    }
    isRemoved(id: string): boolean {
        return this.tombstones.has(id);
    }


    private ensure(id: string): SessionState {
        let st = this.map.get(id);
        if (!st) {
            st = {
                id, live: false, running: false, pending: undefined, pendingCount: 0,
                lastTurn: undefined, lastErrorAt: undefined, lastCompletedAt: undefined,
                lastViewedAt: this.viewed.lastViewedAt(id), title: undefined, titleKnown: false, cwd: undefined, updatedAt: Date.now()
            };
            this.map.set(id, st);
        }
        return st;
    }

    private pendingFor(id: string): Map<string, PendingKind> {
        let pending = this.pending.get(id);
        if (!pending) { pending = new Map(); this.pending.set(id, pending); }
        return pending;
    }

    private recomputePending(st: SessionState): void {
        const pending = this.pending.get(st.id);
        st.pending = pending?.values().next().value as PendingKind | undefined;
        st.pendingCount = pending?.size ?? 0;
    }

    upsert(id: string, init: { live?: boolean; title?: string; titleKnown?: boolean; cwd?: string; updatedAt?: number } = {}): SessionState {
        this.tombstones.delete(id);
        const st = this.ensure(id);
        if (init.live !== undefined) st.live = init.live;
        if (init.cwd !== undefined) st.cwd = init.cwd;
        if (init.title !== undefined) { st.title = init.title; st.titleKnown = true; }
        if (init.titleKnown !== undefined) st.titleKnown = init.titleKnown;
        if (init.updatedAt !== undefined) st.updatedAt = Math.max(st.updatedAt, init.updatedAt);
        return st;
    }

    setTitle(id: string, title: string | undefined): void {
        const st = this.tombstones.has(id) ? undefined : this.ensure(id);
        if (!st) return;
        st.title = title;
        st.titleKnown = true;
        st.updatedAt = Date.now();
    }
    applyStatus(id: string, running: boolean): void {
        const st = this.tombstones.has(id) ? undefined : this.ensure(id);
        if (!st) return;
        if (st.running !== running) st.updatedAt = Date.now();
        st.running = running;
    }
    applyAgentError(id: string, time = Date.now()): void {
        const st = this.tombstones.has(id) ? undefined : this.ensure(id);
        if (!st) return;
        st.lastTurn = { kind: "error", seq: st.lastTurn?.seq ?? 0, time };
        st.lastCompletedAt = undefined;
        st.lastErrorAt = Math.max(st.lastErrorAt ?? 0, time);
        st.updatedAt = time;
    }
    ids(): string[] { return [...this.map.keys()]; }

    remove(id: string): boolean {
        this.pending.delete(id);
        this.rememberTombstone(id);
        return this.map.delete(id);
    }
    dispose(id: string): void {
        if (this.tombstones.has(id)) return;
        const st = this.map.get(id); if (!st) { this.rememberTombstone(id); return; } st.live = false; st.running = false; st.updatedAt = Date.now();
        this.rememberTombstone(id);
        this.pending.delete(id); this.recomputePending(st);
    }
    markViewed(id: string, at = Date.now()): void {
        const st = this.map.get(id); if (!st || this.tombstones.has(id)) return; st.lastViewedAt = at; this.viewed.markViewed(id, at);
    }


    applyEvent(id: string, ev: TrayEvent): void {
        const st = this.tombstones.has(id) ? undefined : this.ensure(id); if (!st) return;
        st.updatedAt = Math.max(st.updatedAt, ev.time);
        const pending = this.pendingFor(id);
        switch (ev.type) {
            case "turn/start":
                st.lastTurn = undefined; st.lastErrorAt = undefined; st.lastCompletedAt = undefined; pending.clear(); break;
            case "turn/end":
                st.lastTurn = { kind: ev.reasonKind ?? "unknown", seq: ev.seq, time: ev.time };
                st.lastCompletedAt = undefined;
                if (ev.reasonKind === "error") st.lastErrorAt = Math.max(st.lastErrorAt ?? 0, ev.time);
                else st.lastErrorAt = undefined;
                if (ev.reasonKind === "completed") { st.lastCompletedAt = ev.time; if (this.isWatching(id)) this.markViewed(id); }
                pending.clear();
                break;
            case "approval/asked": if (ev.approvalId) pending.set("a:" + ev.approvalId, "approval"); break;
            case "approval/decided": if (ev.approvalId) pending.delete("a:" + ev.approvalId); break;
            case "tool/call": if (ev.callId && ev.toolName && PENDING_TOOLS[ev.toolName]) pending.set("t:" + ev.callId, PENDING_TOOLS[ev.toolName]!); break;
            case "tool/result": if (ev.callId) pending.delete("t:" + ev.callId); break;
            case "session/title": st.title = ev.title; st.titleKnown = true; st.updatedAt = ev.time; break;
            default: break;
        }
        this.recomputePending(st);
    }

    focus(): FocusResult {
        let best: { level: FocusLevel; st: SessionState } | undefined;
        for (const st of this.map.values()) {
            const level = levelOf(st);
            if (level === 0) continue;
            if (!best || FOCUS_PRIORITY[level] > FOCUS_PRIORITY[best.level] || (level === best.level && st.updatedAt > best.st.updatedAt)) best = { level, st };
        }
        if (!best) return { level: 0, icon: "base", session: undefined };
        const icon: FocusIcon = best.level === 4 ? "red" : best.level === 3 ? "yellow" : best.level === 2 ? "base" : "green";
        return { level: best.level, icon, session: best.st };
    }

    listMenu(limit = 50): SessionState[] {
        return [...this.map.values()].map(st => ({ st, level: levelOf(st) })).filter(x => x.level > 0)
            .sort((a, b) => FOCUS_PRIORITY[b.level] - FOCUS_PRIORITY[a.level] || b.st.updatedAt - a.st.updatedAt).slice(0, limit).map(x => x.st);
    }
    get(id: string): SessionState | undefined { return this.map.get(id); }
    all(): SessionState[] { return [...this.map.values()]; }
    clear(): void { this.map.clear(); this.pending.clear(); this.tombstones.clear(); }
}
