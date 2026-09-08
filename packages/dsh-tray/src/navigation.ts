import { type ClientId, type IntentId, type NavigationAck, type NavigationIntent, type NavigationNextResult, failure, ok, type RpcResult } from "./rpc.js";
type Clock = () => number;
export type NavigationTarget =
    | { type: "session"; sessionId: string }
    | { type: "new-session"; workspaceId: string; sessionId: string };
export const MAX_CLIENTS = 32;
export const CLIENT_TTL_MS = 45_000;
export const MAX_INTENTS = 64;
export const INTENT_TTL_MS = 60_000;
export const WAIT_TIMEOUT_MS = 25_000;
export const LAUNCH_COOLDOWN_MS = 10_000;
export const IDLE_RETRY_MS = 250;

interface Waiter { resolve: (result: RpcResult<NavigationNextResult>) => void; timer: ReturnType<typeof setTimeout>; onAbort?: (() => void) | undefined }
interface ClientRecord {
    clientId: ClientId; focused: boolean; visible: boolean; currentSessionId: string | null;
    registeredAt: number; lastActivityAt: number; lastSeenAt: number;
    // Navigation traffic proves connectivity, not that the user is still watching.
    lastPresenceAt: number;
    waiter?: Waiter | undefined;
}
export interface NavigationRecord {
    intentId: IntentId; target: NavigationTarget;
    state: "pending" | "delivered" | "acknowledged" | "expired";
    createdAt: number; expiresAt: number; deliveredTo?: ClientId; deliveredAt?: number; launchAttemptedAt?: number;
    outcome?: NavigationAck;
}
export interface NavigationBrokerOptions {
    now?: Clock;
    launch?: (intent: NavigationRecord) => void | Promise<void>;
    maxClients?: number;
    clientTtlMs?: number;
    maxIntents?: number;
    intentTtlMs?: number;
    waitTimeoutMs?: number;
    launchCooldownMs?: number;
}


export class NavigationBroker {
    private readonly clients = new Map<ClientId, ClientRecord>();
    private readonly intents = new Map<IntentId, NavigationRecord>();
    private readonly now: Clock;
    private readonly opts: Required<
        Pick<
            NavigationBrokerOptions,
            "maxClients" | "clientTtlMs" | "maxIntents" | "intentTtlMs" | "waitTimeoutMs" | "launchCooldownMs"
        >
    >;
    private readonly launch: ((intent: NavigationRecord) => void | Promise<void>) | undefined;
    private lastLaunchAt = -Infinity;
    private disposed = false;
    private launchTimer: ReturnType<typeof setTimeout> | undefined;
    private expiryTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(options: NavigationBrokerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.launch = options.launch;
        this.opts = {
            maxClients: options.maxClients ?? MAX_CLIENTS, clientTtlMs: options.clientTtlMs ?? CLIENT_TTL_MS,
            maxIntents: options.maxIntents ?? MAX_INTENTS, intentTtlMs: options.intentTtlMs ?? INTENT_TTL_MS,
            waitTimeoutMs: options.waitTimeoutMs ?? WAIT_TIMEOUT_MS, launchCooldownMs: options.launchCooldownMs ?? LAUNCH_COOLDOWN_MS,
        };
    }
    private scheduleClientExpiry(): void {
        if (this.expiryTimer) clearTimeout(this.expiryTimer);
        const earliest = [...this.clients.values()].reduce((value, client) => Math.min(value, client.lastSeenAt + this.opts.clientTtlMs + 1), Infinity);
        if (!Number.isFinite(earliest) || this.disposed) { this.expiryTimer = undefined; return; }
        this.expiryTimer = setTimeout(() => {
            this.expiryTimer = undefined;
            this.prune();
            this.dispatch();
            this.maybeLaunch(this.pendingForLaunch());
            this.scheduleClientExpiry();
        }, Math.max(1, earliest - this.now()));
    }

    private prune(): void {
        const now = this.now();
        for (const [id, client] of this.clients) {
            if (now - client.lastSeenAt > this.opts.clientTtlMs) {
                this.cancelWait(client, failure("tray/client-expired", "Client presence expired"));
                this.clients.delete(id);
            }
        }
        for (const [id, intent] of this.intents) {
            if ((intent.state === "pending" || intent.state === "delivered") && intent.expiresAt <= now) intent.state = "expired";
            if (intent.state === "expired") this.intents.delete(id);
        }
    }

