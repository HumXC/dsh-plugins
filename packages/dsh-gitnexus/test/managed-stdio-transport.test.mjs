import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ManagedStdioTransport } from "../lib/managed-stdio-transport.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const leader = deferred(), range = deferred();
  const controller = new AbortController();
  const stdin = new PassThrough(), stdout = new PassThrough();
  const state = { terminations: 0, waits: 0, events: [], diagnostics: [] };
  const handle = {
    stdin: options.missingStdin ? undefined : stdin,
    stdout,
    collected: { stderr: { readFrom: () => ({ text: "backend diagnostic\n", nextOffset: 19, lossy: false }) } },
    done: leader.promise,
    terminate() {
      state.terminations++;
      if (options.exitOnTerminate) leader.resolve({ exitCode: null, signal: "SIGTERM" });
    },
    waitForExit() { state.waits++; return range.promise; },
  };
  const transport = new ManagedStdioTransport({ spawn(spec) {
    state.spec = spec;
    spec.signal.addEventListener("abort", () => handle.terminate(), { once: true });
    return handle;
  } }, {
    argv: ["gitnexus", "mcp"], cwd: process.cwd(), graceMs: 100, stderrMaxBytes: 1024,
    signal: controller.signal, onStderr: text => state.diagnostics.push(text),
  });
  transport.onclose = () => state.events.push("close");
  transport.onerror = error => state.events.push(error);
  t.after(() => { stdin.destroy(); stdout.destroy(); });
  return { transport, handle, leader, range, controller, state, stdin, stdout };
}

test("leader completion with a surviving child closes MCP but retains ownership until range exit", { timeout: 1000 }, async t => {
  const { transport, leader, range, state } = fixture(t);
  await transport.start();
  leader.resolve({ exitCode: 0, signal: null });
  await nextTurn();
  assert.deepEqual(state.events, ["close"]);
  assert.deepEqual(state.diagnostics, ["backend diagnostic"]);
  assert.equal(transport.isClosed, false);
  await assert.rejects(transport.send({ jsonrpc: "2.0", method: "ping" }), /not connected/);

  const closing = transport.close();
  assert.strictEqual(transport.close(), closing, "duplicate close shares range confirmation");
  let settled = false;
  void closing.then(() => { settled = true; });
  await nextTurn();
  assert.ok(state.terminations > 0, "termination must still target the surviving owned range");
  assert.equal(state.waits, 1);
  assert.equal(settled, false);
  assert.equal(transport.isClosed, false);

  range.resolve(true);
  await closing;
  assert.equal(transport.isClosed, true);
  assert.deepEqual(state.events, ["close"]);
  assert.deepEqual(state.diagnostics, ["backend diagnostic"]);
  await transport.close();
  assert.equal(state.waits, 1);
});

test("normal command and range exit closes without hanging", { timeout: 1000 }, async t => {
  const { transport, leader, range, state } = fixture(t);
  await transport.start();
  leader.resolve({ exitCode: 0, signal: null });
  range.resolve(true);
  await nextTurn();
  assert.equal(transport.isClosed, false);
  await transport.close();
  assert.equal(transport.isClosed, true);
  assert.equal(state.waits, 1);
  assert.deepEqual(state.events, ["close"]);
});

test("explicit close verifies the range and emits onclose once even if done settles later", { timeout: 1000 }, async t => {
  const { transport, leader, range, state } = fixture(t);
  await transport.start();
  const closing = transport.close();
  await nextTurn();
  assert.equal(transport.isClosed, false);
  range.resolve(true);
  await closing;
  assert.equal(transport.isClosed, true);
  assert.deepEqual(state.events, ["close"]);
  leader.resolve({ exitCode: 0, signal: null });
  await nextTurn();
  assert.deepEqual(state.events, ["close"]);
  assert.deepEqual(state.diagnostics, ["backend diagnostic"]);
});

test("done rejection preserves error then protocol close without claiming owned range exit", { timeout: 1000 }, async t => {
  const { transport, leader, range, state } = fixture(t);
  await transport.start();
  const failure = new Error("leader outcome failed");
  leader.reject(failure);
  await nextTurn();
  assert.deepEqual(state.events, [failure, "close"]);
  assert.equal(transport.isClosed, false);
  range.resolve(true);
  await transport.close();
  assert.equal(transport.isClosed, true);
  assert.deepEqual(state.events, [failure, "close"]);
});

test("range observation failure rejects close, retains ownership, and permits confirmation retry", { timeout: 1000 }, async t => {
  const { transport, handle, leader, range, state } = fixture(t);
  await transport.start();
  leader.resolve({ exitCode: 0, signal: null });
  await nextTurn();
  const failure = new Error("provider can no longer observe managed range");
  const closing = transport.close();
  const rejected = assert.rejects(closing, error => error === failure);
  range.reject(failure);
  await rejected;
  assert.equal(transport.isClosed, false);
  assert.equal(state.waits, 1);

  handle.waitForExit = async () => { state.waits++; return true; };
  const retry = transport.close();
  assert.notStrictEqual(retry, closing);
  await retry;
  assert.equal(state.waits, 2);
  assert.equal(transport.isClosed, true);
  assert.deepEqual(state.events, ["close"]);
});

