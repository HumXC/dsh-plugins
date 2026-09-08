import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AnalysisCoordinator } from "../lib/analysis-coordinator.js";
import { resolveConfig } from "../lib/config.js";
import { GitNexusWebHost } from "../lib/web-host.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return address.port;
}

async function call(port, path, options = {}) {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            }
          : {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: response.statusCode, body: parsed });
        });
      },
    );
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function abortCall(port, path) {
  return new Promise((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      () => resolve(),
    );
    request.once("error", () => resolve());
    request.end();
    setTimeout(() => request.destroy(), 10);
  });
}

async function createFixture(t, fetchImplementation) {
  const base = await mkdtemp(join(tmpdir(), "dsh-gitnexus-web-host-"));
  const ancestor = join(base, "ancestor");
  const child = join(ancestor, "kana");
  const current = join(base, "current");
  const other = join(base, "other");
  await Promise.all([
    mkdir(join(ancestor, ".git"), { recursive: true }),
    mkdir(join(ancestor, ".gitnexus"), { recursive: true }),
    mkdir(child, { recursive: true }),
    mkdir(join(current, ".git"), { recursive: true }),
    mkdir(join(current, ".gitnexus"), { recursive: true }),
    mkdir(join(other, ".git"), { recursive: true }),
  ]);
  await writeFile(join(other, ".gitnexus"), "not a directory");
  await writeFile(join(current, ".gitnexus", "meta.json"), "{}");
  await writeFile(join(ancestor, ".gitnexus", "meta.json"), "{}");

  const originalFetch = globalThis.fetch;
  const servePorts = new Set();
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/info" && !servePorts.has(url.port)) return Promise.reject(new Error("connection refused"));
    return fetchImplementation(input, init);
  };
  const sessions = new Map([
    ["session-current", { header: { cwd: current } }],
    ["session-other", { header: { cwd: other } }],
    ["session-ancestor", { header: { cwd: ancestor } }],
    ["session-kana", { header: { cwd: child } }],
    ["session-no-workspace", { header: {} }],
  ]);
  const analysis = new AnalysisCoordinator();
  const analysisCommands = [];
  const analysisCwds = [];
  const evicted = [];
  const host = new GitNexusWebHost(
    {
      sessions: { get: (id) => sessions.get(id) },
      subprocess: {
        spawn: (options) => {
          if (options.argv?.[0] === "git") {
            return {
              done: Promise.resolve({ exitCode: 1 }),
              collected: {
                stdout: { readFrom: () => ({ text: "" }) },
                stderr: { readFrom: () => ({ text: "" }) },
              },
            };
          }
          assert.equal(options.argv?.[0], "gitnexus");
          assert.equal(options.env.GITNEXUS_HOME, join(options.cwd, ".gitnexus", "runtime"));
          if (options.argv[1] === "serve") {
            const port = options.argv[options.argv.indexOf("--port") + 1];
            servePorts.add(port);
            let finish;
            const done = new Promise(resolve => { finish = resolve; });
            return { done, collected: {}, terminate() { servePorts.delete(port); finish({ exitCode: 0 }); }, waitForExit: async () => { await done; return true; } };
          }
          analysisCommands.push(options.argv);
          analysisCwds.push(options.cwd);
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          let settle;
          const done = new Promise((resolve) => {
            settle = resolve;
          });
          let terminated = false;
          return {
            stdout,
            stderr,
            collected: {},
            done,
            terminate: () => {
              if (terminated) return;
              terminated = true;
              stdout.end();
              stderr.end();
              settle({ exitCode: null, signal: "SIGTERM" });
            },
            waitForExit: async () => {
              await done;
              return true;
            },
          };
        },
      },
    },
    resolveConfig(),
    analysis,
    { evict: async (root) => evicted.push(root) },
  );
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://dsh.local").pathname;
    if (pathname === "/gitnexus/session/open") {
      void host.handleSession(req, res);
    } else {
      void host.handle(req, res);
    }
  });
  const port = await listen(server);

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await host.dispose();
    await new Promise((resolve) => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { port, current, other, ancestor, child, analysis, analysisCommands, analysisCwds, evicted };
}