    register(
        update: { clientId: ClientId; focused: boolean; visible: boolean; currentSessionId: string | null },
    ): RpcResult<{ accepted: true; serverTime: number; presenceTtlMs: number }> {
        this.prune();
        if (this.disposed) return failure("tray/disposed", "Tray is shutting down");
        const now = this.now();
        let client = this.clients.get(update.clientId);
        if (!client) {
            if (this.clients.size >= this.opts.maxClients) return failure("tray/client-capacity", "Browser client capacity reached");
            client = { ...update, registeredAt: now, lastActivityAt: now, lastSeenAt: now, lastPresenceAt: now };
            this.clients.set(update.clientId, client);
        } else {
            if (
                client.focused !== update.focused ||
                client.visible !== update.visible ||
                client.currentSessionId !== update.currentSessionId
            ) {
                client.lastActivityAt = now;
            }
            client.focused = update.focused;
            client.visible = update.visible;
            client.currentSessionId = update.currentSessionId;
            client.lastSeenAt = now;
            client.lastPresenceAt = now;
        }
        this.scheduleClientExpiry();
        this.dispatch();
        return ok({ accepted: true, serverTime: now, presenceTtlMs: this.opts.clientTtlMs });
    }

    disconnect(clientId: ClientId): RpcResult<{ removed: boolean }> {
        this.prune();
        const client = this.clients.get(clientId);
        if (!client) return ok({ removed: false });
        this.cancelWait(client, failure("tray/client-disconnected", "Client disconnected"));
        this.clients.delete(clientId);
        this.scheduleClientExpiry();
        this.dispatch(); this.maybeLaunch(this.pendingForLaunch());
        return ok({ removed: true });
    }

    isWatching(sessionId: string): boolean {
        this.prune();
        const now = this.now();
        return [...this.clients.values()].some(c => c.visible && c.focused && c.currentSessionId === sessionId
            && now - c.lastPresenceAt <= this.opts.clientTtlMs);
    }

    private rank(a: ClientRecord, b: ClientRecord): number {
        const bucket = (c: ClientRecord) => c.focused && c.visible ? 2 : c.visible ? 1 : 0;
        return bucket(b) - bucket(a) || b.lastActivityAt - a.lastActivityAt || b.registeredAt - a.registeredAt || a.clientId.localeCompare(b.clientId);
    }

    private pendingForLaunch(): NavigationRecord | undefined {
        this.prune();
        return [...this.intents.values()]
            .filter((i) => i.state === "pending" && i.launchAttemptedAt === undefined)
            .sort((a, b) => a.createdAt - b.createdAt || a.intentId.localeCompare(b.intentId))[0];
    }

    private pending(): NavigationRecord | undefined {
        this.prune();
        return [...this.intents.values()]
            .filter((i) => i.state === "pending")
            .sort((a, b) => a.createdAt - b.createdAt || a.intentId.localeCompare(b.intentId))[0];
    }

    private cancelWait(client: ClientRecord, result: RpcResult<NavigationNextResult>): void {
        const waiter = client.waiter;
        if (!waiter) return;
        clearTimeout(waiter.timer); waiter.onAbort?.(); client.waiter = undefined; waiter.resolve(result);
    }

    private dispatch(): void {
        if (this.disposed) return;
        const intent = this.pending();
        if (!intent) return;
        const clients = [...this.clients.values()].filter(c => c.waiter && this.now() - c.lastSeenAt <= this.opts.clientTtlMs).sort((a, b) => this.rank(a, b));
        const client = clients[0];
        if (!client?.waiter) return;
        intent.state = "delivered"; intent.deliveredTo = client.clientId; intent.deliveredAt = this.now();
        const result = ok<NavigationNextResult>({ kind: "intent", intent: { intentId: intent.intentId, ...intent.target } as NavigationIntent });
        this.cancelWait(client, result);
    }

