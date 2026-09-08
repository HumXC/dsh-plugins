/** Authenticated tray controller; navigation uses the shared Gateway stream carrier. */
import type { Context } from "@deepseek-ai/cordis";
import type { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import type { TrayNavigationFrame } from "./remote-types.js";
import type {} from "../lib/typert.remote-client.js";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import {
    ENDPOINTS, TRAY_RPC_CHANNEL, type NavigationIntent, type NavigationAck,
} from "./rpc.js";

export type ClientContext = Context & { sessions: ISessions; connection: { rpc: ClientConnectionRpc } };
const READY_TIMEOUT_MS = 8_000;
const MAX_COMPLETED = 128;
const COMPLETED_TTL_MS = 120_000;

function newId(prefix: string): string {
    const uuid = globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    return prefix + "-" + uuid;
}

function currentId(sessions: ISessions): string | null {
    const snapshot = sessions.list.getSnapshot() as { current?: unknown } | undefined;
    return typeof snapshot?.current === "string" ? snapshot.current : null;
}

function ready(sessions: ISessions, signal: AbortSignal): Promise<boolean> {
    const list = sessions.list;
    const snapshot = list.getSnapshot() as { phase?: unknown } | undefined;
    if (snapshot?.phase === "ready") return Promise.resolve(true);
    return new Promise(resolve => {
        let complete = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: () => void = () => { };
        const abort = () => finish(false);
        const finish = (readyState: boolean): void => {
            if (complete) return;
            complete = true;
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            unsubscribe();
            resolve(readyState);
        };
        if (signal.aborted) { finish(false); return; }
        signal.addEventListener("abort", abort, { once: true });
        unsubscribe = list.subscribe(() => {
            const phase = (list.getSnapshot() as { phase?: unknown } | undefined)?.phase;
            if (phase === "ready") finish(true);
        });
        if (complete) { unsubscribe(); return; }
        timer = setTimeout(() => finish(false), READY_TIMEOUT_MS);
    });
}

function truncateUtf8(value: string, maxBytes = 512): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).byteLength <= maxBytes) return value;
    let end = value.length;
    while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > maxBytes) end -= 1;
    return value.slice(0, end);
}

export interface ClientRuntime {
    streamEnded(): Error;
    document: {
        visibilityState: string;
        hasFocus(): boolean;
        addEventListener(event: string, listener: () => void): void;
        removeEventListener(event: string, listener: () => void): void;
    };
    addEventListener(event: string, listener: () => void): void;
    removeEventListener(event: string, listener: () => void): void;
}

