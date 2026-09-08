import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { NavigationBroker } from "./navigation.js";
import { isPresenceUpdate } from "./rpc.js";
import type { PresenceUpdate, TrayNavigationFrame } from "./remote-types.js";

/** @typert service trayNavigation */
export class TrayNavigationService extends TypertRemoteService {
    private readonly streams = new Map<string, AbortSignal>();

    constructor(ctx: Context, private readonly broker: NavigationBroker) {
        super(ctx, "trayNavigation");
    }

    /** Each stream generation registers fresh presence; delivered intents are never replayed by the Host. */
    @Remote({ mode: "stream" })
    async *watch(request: PresenceUpdate, signal: AbortSignal): AsyncIterable<TrayNavigationFrame> {
        const endpoint = "trayNavigation/watch";
        if (!isPresenceUpdate(request)) {
            throw new RemoteError("gateway/input-invalid", "Invalid tray presence", { endpoint });
        }
        if (signal.aborted) return;
        const registered = this.broker.register(request);
        if (!registered.ok) {
            throw new RemoteError("gateway/service-unavailable", registered.error.message, { endpoint });
        }
        this.streams.set(request.clientId, signal);
        const disconnect = (): void => {
            // A replaced generation must not remove the newly connected page.
            if (this.streams.get(request.clientId) !== signal) return;
            this.streams.delete(request.clientId);
            this.broker.disconnect(request.clientId);
        };
        // Page close may suspend the generator at a yield; do not wait for return().
        signal.addEventListener("abort", disconnect, { once: true });
        try {
            if (signal.aborted) return;
            yield { type: "ready" };
            while (!signal.aborted) {
                const result = await this.broker.next(request.clientId, signal);
                if (!result.ok) {
                    if (signal.aborted || result.error.code === "tray/disposed") return;
                    throw new RemoteError("gateway/service-unavailable", result.error.message, { endpoint });
                }
                if (signal.aborted) return;
                if (result.value.kind === "intent") yield { type: "intent", intent: result.value.intent };
            }
        } finally {
            signal.removeEventListener("abort", disconnect);
            disconnect();
        }
    }
}
