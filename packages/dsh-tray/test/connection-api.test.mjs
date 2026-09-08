import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function jsonRequest(path, body, signal) {
    return new Request("http://app.test/api" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
}

function responseCapture() {
    const result = { status: undefined, headers: undefined, body: undefined };
    return {
        result,
        response: {
            writeHead(status, headers) {
                result.status = status;
                result.headers = headers;
            },
            end(body) {
                result.body = body;
            },
        },
    };
}

test("alpha5 Connection Host adapter enforces its runtime boundary", async () => {
    const connection = await import("@deepseek-ai/dsh-client-connection");
    assert.equal(typeof connection.HostConnectionService, "function");
    assert.equal(typeof connection.RpcId, "function");
    const packageJson = require("@deepseek-ai/dsh-client-connection/package.json");
    assert.equal(packageJson.version, "0.1.2-alpha.5");

    const context = new Context();
    const registeredRoutes = [];
    context.provide("webServer", {
        register(route) {
            registeredRoutes.push(route);
            return () => { registeredRoutes.splice(registeredRoutes.indexOf(route), 1); };
        },
    });
    let authenticated = false;
    const authCalls = [];
    const auth = {
        isAuthenticated(request) {
            const headers = request.headers;
            const host = headers instanceof Headers ? headers.get("host") : headers.host;
            authCalls.push(["check", host]);
            return authenticated;
        },
        authenticatedUrl(url) {
            authCalls.push(["url", url]);
            return "http://app.test/?token=launch";
        },
        authorizeIndex(request, response) {
            authCalls.push(["index", request.url]);
            response.writeHead(303, { location: "/", "set-cookie": "dsh_session=test" });
            response.end();
            return false;
        },
    };
    const service = new connection.HostConnectionService(context, ["app.test"], auth);
    let registeredCalls = 0;
    const registeredDispose = service.rpc.handle("/dsh-tray", async (endpoint, payload) => {
        registeredCalls += 1;
        return { ok: true, value: { endpoint, payload } };
    });
    let resolveCancelStarted;
    const cancelStarted = new Promise(resolve => { resolveCancelStarted = resolve; });
    const dispose = service.rpc.intercept(
        "/api",
        endpoint => endpoint === "dsh-tray/echo" || endpoint === "dsh-tray/cancel",
        async (endpoint, payload, signal) => {
            if (endpoint === "dsh-tray/cancel") {
                resolveCancelStarted();
                return await new Promise(resolve => signal.addEventListener("abort", () => resolve({
                    ok: false,
                    error: { code: "gateway/cancelled", message: "cancelled", details: {} },
                }), { once: true }));
            }
            return { ok: true, value: { echo: payload } };
        });
    const shared = service.createSharedFetchHandler("/api");

    const success = await shared.fetch(jsonRequest("/dsh-tray/echo", {
        type: "client-request",
        rpcId: connection.RpcId("rpc-1"),
        method: "dsh-tray/echo",
        payload: { value: 7 },
    }));
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), {
        type: "server-response",
        rpcId: "rpc-1",
        result: { ok: true, value: { echo: { value: 7 } } },
    });

    const invalid = await shared.fetch(jsonRequest("/dsh-tray/echo", { type: "wrong" }));
    assert.equal(invalid.status, 200);
    const invalidEnvelope = await invalid.json();
    assert.equal(invalidEnvelope.type, "server-response");
    assert.equal(invalidEnvelope.result.ok, false);
    assert.equal(invalidEnvelope.result.error.code, "gateway/bad-request");

    const abort = new AbortController();
    const pending = shared.fetch(jsonRequest("/dsh-tray/cancel", {
        type: "client-request",
        rpcId: "rpc-2",
        method: "dsh-tray/cancel",
        payload: null,
    }, abort.signal));
    await cancelStarted;
    abort.abort();
    assert.deepEqual(await (await pending).json(), {
        type: "server-response",
        rpcId: "rpc-2",
        result: { ok: false, error: { code: "gateway/cancelled", message: "cancelled", details: {} } },
    });

    assert.equal(service.requestRejection({ headers: new Headers({ host: "app.test", origin: "http://app.test" }) }), 401);
    authenticated = true;
    assert.equal(service.requestRejection({ headers: new Headers({ host: "app.test", origin: "http://app.test" }) }), undefined);
    assert.equal(service.requestRejection({ headers: new Headers({ host: "evil.test", origin: "http://evil.test" }) }), 403);

    const tokenUrl = service.authenticatedUrl("http://app.test/dashboard?target=ignored");
    assert.equal(tokenUrl, "http://app.test/?token=launch");
    const captured = responseCapture();
    assert.equal(service.authorizeIndex({ method: "GET", url: tokenUrl, headers: new Headers({ host: "app.test" }) }, captured.response), false);
    assert.equal(captured.result.status, 303);
    assert.equal(captured.result.headers.location, "/");
    assert.equal(captured.result.headers["set-cookie"], "dsh_session=test");
    assert.deepEqual(authCalls.at(-1), ["index", tokenUrl]);
    const invokeRegistered = async (body, headers) => {
        const request = {
            method: "POST",
            url: "/dsh-tray/ping",
            headers,
            destroy() { },
            async *[Symbol.asyncIterator]() {
                yield Buffer.from(JSON.stringify(body));
            },
        };
        const response = new EventEmitter();
        const chunks = [];
        response.writableEnded = false;
        response.writeHead = (status, responseHeaders) => {
            response.status = status;
            response.headers = responseHeaders;
        };
        response.write = chunk => {
            chunks.push(Buffer.from(chunk));
            return true;
        };
        response.end = bodyChunk => {
            if (bodyChunk) chunks.push(Buffer.from(bodyChunk));
            response.writableEnded = true;
            response.body = Buffer.concat(chunks).toString();
        };
        await registeredRoutes[0].handler(request, response);
        return response;
    };
    const trustedHeaders = {
        host: "app.test",
        origin: "http://app.test",
        "content-type": "application/json",
    };
    authenticated = false;
    const unauthorized = await invokeRegistered({
        type: "client-request",
        rpcId: "rpc-unauthorized",
        method: "ping",
        payload: null,
    }, trustedHeaders);
    assert.equal(unauthorized.status, 401);
    assert.equal(registeredCalls, 0);
    authenticated = true;
    const forbidden = await invokeRegistered({
        type: "client-request",
        rpcId: "rpc-forbidden",
        method: "ping",
        payload: null,
    }, { ...trustedHeaders, host: "evil.test", origin: "http://evil.test" });
    assert.equal(forbidden.status, 403);
    assert.equal(registeredCalls, 0);
    const malformed = await invokeRegistered({ type: "wrong" }, trustedHeaders);
    assert.equal(malformed.status, 200);
    assert.equal(JSON.parse(malformed.body).result.error.code, "gateway/bad-request");
    const registeredResponse = await invokeRegistered({
        type: "client-request",
        rpcId: "rpc-registered",
        method: "ping",
        payload: { state: "changed" },
    }, trustedHeaders);
    assert.equal(registeredResponse.status, 200);
    assert.deepEqual(JSON.parse(registeredResponse.body), {
        type: "server-response",
        rpcId: "rpc-registered",
        result: { ok: true, value: { endpoint: "ping", payload: { state: "changed" } } },
    });
    assert.equal(registeredCalls, 1);
    await registeredDispose();
    await dispose();
    const afterDispose = await shared.fetch(jsonRequest("/dsh-tray/echo", {
        type: "client-request",
        rpcId: "rpc-3",
        method: "dsh-tray/echo",
        payload: null,
    }));
    assert.equal(afterDispose.status, 404);
});
