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
});

test("keeps safe MCP names and hashes normalized long names", () => {
  assert.equal(publicToolName("gitnexus", "query"), "mcp__gitnexus__query");
  const normalized = publicToolName("server", "name with spaces/".repeat(8));
  assert.match(normalized, /^[A-Za-z0-9_-]+$/);
  assert.equal(normalized.length, 64);
  assert.equal(
    normalized,
    publicToolName("server", "name with spaces/".repeat(8)),
  );
});