    private maybeLaunch(intent: NavigationRecord | undefined): void {
        if (!intent || !this.launch || intent.state !== "pending" || intent.launchAttemptedAt !== undefined) return;
        this.prune();
        const eligible = [...this.clients.values()].some(c => this.now() - c.lastSeenAt <= this.opts.clientTtlMs);
        if (eligible) { if (this.launchTimer) { clearTimeout(this.launchTimer); this.launchTimer = undefined; } return; }
        const now = this.now();
        const wait = Math.max(0, this.lastLaunchAt + this.opts.launchCooldownMs - now);
        if (wait > 0) {
            if (!this.launchTimer) this.launchTimer = setTimeout(() => { this.launchTimer = undefined; this.maybeLaunch(this.pendingForLaunch()); }, wait);
            return;
        }
        intent.launchAttemptedAt = now; this.lastLaunchAt = now;
        void Promise.resolve(this.launch(intent)).catch(() => { /* launch is terminal for this intent; explicit retry is required */ });
    }

    enqueue(target: NavigationTarget, intentId: IntentId, at = this.now()): RpcResult<NavigationRecord> {
        this.prune();
        if (this.disposed) return failure("tray/disposed", "Tray is shutting down");
        if (this.intents.size >= this.opts.maxIntents) {
            const completed = [...this.intents.values()].filter(i => i.state === "acknowledged").sort((a, b) => a.createdAt - b.createdAt)[0];
            if (completed) this.intents.delete(completed.intentId);
        }
        if (this.intents.size >= this.opts.maxIntents) return failure("tray/intent-capacity", "Navigation intent capacity reached");
        if (this.intents.has(intentId)) return failure("tray/duplicate-intent", "Navigation intent already exists");
        const intent: NavigationRecord = { intentId, target, state: "pending", createdAt: at, expiresAt: at + this.opts.intentTtlMs };
        this.intents.set(intentId, intent); this.dispatch(); this.maybeLaunch(intent); return ok(intent);
    }

    next(clientId: ClientId, signal?: AbortSignal): Promise<RpcResult<NavigationNextResult>> {
        this.prune();
        if (this.disposed) return Promise.resolve(failure("tray/disposed", "Tray is shutting down"));
        const client = this.clients.get(clientId);
        if (!client) return Promise.resolve(failure("tray/client-not-registered", "Register presence before waiting"));
        if (client.waiter) return Promise.resolve(failure("tray/duplicate-wait", "Client already has a navigation wait"));
        client.lastSeenAt = this.now();
        this.scheduleClientExpiry();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                if (client.waiter !== waiter) return;
                client.waiter = undefined;
                waiter.onAbort?.();
                resolve(ok({ kind: "idle", retryAfterMs: IDLE_RETRY_MS }));
            }, this.opts.waitTimeoutMs);
            const waiter: Waiter = { resolve, timer };
            if (signal) {
                const abort = () => {
                    if (client.waiter !== waiter) return;
                    client.waiter = undefined;
                    clearTimeout(timer);
                    resolve(failure("tray/cancelled", "Navigation wait cancelled"));
                };
                if (signal.aborted) {
                    clearTimeout(timer);
                    resolve(failure("tray/cancelled", "Navigation wait cancelled"));
                    return;
                }
                signal.addEventListener("abort", abort, { once: true });
                waiter.onAbort = () => signal.removeEventListener("abort", abort);
            }
            client.waiter = waiter; this.dispatch();
        });
    }

    ack(ack: NavigationAck): RpcResult<{ accepted: true }> {
        this.prune();
        const intent = this.intents.get(ack.intentId);
        if (!intent) return failure("tray/unknown-intent", "Unknown or expired intent");
        if (intent.deliveredTo !== ack.clientId) return failure("tray/not-owner", "Client does not own intent");
        if (intent.state === "acknowledged") return failure("tray/already-acknowledged", "Intent is already acknowledged");
        if (intent.state !== "delivered") return failure("tray/unknown-intent", "Intent is not deliverable");
        intent.state = "acknowledged"; intent.outcome = ack; return ok({ accepted: true });
    }

    get(intentId: IntentId): NavigationRecord | undefined { this.prune(); return this.intents.get(intentId); }
    clientsSnapshot(): ReadonlyArray<Readonly<ClientRecord>> { this.prune(); return [...this.clients.values()]; }
    intentsSnapshot(): ReadonlyArray<Readonly<NavigationRecord>> { this.prune(); return [...this.intents.values()]; }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const client of this.clients.values()) this.cancelWait(client, failure("tray/disposed", "Tray is shutting down"));
        this.clients.clear();
        this.intents.clear();
        if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
        if (this.launchTimer) clearTimeout(this.launchTimer); this.launchTimer = undefined;
    }
}