async function issueGateway(port, sessionId) {
  const response = await call(port, "/gitnexus/session/open", {
    method: "POST",
    body: { sessionId },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.body.gateway,
    /^\/gitnexus\/session\/[A-Za-z0-9_-]{24,}$/,
  );
  return response.body.gateway;
}

test("GitNexus Web host", async (t) => {
  await t.test("opens a session without index storage and reports unindexed after runtime setup", async (t) => {
    let calls = 0;
    const fixture = await createFixture(t, async (input) => {
      calls++;
      const url = new URL(String(input));
      if (url.pathname === "/api/info") return jsonResponse({ version: "1.6.5" });
      if (url.pathname === "/api/repos") return jsonResponse([]);
      return jsonResponse({ error: "unexpected request" }, 500);
    });
    await rm(join(fixture.other, ".gitnexus"));
    const noWorkspace = await call(fixture.port, "/gitnexus/session/open", { method: "POST", body: { sessionId: "session-no-workspace" } });
    assert.equal(noWorkspace.status, 409);
    const gateway = await issueGateway(fixture.port, "session-other");
    assert.equal(calls, 0, "minting must not probe GitNexus");
    const status = await call(fixture.port, gateway + "/dsh/status");
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.state, "unindexed");
    assert.equal(status.body.workspace.path, fixture.other);
    assert.equal(status.body.repo, undefined);
    assert.equal((await call(fixture.port, gateway + "/dsh/status")).body.state, "unindexed");
  });
  await t.test(
    "binds opaque view tokens and repository APIs to the current workspace",
    async (t) => {
      const observed = [];
      let fixture;
      const fetchImplementation = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/info")
          return jsonResponse({ version: "1.6.5" });
        if (url.pathname === "/api/repos") {
          return jsonResponse([
            { name: "current", path: fixture.current },
            { name: "other", path: fixture.other },
          ]);
        }
        if (url.pathname === "/api/query") {
          observed.push({ method: init.method ?? "GET", url, body: init.body });
          return jsonResponse({ result: [{ ok: 1 }] });
        }
        observed.push({ method: init.method ?? "GET", url, body: init.body });
        return jsonResponse({ repo: url.searchParams.get("repo"), ok: true });
      };
      fixture = await createFixture(t, fetchImplementation);
      const healthCapability = await call(
        fixture.port,
        "/gitnexus/session/open",
      );
      assert.equal(healthCapability.status, 405);
      const unknownSession = await call(fixture.port, "/gitnexus/session/open", { method: "POST", body: { sessionId: "unknown" } });
      assert.equal(unknownSession.status, 404);
      const missingSession = await call(fixture.port, "/gitnexus/session/open", { method: "POST", body: {} });
      assert.equal(missingSession.status, 400);
      await rm(join(fixture.other, ".gitnexus"));
      await issueGateway(fixture.port, "session-other");

      const gateway = await issueGateway(fixture.port, "session-current");

      const status = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.body.state, "ready");
      assert.equal(status.body.repo.name, "current");
      const healthProbe = observed.find(({ url }) => url.pathname === "/api/query");
      assert.ok(healthProbe);
      assert.equal(healthProbe.method, "POST");
      assert.deepEqual(JSON.parse(healthProbe.body), {
        repo: "current",
        cypher: "RETURN 1 AS ok",
        params: {},
      });

      const forced = await call(fixture.port, gateway + "/dsh/analyze", {
        method: "POST",
        body: { force: true },
      });
      assert.equal(forced.status, 202);
      assert.deepEqual(fixture.analysisCommands.at(-1), [
        "gitnexus",
        "analyze",
        "--force",
        "--index-only",
        fixture.current,
      ]);
      fixture.analysis.finish(fixture.current, "completed");
      const afterRebuild = await call(fixture.port, gateway + "/dsh/status");
      assert.equal(afterRebuild.body.state, "ready");
      assert.equal(observed.filter(({ url }) => url.pathname === "/api/query").length, 2);

      const repos = await call(fixture.port, gateway + "/api/repos");
      assert.deepEqual(
        repos.body.map((repo) => repo.name),
        ["current"],
      );

      const otherGateway = await issueGateway(fixture.port, "session-other");
      const otherRepos = await call(fixture.port, `${otherGateway}/api/repos`);
      assert.deepEqual(
        otherRepos.body.map((repo) => repo.name),
        [],
      );
      const currentReposAgain = await call(
        fixture.port,
        `${gateway}/api/repos`,
      );
      assert.deepEqual(
        currentReposAgain.body.map((repo) => repo.name),
        ["current"],
      );

      const graph = await call(fixture.port, `${gateway}/api/graph?repo=other`);
      assert.equal(graph.status, 200);
      assert.equal(observed.at(-1).url.searchParams.get("repo"), "current");

      const query = await call(fixture.port, `${gateway}/api/query`, {
        method: "POST",
        body: { repo: "other", query: "auth" },
      });
      assert.equal(query.status, 200);
      assert.equal(JSON.parse(observed.at(-1).body).repo, "current");

      assert.equal(
        (await call(fixture.port, `${gateway}/api/embed`)).status,
        403,
      );
      assert.equal(
        (await call(fixture.port, `${gateway}/api/analyze/foreign`)).status,
        404,
      );
      assert.equal(
        (
          await call(
            fixture.port,
            "/gitnexus/session/abcdefghijklmnopqrstuvwxyz123456/dsh/status",
          )
        ).status,
        404,
      );
    },
  );

  await t.test(
    "accepts only server-resolved index-only analysis and preserves cancellation",
    async (t) => {
      let fixture;
      let queryCalls = 0;
      const fetchImplementation = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/info")
          return jsonResponse({ version: "1.6.5" });
        if (url.pathname === "/api/repos") return jsonResponse([]);
        if (url.pathname === "/api/query") {
          queryCalls += 1;
          return jsonResponse({ result: [{ ok: 1 }] });
        }
        return jsonResponse({ error: "unexpected request" }, 500);
      };
      fixture = await createFixture(t, fetchImplementation);
      await rm(join(fixture.current, ".git"), { recursive: true, force: true });
      const gateway = await issueGateway(fixture.port, "session-current");
      const unindexed = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(unindexed.body.state, "unindexed");
      assert.equal(queryCalls, 0);


      const rejected = await call(fixture.port, `${gateway}/dsh/analyze`, {
        method: "POST",
        body: { path: fixture.other },
      });
      assert.equal(rejected.status, 400);
      assert.equal(fixture.analysisCommands.length, 0);

      const started = await call(fixture.port, `${gateway}/dsh/analyze`, {
        method: "POST",
        body: { force: false },
      });
      assert.equal(started.status, 202);
      const analyzing = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(analyzing.body.state, "analyzing");
      assert.equal(queryCalls, 0);
      assert.deepEqual(fixture.analysisCommands, [
        ["gitnexus", "analyze", "--index-only", "--skip-git", fixture.current],
      ]);

      const cancelled = await call(
        fixture.port,
        `${gateway}/dsh/analysis/${started.body.jobId}`,
        { method: "DELETE" },
      );
      assert.equal(cancelled.status, 202);
      assert.equal(fixture.analysis.state(fixture.current).status, "cancelled");

      const status = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(status.body.state, "cancelled");
      assert.ok(fixture.evicted.includes(fixture.current));
    },
  );
  await t.test(
    "binds capability, status, and analysis to a child session cwd",
    async (t) => {
      let fixture;
      const fetchImplementation = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/info") return jsonResponse({ version: "1.6.5" });
        if (url.pathname === "/api/repos") {
          return jsonResponse([{ name: "ancestor", path: fixture.ancestor }]);
        }
        if (url.pathname === "/api/query") return jsonResponse({ result: [{ ok: 1 }] });
        return jsonResponse({ error: "unexpected request" }, 500);
      };
      fixture = await createFixture(t, fetchImplementation);

      const childGateway = await issueGateway(fixture.port, "session-kana");
      const childStatus = await call(fixture.port, childGateway + "/dsh/status");
      assert.equal(childStatus.body.state, "unindexed");
      assert.equal(childStatus.body.workspace.path, fixture.child);
      assert.equal(childStatus.body.repo, undefined);

      const analysis = await call(fixture.port, childGateway + "/dsh/analyze", {
        method: "POST",
        body: { force: true },
      });
      assert.equal(analysis.status, 202);
      assert.deepEqual(fixture.analysisCommands.at(-1), [
        "gitnexus",
        "analyze",
        "--force",
        "--index-only",
        "--skip-git",
        fixture.child,
      ]);
      assert.equal(fixture.analysisCwds.at(-1), fixture.child);
      assert.equal(fixture.analysis.state(fixture.ancestor), undefined);

      const ancestorGateway = await issueGateway(fixture.port, "session-ancestor");
      const ancestorStatus = await call(fixture.port, ancestorGateway + "/dsh/status");
      assert.equal(ancestorStatus.body.state, "ready");
      assert.equal(ancestorStatus.body.workspace.path, fixture.ancestor);
      fixture.analysis.finish(fixture.child, "completed");
    },
  );
  await t.test(
    "exposes only verified checkpoint failures as rebuildable unavailable status",
    async (t) => {
      const checkpoint =
        "Runtime exception: Cannot open database in read-only mode while checkpoint is in progress. Please retry later.";
      let mode = "checkpoint";
      let fixture;
      const fetchImplementation = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/info") return jsonResponse({ version: "1.6.5" });
        if (url.pathname === "/api/repos") {
          return jsonResponse([{ name: "current", path: fixture.current }]);
        }
        if (url.pathname === "/api/query") {
          if (mode === "checkpoint") return jsonResponse({ error: checkpoint }, 500);
          if (mode === "wrong-schema") return jsonResponse({ result: [{ ok: 2 }] });
          if (mode === "timeout") return new Promise(() => {});
          if (mode === "invalid-json") {
            return new Response("not-json", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("upstream network unavailable");
        }
        return jsonResponse({ error: "unexpected request" }, 500);
      };
      fixture = await createFixture(t, fetchImplementation);
      const gateway = await issueGateway(fixture.port, "session-current");

      const checkpointStatus = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(checkpointStatus.body.state, "unavailable");
      assert.equal(checkpointStatus.body.reason, checkpoint);
      assert.equal(checkpointStatus.body.canRebuild, true);

      mode = "invalid-json";
      const malformedStatus = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(malformedStatus.body.state, "unavailable");
      assert.equal(malformedStatus.body.canRebuild, false);
      assert.match(malformedStatus.body.reason, /invalid JSON/);

      mode = "network";
      const networkStatus = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(networkStatus.body.state, "unavailable");
      assert.equal(networkStatus.body.reason, "upstream network unavailable");
      assert.equal(networkStatus.body.canRebuild, false);

      mode = "wrong-schema";
      const wrongSchemaStatus = await call(fixture.port, gateway + "/dsh/status");
      assert.equal(wrongSchemaStatus.body.state, "unavailable");
      assert.equal(wrongSchemaStatus.body.canRebuild, false);
      assert.match(wrongSchemaStatus.body.reason, /invalid response shape/);

      mode = "timeout";
      const timeoutStatus = await call(fixture.port, gateway + "/dsh/status");
      assert.equal(timeoutStatus.body.state, "unavailable");
      assert.equal(timeoutStatus.body.reason, "GitNexus health probe timed out");
      assert.equal(timeoutStatus.body.canRebuild, false);
      await abortCall(fixture.port, gateway + "/dsh/status");
    },
  );
});

test("Web gateway refuses external file/worktree selectors and filesystem Cypher", async t => {
  let fixture;
  const forwarded = [];
  fixture = await createFixture(t, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/info") return jsonResponse({ version: "1.6.10" });
    if (url.pathname === "/api/repos") return jsonResponse([{ name: "current", path: fixture.current }]);
    forwarded.push(url.pathname);
    return jsonResponse({ ok: true });
  });
  const gateway = await issueGateway(fixture.port, "session-current");
  const deniedFile = await call(fixture.port, gateway + "/api/file?path=" + encodeURIComponent(fixture.other));
  assert.equal(deniedFile.status, 502);
  assert.match(deniedFile.body.error, /outside/);
  const deniedWorktree = await call(fixture.port, gateway + "/api/query", { method: "POST", body: { worktree: fixture.other, cypher: "MATCH (n) RETURN n LIMIT 1" } });
  assert.equal(deniedWorktree.status, 502);
  const deniedProcedure = await call(fixture.port, gateway + "/api/query", { method: "POST", body: { cypher: "CALL read_csv('/outside')" } });
  assert.equal(deniedProcedure.status, 502);
  assert.match(deniedProcedure.body.error, /filesystem/);
  assert.deepEqual(forwarded, []);
});
