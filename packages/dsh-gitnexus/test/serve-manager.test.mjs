import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../lib/config.js";
import { GitNexusServeManager } from "../lib/serve-manager.js";

function infoResponse(version) {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createSubprocess(stderr = "") {
  let terminated = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const handle = {
    done,
    terminate() {
      if (terminated) return;
      terminated = true;
      resolveDone({ code: 0, signal: "SIGTERM" });
    },
    waitForExit: async () => ({
      code: 0,
      signal: terminated ? "SIGTERM" : null,
    }),
    collected: {
      stderr: {
        readFrom: () => ({ text: stderr }),
      },
    },
  };
  let spawnCount = 0;
  return {
    context: {
      subprocess: {
        spawn() {
          spawnCount += 1;
          return handle;
        },
      },
    },
    get spawnCount() {
      return spawnCount;
    },
    get terminated() {
      return terminated;
    },
  };
}

function replaceFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("reuses a compatible GitNexus server without taking ownership", async (t) => {
  replaceFetch(t, async () => infoResponse("1.6.5"));
  const subprocess = createSubprocess();
  const manager = new GitNexusServeManager(
    subprocess.context,
    resolveConfig({ servePort: 4747 }),
  );

  await manager.ensureStarted();
  await manager.dispose();

  assert.equal(subprocess.spawnCount, 0);
  assert.equal(subprocess.terminated, false);
});

test("starts and cleans up an owned GitNexus server", async (t) => {
  let probes = 0;
  replaceFetch(t, async () => {
    probes += 1;
    if (probes === 1) throw new Error("connection refused");
    return infoResponse("1.6.9");
  });
  const subprocess = createSubprocess();
  const manager = new GitNexusServeManager(
    subprocess.context,
    resolveConfig({ serveStartupTimeoutMs: 1_000 }),
  );

  await manager.ensureStarted();
  assert.equal(subprocess.spawnCount, 1);
  assert.equal(subprocess.terminated, false);

  await manager.dispose();
  assert.equal(subprocess.terminated, true);
});

test("fails closed when an incompatible GitNexus server owns the port", async (t) => {
  replaceFetch(t, async () => infoResponse("1.7.0"));
  const subprocess = createSubprocess();
  const manager = new GitNexusServeManager(subprocess.context, resolveConfig());

  await assert.rejects(manager.ensureStarted(), /expected >=1\.6\.5 <1\.7\.0/);
  assert.equal(subprocess.spawnCount, 0);
});

test("terminates an owned process after startup timeout", async (t) => {
  replaceFetch(t, async () => {
    throw new Error("connection refused");
  });
  const subprocess = createSubprocess("address unavailable");
  const manager = new GitNexusServeManager(
    subprocess.context,
    resolveConfig({ serveStartupTimeoutMs: 20 }),
  );

  await assert.rejects(manager.ensureStarted(), /address unavailable/);
  assert.equal(subprocess.spawnCount, 1);
  assert.equal(subprocess.terminated, true);
});
