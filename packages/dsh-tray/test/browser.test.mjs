import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveBaseUrl, assertTrustedOrigin, openAuthenticatedRoot } = require("../lib/browser.js");

test("resolveBaseUrl prefers config, then env, then loopback", () => {
    const old = process.env.DSH_WEB_URL;
    delete process.env.DSH_WEB_URL;
    assert.equal(resolveBaseUrl({ port: 1234 }), "http://127.0.0.1:1234");
    process.env.DSH_WEB_URL = "http://env-host:9/";
    assert.equal(resolveBaseUrl({ port: 1 }), "http://env-host:9");
    assert.equal(resolveBaseUrl({ port: 1, webBaseUrl: "http://cfg-host:7/path" }), "http://cfg-host:7");
    if (old === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = old;
});

test("authenticated launch uses normalized root without tray query paths", async () => {
    let opened;
    const connection = { requestRejection: () => 401, authenticatedUrl: base => `${base}/?token=secret` };
    assert.equal(assertTrustedOrigin(connection, "https://web.example/path"), "https://web.example");
    await openAuthenticatedRoot(connection, "https://web.example/path", async url => { opened = url; });
    assert.equal(opened, "https://web.example/?token=secret");
    assert.doesNotMatch(opened, /tray-(session|workspace|new)/);
    for (const status of [undefined, 200, 403, 404, 500]) {
        assert.throws(
            () => assertTrustedOrigin({ requestRejection: () => status }, "https://web.example"),
            status === 403 ? /trusted/ : /401/,
        );
    }
});
