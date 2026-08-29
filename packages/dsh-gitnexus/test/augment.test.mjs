import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutoAugmentController } from "../lib/augment.js";
import { resolveConfig } from "../lib/config.js";

test("adds GitNexus context once per session and pattern", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-gitnexus-augment-"));
  mkdirSync(join(root, ".gitnexus"));
  const listeners = new Map();
  const spawns = [];
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    subprocess: {
      spawn(spec) {
        spawns.push(spec);
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          collected: {
            stdout: {
              readFrom: () => ({
                text: "AuthService -> UserRepository",
                nextOffset: 29,
                lossy: false,
              }),
            },
            stderr: {
              readFrom: () => ({ text: "", nextOffset: 0, lossy: false }),
            },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate() {},
          waitForExit: async () => true,
        };
      },
    },
    logger: { debug() {}, warn() {} },
  };
  const controller = new AutoAugmentController(ctx, resolveConfig());
  controller.start();

  try {
    const listener = listeners.get("tools/post-execute");
    assert.equal(typeof listener, "function");
    const session = { header: { cwd: root } };
    const exec = {
      callId: "read-1",
      rootCallId: "read-1",
      name: "read",
      arguments: { file_path: "src/AuthService.ts" },
      agent: { session },
      signal: new AbortController().signal,
      token: {},
    };
    const result = {
      isError: false,
      value: { path: "src/AuthService.ts" },
      content: [{ type: "text", text: "export class AuthService {}" }],
    };

    const first = await listener(exec, result, async () => ({
      kind: "accept",
    }));
    assert.equal(first.kind, "accept");
    assert.equal(first.additionalContexts.length, 1);
    assert.match(
      first.additionalContexts[0].content[0].text,
      /AuthService -> UserRepository/,
    );
    assert.deepEqual(spawns[0].argv, ["gitnexus", "augment", "AuthService"]);
    assert.equal(spawns[0].cwd, root);

    const second = await listener(exec, result, async () => ({
      kind: "accept",
    }));
    assert.equal(second.additionalContexts, undefined);
    assert.equal(spawns.length, 1);
  } finally {
    await controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
