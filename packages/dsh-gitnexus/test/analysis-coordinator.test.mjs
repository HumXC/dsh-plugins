import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisCoordinator } from "../lib/analysis-coordinator.js";

test("canonical paths share one active analysis", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "dsh-gitnexus-analysis-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const alias = join(base, "alias");
  await mkdir(root);
  await symlink(root, alias);

  const coordinator = new AnalysisCoordinator();
  assert.equal(coordinator.begin(alias, 10).started, true);
  const duplicate = coordinator.begin(root, 20);

  assert.equal(duplicate.started, false);
  assert.equal(duplicate.state.root, await realpath(root));
  assert.equal(coordinator.isRebuilding(root), true);
});

test("workspaces maintain independent analysis state", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "dsh-gitnexus-analysis-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = join(base, "first");
  const second = join(base, "second");
  await Promise.all([mkdir(first), mkdir(second)]);

  const coordinator = new AnalysisCoordinator();
  coordinator.begin(first, 10);
  coordinator.begin(second, 20);
  coordinator.bindJob(first, "job-first", 30);
  coordinator.update(first, { phase: "parse", progress: 0.5 }, 40);

  assert.deepEqual(coordinator.state(first), {
    root: await realpath(first),
    status: "running",
    jobId: "job-first",
    phase: "parse",
    progress: 0.5,
    startedAt: 10,
    updatedAt: 40,
  });
  assert.equal(coordinator.state(second)?.status, "starting");
});

test("a terminal state cannot be overwritten by a late monitor result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-gitnexus-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coordinator = new AnalysisCoordinator();

  coordinator.begin(root, 10);
  coordinator.bindJob(root, "job", 20);
  coordinator.finish(root, "cancelled", "Cancelled by user", 30);
  coordinator.finish(root, "failed", "late upstream failure", 40);

  assert.equal(coordinator.state(root)?.status, "cancelled");
  assert.equal(coordinator.state(root)?.error, "Cancelled by user");
});

test("terminal state permits a new analysis and notifies listeners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-gitnexus-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coordinator = new AnalysisCoordinator();
  const statuses = [];
  const dispose = coordinator.onChange((state) => statuses.push(state.status));

  coordinator.begin(root, 10);
  coordinator.bindJob(root, "job", 20);
  coordinator.finish(root, "failed", "parse failed", 30);

  assert.equal(coordinator.isRebuilding(root), false);
  assert.equal(coordinator.state(root)?.error, "parse failed");
  assert.equal(coordinator.begin(root, 40).started, true);
  assert.deepEqual(statuses, ["starting", "running", "failed", "starting"]);
  dispose();
});
