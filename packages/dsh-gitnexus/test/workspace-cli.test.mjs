import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { prepareWorkspaceCli, localToolDefinitions } from "../lib/local-tools.js";
import { auditedCliArguments } from "../lib/workspace-cli.js";
import { acquireWorkspaceLease } from "../lib/workspace-lock.js";
import { registerWorkspaceBackend } from "../lib/workspace-backends.js";
import { resolveConfig } from "../lib/config.js";

function fixture(t, body = 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),home:process.env.GITNEXUS_HOME,git:process.env.GIT_DIR}));console.error("warning: UNKNOWN partial");process.exitCode=7;') {
  const base = mkdtempSync(join(tmpdir(), "gitnexus-cli-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "workspace"); mkdirSync(root);
  const runner = join(base, "runner"); writeFileSync(runner, '#!' + process.execPath + '\n' + body, { mode: 0o700 });
  return { base, root, runner };
}
function run(path, args, options = {}) {
  const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return { child, done: new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); }) };
}
async function until(predicate) { for(let i=0;i<200;i++) { if(predicate()) return; await delay(10); } throw new Error("fixture wait timed out"); }

test("generated executable binds other cwd, isolates registry, preserves stdout/stderr/exit and refreshes idempotently", async t => {
  const { base, root, runner } = fixture(t);
  const outside = join(base, "global"); mkdirSync(outside); writeFileSync(join(outside, "registry.json"), "sentinel");
  const path = await prepareWorkspaceCli(root, runner);
  const before = statSync(path).mtimeMs;
  assert.equal(await prepareWorkspaceCli(root, runner), path);
  assert.equal(statSync(path).mtimeMs, before);
  const result = await run(path, ["analyze", "--force"], { cwd: outside, env: { ...process.env, GITNEXUS_HOME: outside, GIT_DIR: outside } }).done;
  assert.equal(result.code, 7); assert.match(result.stderr, /UNKNOWN partial/);
  const value = JSON.parse(result.stdout);
  assert.equal(value.cwd, root); assert.equal(value.home, join(root, ".gitnexus/runtime")); assert.equal(value.git, undefined);
  assert.deepEqual(value.args, ["analyze", "--force", "--index-only", "--skip-git", root]);
  assert.equal(readFileSync(join(outside, "registry.json"), "utf8"), "sentinel");
  assert.equal(existsSync(join(root, ".gitnexus/coordination.lock")), false);
  writeFileSync(path, "old wrapper"); await prepareWorkspaceCli(root, runner); assert.match(readFileSync(path,"utf8"), /runWorkspaceCli/);
  await assert.rejects(prepareWorkspaceCli(root, path), /resolves to the workspace wrapper/);
});

test("whitelist denies dangerous commands, overrides and malformed flags before running", async t => {
  const { root, runner } = fixture(t); const path = await prepareWorkspaceCli(root, runner);
  for (const args of [["rename","x"],["clean"],["analyze","--watch"],["analyze","--root","/tmp"],["query","x","--repo","/tmp"],["status","--config","x"],["analyze","--force","--force"],["impact","x","--depth","99"],["context","x","--env","A=B"]]) {
    assert.throws(() => auditedCliArguments(root,args));
    const result = await run(path,args).done; assert.notEqual(result.code,0); assert.equal(result.stdout,"");
  }
});

test("wrapper storage refuses symlinks and status never searches ancestor indexes", async t => {
  const { base, root, runner } = fixture(t); const path = await prepareWorkspaceCli(root, runner);
  const child = join(root,"child"); mkdirSync(child); writeFileSync(join(root,".gitnexus/meta.json"), JSON.stringify({stats:{},lastCommit:"ANCESTOR_SECRET"}));
  const childPath = await prepareWorkspaceCli(child, runner);
  const result = await run(childPath,["status"],{cwd:base}).done;
  assert.equal(result.code,0); assert.doesNotMatch(result.stdout,/ANCESTOR_SECRET/); assert.equal(JSON.parse(result.stdout).indexed,false);
  rmSync(path); symlinkSync(runner,path); await assert.rejects(prepareWorkspaceCli(root,runner),/symlink|alias|symbolic/i);
});

