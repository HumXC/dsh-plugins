import test from "node:test";
import assert from "node:assert/strict";
import { Config, normalizeConfig } from "../lib/config.js";
import { assertTrustedOrigin, resolveBaseUrl } from "../lib/browser.js";

test("icon size is bounded and webBaseUrl is normalized to an HTTP(S) origin", () => {
    const base = { iconSize: 999, iconOutline: false, iconColor: "#4d6bfe", dotGreen: "#22c55e", dotYellow: "#eab308", dotRed: "#ef4444" };
    assert.equal(normalizeConfig(base).iconSize, 256);
    assert.equal(resolveBaseUrl({ port: 9, webBaseUrl: "https://example.test/path/" }), "https://example.test");
    assert.equal(Config({}).webBaseUrl, undefined);
    assert.throws(() => resolveBaseUrl({ port: 9, webBaseUrl: "file:///tmp/web" }), /HTTP/);
});

test("trust preflight rejects an incompatible authority", () => {
    const connection = { requestRejection: () => 403 };
    assert.throws(() => assertTrustedOrigin(connection, "http://example.test"), /trusted/);
    assert.equal(assertTrustedOrigin({ requestRejection: () => 401 }, "http://example.test"), "http://example.test");
});
