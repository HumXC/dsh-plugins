/** Authenticated tray RPC wire contract: presence registration and bounded navigation delivery. */
import type { ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";

export const TRAY_RPC_CHANNEL = "/dsh-tray";
export const ENDPOINTS = {
    presenceUpdate: "presence/update",
    presenceDisconnect: "presence/disconnect",
    navigationAck: "navigation/ack",
} as const;

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];
export type ClientId = string;
export type IntentId = string;

export interface PresenceUpdate { clientId: ClientId; focused: boolean; visible: boolean; currentSessionId: string | null }
export interface PresenceUpdateResult { accepted: true; serverTime: number; presenceTtlMs: number }
export interface PresenceDisconnect { clientId: ClientId }
export interface PresenceDisconnectResult { removed: boolean }
export interface SessionIntent { intentId: IntentId; type: "session"; sessionId: string }
export interface NewSessionIntent { intentId: IntentId; type: "new-session"; workspaceId: string; sessionId: string }
export type NavigationIntent = SessionIntent | NewSessionIntent;
export interface NavigationIdle { kind: "idle"; retryAfterMs: number }
export interface NavigationDelivery { kind: "intent"; intent: NavigationIntent }
export type NavigationNextResult = NavigationIdle | NavigationDelivery;
export type NavigationAck =
    | { clientId: ClientId; intentId: IntentId; outcome: "success"; sessionId: string }
    | { clientId: ClientId; intentId: IntentId; outcome: "failure"; message: string };
export interface NavigationAckResult { accepted: true }
export type RpcResult<T> = ConnectionRpcResult<T>;

export const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value });
export const failure = (code: string, message: string, details: Record<string, unknown> = {}): RpcResult<never> =>
    ({ ok: false, error: { code, message, details } });

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SESSION_MAX_LENGTH = 128;
const MAX_MESSAGE_BYTES = 512;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const identity = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const session = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= SESSION_MAX_LENGTH;
const noExtra = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));

export function isPresenceUpdate(v: unknown): v is PresenceUpdate {
    if (!object(v) || !noExtra(v, ["clientId", "focused", "visible", "currentSessionId"])) return false;
    return identity(v.clientId) && bool(v.focused) && bool(v.visible) && (v.currentSessionId === null || session(v.currentSessionId));
}
export function isPresenceDisconnect(v: unknown): v is PresenceDisconnect {
    return object(v) && noExtra(v, ["clientId"]) && identity(v.clientId);
}
export function isNavigationAck(v: unknown): v is NavigationAck {
    if (!object(v) || !noExtra(v, ["clientId", "intentId", "outcome", "sessionId", "message"])) return false;
    if (!identity(v.clientId) || !identity(v.intentId) || (v.outcome !== "success" && v.outcome !== "failure")) return false;
    if (v.sessionId !== undefined && !session(v.sessionId)) return false;
    if (v.outcome === "success") return session(v.sessionId) && v.message === undefined;
    return typeof v.message === "string" && new TextEncoder().encode(v.message).byteLength <= MAX_MESSAGE_BYTES && v.sessionId === undefined;
}

export function validateEndpoint(endpoint: string, payload: unknown): boolean {
    switch (endpoint) {
        case ENDPOINTS.presenceUpdate: return isPresenceUpdate(payload);
        case ENDPOINTS.presenceDisconnect: return isPresenceDisconnect(payload);
        case ENDPOINTS.navigationAck: return isNavigationAck(payload);
        default: return false;
    }
}
