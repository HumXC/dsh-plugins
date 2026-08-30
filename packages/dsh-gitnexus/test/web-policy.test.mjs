import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyApiRequest,
  forceRepoBody,
  forceRepoQuery,
  rewriteGitNexusIndex,
  selectWorkspaceRepo,
  workspaceStorageBootstrap,
} from "../lib/web-policy.js";

test("selects only the repository whose canonical path matches the workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "dsh-gitnexus-web-policy-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const current = join(base, "current");
  const other = join(base, "other");
  const alias = join(base, "current-alias");
  await Promise.all([mkdir(current), mkdir(other)]);
  await symlink(current, alias);

  const selected = await selectWorkspaceRepo(
    [
      { name: "other", path: other },
      { name: "current", repoPath: alias },
    ],
    current,
  );

  assert.equal(selected?.name, "current");
  assert.equal(await realpath(selected.repoPath), await realpath(current));
});

test("denies global and mutating GitNexus APIs", () => {
  assert.deepEqual(classifyApiRequest("GET", "/api/repos"), { kind: "repos" });
  assert.deepEqual(classifyApiRequest("GET", "/api/health"), { kind: "public" });
  assert.deepEqual(classifyApiRequest("GET", "/api/graph"), { kind: "repo-get" });
  assert.deepEqual(classifyApiRequest("POST", "/api/query"), { kind: "repo-post" });
  assert.deepEqual(classifyApiRequest("DELETE", "/api/repo"), { kind: "denied" });
  assert.deepEqual(classifyApiRequest("POST", "/api/analyze"), { kind: "denied" });
  assert.deepEqual(classifyApiRequest("POST", "/api/analyze/upload"), { kind: "denied" });
  assert.deepEqual(classifyApiRequest("POST", "/api/embed"), { kind: "denied" });
  assert.deepEqual(classifyApiRequest("GET", "/api/mcp"), { kind: "denied" });
  assert.deepEqual(classifyApiRequest("GET", "/api/unknown"), { kind: "denied" });
});

test("scopes repository API inputs on the server", () => {
  const query = new URL("http://localhost/api/graph?repo=other&stream=true");
  forceRepoQuery(query, "current");
  assert.equal(query.searchParams.get("repo"), "current");
  assert.equal(query.searchParams.get("stream"), "true");

  assert.deepEqual(
    forceRepoBody({ repo: "other", query: "auth flow" }, "current"),
    { repo: "current", query: "auth flow" },
  );
});

test("rewrites compatible GitNexus assets and injects session storage isolation", () => {
  const html = [
    "<!doctype html>",
    "<html><head>",
    "<title>GitNexus</title>",
    '<script type="module" src="/assets/app.js"></script>',
    '<link rel="stylesheet" href="/assets/app.css">',
    "</head><body>",
    '<div id="root"></div>',
    "</body></html>",
  ].join("");
  const gateway = "/gitnexus/session/abcdefghijklmnopqrstuvwxyz123456";
  const rewritten = rewriteGitNexusIndex(html, gateway);

  assert.match(rewritten, new RegExp(`${gateway}/assets/app\\.js`));
  assert.match(rewritten, new RegExp(`${gateway}/assets/app\\.css`));
  assert.match(rewritten, new RegExp(`${gateway}/dsh/bootstrap\\.js`));
  assert.ok(
    rewritten.indexOf("bootstrap.js") < rewritten.indexOf('type="module"'),
  );
  assert.match(workspaceStorageBootstrap(gateway), /dsh-gitnexus:/);
  assert.match(workspaceStorageBootstrap(gateway), /localStorage/);
});

test("rejects incompatible GitNexus Web assets", () => {
  assert.throws(
    () =>
      rewriteGitNexusIndex(
        "<html></html>",
        "/gitnexus/session/abcdefghijklmnopqrstuvwxyz123456",
      ),
    /assets are incompatible/,
  );
});
