import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

async function createFixture(t, fetchImplementation) {
  const base = await mkdtemp(join(tmpdir(), "dsh-gitnexus-web-host-"));
  const current = join(base, "current");
  const other = join(base, "other");
  await Promise.all([
    mkdir(join(current, ".git"), { recursive: true }),
    mkdir(join(other, ".git"), { recursive: true }),
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  const sessions = new Map([
    ["session-current", { header: { cwd: current } }],
    ["session-other", { header: { cwd: other } }],
  ]);
  const analysis = new AnalysisCoordinator();
  const analysisCommands = [];
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
          analysisCommands.push(options.argv);
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
    if (pathname === "/gitnexus/capability") {
      void host.handleCapability(req, res);
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
  return { port, current, other, analysis, analysisCommands, evicted };
}

async function issueGateway(port, sessionId) {
  const response = await call(port, "/gitnexus/capability", {
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
        observed.push({ method: init.method ?? "GET", url, body: init.body });
        return jsonResponse({ repo: url.searchParams.get("repo"), ok: true });
      };
      fixture = await createFixture(t, fetchImplementation);
      const gateway = await issueGateway(fixture.port, "session-current");

      const status = await call(fixture.port, `${gateway}/dsh/status`);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.body.state, "ready");
      assert.equal(status.body.repo.name, "current");

      const repos = await call(fixture.port, `${gateway}/api/repos`);
      assert.deepEqual(
        repos.body.map((repo) => repo.name),
        ["current"],
      );

      const otherGateway = await issueGateway(fixture.port, "session-other");
      const otherRepos = await call(fixture.port, `${otherGateway}/api/repos`);
      assert.deepEqual(
        otherRepos.body.map((repo) => repo.name),
        ["other"],
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
      const fetchImplementation = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/info")
          return jsonResponse({ version: "1.6.5" });
        if (url.pathname === "/api/repos") return jsonResponse([]);
        return jsonResponse({ error: "unexpected request" }, 500);
      };
      fixture = await createFixture(t, fetchImplementation);
      await rm(join(fixture.current, ".git"), { recursive: true, force: true });
      const gateway = await issueGateway(fixture.port, "session-current");

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
});
