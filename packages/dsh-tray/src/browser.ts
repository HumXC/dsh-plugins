import { createRequire } from "node:module";
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
const require = createRequire(import.meta.url);
const open = (require("open") as { default: typeof import("open")["default"] }).default;

export interface BaseSource { webBaseUrl?: string; port: number }

/** Normalize the configured authority to a clean HTTP(S) origin. */
export function normalizeWebBaseUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("webBaseUrl must use HTTP(S)");
    if (url.username || url.password || url.search || url.hash) throw new Error("webBaseUrl must be an origin without credentials or query");
    return url.origin;
}

export function resolveBaseUrl(src: BaseSource): string {
    const prefer = src.webBaseUrl?.trim() || process.env.DSH_WEB_URL?.trim();
    return normalizeWebBaseUrl(prefer || `http://127.0.0.1:${src.port}`);
}

/** Connection trust-only preflight: 401 means trusted but not cookie-authenticated. */
export function assertTrustedOrigin(connection: Pick<HostConnectionHandle, "requestRejection">, baseUrl: string): string {
    const origin = normalizeWebBaseUrl(baseUrl);
    const url = new URL(origin);
    const rejection = connection.requestRejection({ headers: { host: url.host, origin: url.origin } });
    if (rejection !== 401) {
        if (rejection === 403) throw new Error("webBaseUrl is outside the Connection trusted authority");
        throw new Error("Connection trust preflight must return 401 for an unauthenticated trusted origin");
    }
    return origin;
}

/** Open the authenticated root only; destination data remains in Host memory. */
export async function openAuthenticatedRoot(connection: Pick<HostConnectionHandle, "authenticatedUrl">, baseUrl: string, opener = open): Promise<void> {
    await opener(connection.authenticatedUrl(normalizeWebBaseUrl(baseUrl)));
}
