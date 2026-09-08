import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../lib/config.js";
import { publicToolName } from "../lib/naming.js";

test("resolves stable plugin defaults", () => {
  const config = resolveConfig();
  assert.equal(config.command, "gitnexus");
  assert.deepEqual(config.args, ["mcp"]);
  assert.equal(config.serverName, "gitnexus");
  assert.equal(config.maxConnections, 8);
  assert.equal(config.autoAugment, true);
  assert.equal(config.webUi, "auto");
  assert.equal(config.servePort, 4747);
  assert.equal(config.serveStartupTimeoutMs, 15_000);
});

test("rejects invalid process and capacity settings", () => {
  assert.throws(
    () => resolveConfig({ command: " " }),
    /command must be a non-empty string/,
  );
  assert.throws(
    () => resolveConfig({ args: [" "] }),
    /args must not contain empty strings/,
  );
  assert.throws(
    () => resolveConfig({ maxConnections: 0 }),
    /maxConnections must be a positive safe integer/,
  );
  assert.throws(
    () => resolveConfig({ servePort: 65_536 }),
    /servePort must not exceed 65535/,
  );
  assert.throws(
    () => resolveConfig({ webUi: "always" }),
    /webUi must be auto or a boolean/,
  );
});

test("keeps native names and hashes normalized long names", () => {
  assert.equal(publicToolName("gitnexus", "query"), "gitnexus_query");
  const normalized = publicToolName("server", "name with spaces/".repeat(8));
  assert.match(normalized, /^[A-Za-z0-9_-]+$/);
  assert.equal(normalized.length, 64);
  assert.equal(
    normalized,
    publicToolName("server", "name with spaces/".repeat(8)),
  );
});
