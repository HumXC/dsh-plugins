/** Client-side tray plugin entry point. */
import type { Context } from "@deepseek-ai/cordis";
import { RemoteStreamCarrierError } from "@deepseek-ai/dsh-api-gateway/client";
import type { TypertDisposer } from "@deepseek-ai/dsh-typert-protocol";
import { TYPERT_REMOTE } from "../lib/typert.remote-client.js";
import { createClientController, type ClientContext } from "./client-internal.js";

export const name = "dsh-tray-client";
// This entry provides the namespace; it cannot require it before $mount runs.
export const inject = ["sessions", "connection", "remote"];

export async function apply(ctx: Context): Promise<void> {
    let navigationFiber: { dispose(): Promise<void> } | undefined;
    let unmount: TypertDisposer | undefined;
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
        disposed = true;
        return disposal ??= (async () => {
            try { await navigationFiber?.dispose(); }
            finally { await unmount?.(); }
        })();
    };
    ctx.effect(() => dispose);
    try {
        unmount = await ctx.remote.$mount(TYPERT_REMOTE);
        if (disposed) { await unmount(); return; }
        const fiber = ctx.plugin({
            name: "dsh-tray-client-navigation",
            inject: ["sessions", "connection", "remote", "remote.trayNavigation"],
            apply(childCtx: Context): void {
                const controller = createClientController(childCtx as ClientContext, {
                    streamEnded: () => new RemoteStreamCarrierError("Tray navigation stream ended"),
                    document: globalThis.document,
                    addEventListener: globalThis.addEventListener.bind(globalThis),
                    removeEventListener: globalThis.removeEventListener.bind(globalThis),
                });
                childCtx.effect(() => () => controller.dispose());
            },
        });
        navigationFiber = fiber;
        await fiber;
    } catch (error) {
        await dispose();
        throw error;
    }
}