export interface ClientController { clientId: string; dispose(): Promise<void> }
export function createClientController(ctx: ClientContext, runtime: ClientRuntime): ClientController {
    const clientId = newId("tab");
    const completed = new Map<string, { ack: NavigationAck; completedAt: number }>();
    const inFlight = new Set<string>();
    const abort = new AbortController();
    let disposed = false;
    let presenceQueue: Promise<boolean> = Promise.resolve(true);
    let presenceInFlight = false;
    let presenceDirty = false;
    let presenceForced = false;
    let lastPresence: ReturnType<typeof snapshot> | undefined;
    let unsubscribe: (() => void) | undefined;
    let navigationStream: RemoteStream<TrayNavigationFrame> | undefined;
    const heartbeatTimer = setInterval(() => sendPresence(true), 20_000);

    const pruneCompleted = (now = Date.now()): void => {
        for (const [id, entry] of completed) if (now - entry.completedAt >= COMPLETED_TTL_MS) completed.delete(id);
        while (completed.size > MAX_COMPLETED) completed.delete(completed.keys().next().value!);
    };
    const snapshot = (): { clientId: string; focused: boolean; visible: boolean; currentSessionId: string | null } => ({
        clientId, focused: runtime.document.hasFocus(), visible: runtime.document.visibilityState === "visible", currentSessionId: currentId(ctx.sessions),
    });
    const sendPresence = (force = false): Promise<boolean> => {
        if (disposed) return presenceQueue;
        presenceDirty = true;
        presenceForced ||= force;
        if (presenceInFlight) return presenceQueue;
        presenceInFlight = true;
        presenceQueue = (async () => {
            let result = true;
            while (presenceDirty && !disposed) {
                presenceDirty = false;
                const current = snapshot();
                const forced = presenceForced;
                presenceForced = false;
                if (!forced && lastPresence &&
                    current.focused === lastPresence.focused &&
                    current.visible === lastPresence.visible &&
                    current.currentSessionId === lastPresence.currentSessionId) continue;
                try {
                    const response = await ctx.connection.rpc.call(TRAY_RPC_CHANNEL, ENDPOINTS.presenceUpdate, current, abort.signal);
                    result = response.ok;
                    lastPresence = response.ok ? current : undefined;
                } catch { result = false; lastPresence = undefined; }
            }
            presenceInFlight = false;
            return result;
        })();
        return presenceQueue;
    };
    const acknowledge = (ack: NavigationAck): void => {
        void ctx.connection.rpc.call(TRAY_RPC_CHANNEL, ENDPOINTS.navigationAck, ack).catch(() => undefined);
    };
    const execute = async (intent: NavigationIntent): Promise<void> => {
        pruneCompleted();
        if (inFlight.has(intent.intentId)) return;
        const previous = completed.get(intent.intentId);
        if (previous) { acknowledge(previous.ack); return; }
        inFlight.add(intent.intentId);
        let completion: NavigationAck | undefined;
        try {
            if (!(await ready(ctx.sessions, abort.signal))) throw new Error("session controller did not become ready before navigation timeout");
            if (disposed) return;
            if (intent.type === "session") {
                ctx.sessions.open(intent.sessionId as SessionId);
                if (disposed) return;
                completion = { clientId, intentId: intent.intentId, outcome: "success", sessionId: intent.sessionId };
                acknowledge(completion);
            } else {
                const id = await ctx.sessions.create({ workspaceId: intent.workspaceId as WorkspaceId, sessionId: intent.sessionId as SessionId });
                if (disposed) return;
                if (String(id) !== intent.sessionId) throw new Error("session controller returned a different preallocated id");
                if (disposed) return;
                ctx.sessions.open(id);
                if (disposed) return;
                completion = { clientId, intentId: intent.intentId, outcome: "success", sessionId: String(id) };
                acknowledge(completion);
            }
        } catch (error) {
            if (disposed) return;
            const message = error instanceof Error && error.message ? error.message : "navigation failed";
            completion = { clientId, intentId: intent.intentId, outcome: "failure", message: truncateUtf8(message) };
            acknowledge(completion);
        } finally {
            inFlight.delete(intent.intentId);
            if (!disposed && completion) { completed.set(intent.intentId, { ack: completion, completedAt: Date.now() }); pruneCompleted(); sendPresence(); }
        }
    };
    const consumeNavigation = async (): Promise<void> => {
        try {
            navigationStream = ctx.remote.$stream<TrayNavigationFrame>({
                name: "dsh-tray",
                open: signal => ctx.remote.trayNavigation.watch(snapshot(), signal),
                ended: () => runtime.streamEnded(),
            });
            let readyGeneration: number | undefined;
            for await (const item of navigationStream) {
                if (disposed) return;
                if (item.signal.aborted) continue;
                if (item.value.type === "ready") {
                    readyGeneration = item.generation;
                    item.accept();
                    void sendPresence(true);
                } else {
                    if (readyGeneration !== item.generation) throw new Error("Tray navigation arrived before registration");
                    await execute(item.value.intent);
                }
            }
        } catch (error) {
            if (!disposed) console.error("[dsh-tray] navigation stream failed:", error);
        }
    };
    const listeners = ["focus", "blur"] as const;
    const presenceChanged = (): void => { void sendPresence(); };
    for (const event of listeners) runtime.addEventListener(event, presenceChanged);
    runtime.document.addEventListener("visibilitychange", presenceChanged);
    unsubscribe = ctx.sessions.list.subscribe(presenceChanged);
    void consumeNavigation();
    let disposePromise: Promise<void> | undefined;

    const dispose = (): Promise<void> => {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
            if (disposed) return;
            disposed = true; abort.abort(); clearInterval(heartbeatTimer);
            const sessionListUnsubscribe = unsubscribe;
            unsubscribe = undefined;
            sessionListUnsubscribe?.();
            for (const event of listeners) runtime.removeEventListener(event, presenceChanged);
            runtime.document.removeEventListener("visibilitychange", presenceChanged);
            inFlight.clear(); completed.clear();
            try {
                await navigationStream?.dispose();
            } finally {
                await presenceQueue;
                try { await ctx.connection.rpc.call(TRAY_RPC_CHANNEL, ENDPOINTS.presenceDisconnect, { clientId }); } catch { /* best effort on unload */ }
            }
        })();
        return disposePromise;
    };
    return { clientId, dispose };
}