test("independent wrapper processes exclude same workspace while distinct workspaces proceed", async t => {
  const { base, root, runner } = fixture(t, 'const fs=require("node:fs");fs.appendFileSync("events","start;");setTimeout(()=>{fs.appendFileSync("events","end;");},180);');
  const path = await prepareWorkspaceCli(root,runner);
  const a=run(path,["analyze"]); await until(()=>existsSync(join(root,"events")));
  const b=run(path,["analyze"]);
  const other=join(base,"other"); mkdirSync(other); const otherPath=await prepareWorkspaceCli(other,runner);
  const c=run(otherPath,["analyze"]);
  await until(()=>existsSync(join(other,"events")));
  assert.deepEqual((await Promise.all([a.done,b.done,c.done])).map(r=>r.code),[0,0,0]);
  assert.equal(readFileSync(join(root,"events"),"utf8"),"start;end;start;end;");
});

test("writer drains cached backend without executing privileged requests", async t => {
  const { root, runner } = fixture(t, 'console.log("analyzed");');
  const path=await prepareWorkspaceCli(root,runner);
  const lease=await acquireWorkspaceLease(root); let closed=false;
  const unregister=registerWorkspaceBackend(root,async()=>{closed=true;},error=>{throw error;}); lease.release(); t.after(()=>unregister());
  const result=await run(path,["analyze"]).done;
  assert.equal(result.code,0); assert.equal(closed,true); assert.equal(existsSync(join(root,".gitnexus/backends/drain")),false);
});

test("cancel waits for child exit, escalates ignored signal, and normal recovery releases lock", async t => {
  const { root, runner } = fixture(t, 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);');
  const path=await prepareWorkspaceCli(root,runner); const running=run(path,["analyze"]);
  await once(running.child.stdout,"data"); running.child.kill("SIGTERM");
  const result=await running.done; assert.equal(result.code,143); assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
  assert.equal((await run(path,["status"]).done).code,0);
});

test("stale and symlink coordination locks fail closed without removal", async t => {
  const { root, runner }=fixture(t); const path=await prepareWorkspaceCli(root,runner);
  const lock=join(root,".gitnexus/coordination.lock");mkdirSync(lock);writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:2147483647,host:(await import("node:os")).hostname()}));
  const result=await run(path,["status"]).done;assert.notEqual(result.code,0);assert.match(result.stderr,/Stale/);assert.equal(existsSync(lock),true);
});

test("local native schemas authorize before writes and return bounded maintenance results", async t => {
  const { root, runner }=fixture(t);const calls=[];let allowed=false;
  const ctx = { subprocess: { spawn(options) {
    calls.push(options);
    return { done: Promise.resolve({ exitCode: 0 }), collected: {
      stdout: { readFrom: () => ({ text: "ok", lossy: false }) },
      stderr: { readFrom: () => ({ text: "WARNING", lossy: false }) },
    } };
  } } };
  const definitions=localToolDefinitions(ctx,resolveConfig({command:runner,serverName:"custom"}),{assert(){if(!allowed)throw new Error("denied");}});
  const exec={agent:{session:{header:{cwd:root}}},signal:new AbortController().signal};
  assert.deepEqual(definitions.map(d=>d.name),["custom_analyze","custom_cli"]);
  await assert.rejects(definitions[1].execute({},exec),/denied/);assert.equal(existsSync(join(root,".gitnexus")),false);allowed=true;
  const cli=JSON.parse((await definitions[1].execute({},exec)).text);assert.equal(cli.path,join(root,".gitnexus/bin/gitnexus"));
  await assert.rejects(definitions[0].execute({repo:"/tmp"},exec),/Unsupported/);
  const result=JSON.parse((await definitions[0].execute({force:true},exec)).text);assert.equal(result.stderr,"WARNING");assert.deepEqual(calls[0].argv,[cli.path,"analyze","--force"]);
});
