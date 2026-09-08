import type { NavigationIntent } from "./rpc.js";

export type { ClientId, IntentId, PresenceUpdate, SessionIntent, NewSessionIntent, NavigationIntent } from "./rpc.js";

export type TrayNavigationFrame =
    | { type: "ready" }
    | { type: "intent"; intent: NavigationIntent };