test("false wait result is not exit confirmation and does not drop the owned handle", { timeout: 1000 }, async t => {
  const { transport, handle, range, state } = fixture(t);
  await transport.start();
  range.resolve(false);
  await assert.rejects(transport.close(), /managed process exit unconfirmed/);
  assert.equal(transport.isClosed, false);
  assert.deepEqual(state.events, []);
  handle.waitForExit = async () => { state.waits++; return true; };
  await transport.close();
  assert.equal(state.waits, 2);
  assert.equal(transport.isClosed, true);
  assert.deepEqual(state.events, ["close"]);
});

test("initialization abort terminates backend but cleanup still waits for surviving descendants", { timeout: 1000 }, async t => {
  const { transport, controller, range, state } = fixture(t, { exitOnTerminate: true });
  const client = new Client({ name: "transport-test", version: "1" });
  const connected = client.connect(transport, { signal: controller.signal });
  const failed = assert.rejects(connected, /cancelled|closed/i);
  await nextTurn();
  controller.abort(new Error("initialization cancelled"));
  await failed;
  assert.ok(state.terminations > 0);
  assert.equal(transport.isClosed, false);
  await nextTurn();
  assert.equal(client.transport, undefined);
  // Failed initialization may already start cleanup; later Client.close cannot retry it.
  const existingWaits = state.waits;
  await client.close();
  assert.equal(state.waits, existingWaits);
  const closing = transport.close();
  await nextTurn();
  assert.equal(state.waits, 1);
  assert.equal(transport.isClosed, false);
  range.resolve(true);
  await closing;
  assert.equal(transport.isClosed, true);
});

test("missing stdio pipes still observe done errors and retain the handle for range cleanup", { timeout: 1000 }, async t => {
  const { transport, leader, range, state } = fixture(t, { missingStdin: true });
  await assert.rejects(transport.start(), /did not expose MCP stdio pipes/);
  assert.ok(state.terminations > 0);
  const failure = new Error("spawn failed");
  leader.reject(failure);
  await nextTurn();
  assert.deepEqual(state.events, [failure, "close"]);
  assert.equal(transport.isClosed, false);
  range.resolve(true);
  await transport.close();
  assert.equal(state.waits, 1);
  assert.equal(transport.isClosed, true);
});

test("MCP framing and stream errors preserve transport callbacks", { timeout: 1000 }, async t => {
  const { transport, stdout, stdin, range, state } = fixture(t);
  const messages = [];
  transport.onmessage = message => messages.push(message);
  await transport.start();
  const message = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  const bytes = JSON.stringify(message) + "\n";
  stdout.write(bytes.slice(0, 9));
  stdout.write(bytes.slice(9));
  assert.deepEqual(messages, [message]);
  const sent = [];
  stdin.on("data", chunk => sent.push(chunk.toString()));
  const request = { jsonrpc: "2.0", id: 2, method: "ping" };
  await transport.send(request);
  assert.deepEqual(sent, [JSON.stringify(request) + "\n"]);
  const failure = new Error("stdin failed");
  stdin.emit("error", failure);
  assert.deepEqual(state.events, [failure]);
  range.resolve(true);
  await transport.close();
  stdout.write(bytes);
  assert.deepEqual(messages, [message]);
  assert.deepEqual(state.events, [failure, "close"]);
});

test("malformed MCP input starts cleanup and propagates range wait failure to close callers", { timeout: 1000 }, async t => {
  const { transport, stdout, range, state } = fixture(t);
  await transport.start();
  stdout.write("not json\n");
  assert.equal(state.events.length, 1);
  assert.ok(state.events[0] instanceof SyntaxError);
  const closing = transport.close();
  await nextTurn();
  assert.equal(state.waits, 1);
  assert.equal(transport.isClosed, false);
  const failure = new Error("range observation failed during error cleanup");
  const rejected = assert.rejects(closing, error => error === failure);
  range.reject(failure);
  await rejected;
  assert.equal(transport.isClosed, false);
  assert.strictEqual(state.events[1], failure);
  await assert.rejects(transport.send({ jsonrpc: "2.0", method: "ping" }), /not connected/);
});

test("close before start is safe and cannot later spawn an owned range", { timeout: 1000 }, async t => {
  const { transport, state } = fixture(t);
  await transport.close();
  assert.equal(transport.isClosed, true);
  await assert.rejects(transport.start(), /transport is closed/);
  assert.equal(state.spec, undefined);
  assert.deepEqual(state.events, ["close"]);
});
