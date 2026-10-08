import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireLocalRequest, grantForPath } from "../lib/index.js";
test("open route rejects untrusted transport, host and origins",()=>{
  const req=(remoteAddress="127.0.0.1",host="127.0.0.1:3080",origin="http://127.0.0.1:3080")=>({socket:{remoteAddress},headers:{host,origin}});
  assert.doesNotThrow(()=>requireLocalRequest(req()));
  assert.throws(()=>requireLocalRequest(req("192.168.1.8")));
  assert.throws(()=>requireLocalRequest(req("127.0.0.1","attacker.example:3080")));
  assert.throws(()=>requireLocalRequest(req("127.0.0.1","127.0.0.1:3080","http://evil.example")));
  assert.throws(()=>requireLocalRequest({...req(),headers:{host:"127.0.0.1:3080"}}));
});
test("file grant honors session scope, symlink boundaries and read-only policy",async()=>{
  const root=await mkdtemp(join(tmpdir(),"op-route-")),outside=await mkdtemp(join(tmpdir(),"op-outside-"));
  try {
    await writeFile(join(root,"valid.op"),'{"version":"1.0.0","children":[]}');await writeFile(join(outside,"outside.op"),'{}');await symlink(join(outside,"outside.op"),join(root,"link.op"));
    let mode="workspace-write",calls=0;
    const ctx={sessions:{get:id=>id==="s"?{}:undefined},sandboxPolicy:{resolve:()=>({mode,workspaceRoot:root})},
      fs:{resolve:async(path,{cwd})=>resolve(cwd,path),processPath:path=>path,readBytes:async(path,signal,max)=>{const value=await readFile(path);assert.ok(value.length<=max);return value;}},
      get:()=>({version:1,grantForDocument:async(path,text)=>{calls++;return{sourcePath:path,document:{text}};}})};
    assert.equal((await grantForPath(ctx,"s","valid.op")).sourcePath,join(root,"valid.op"));
    await assert.rejects(grantForPath(ctx,"missing","valid.op"),/Session not found/);
    await assert.rejects(grantForPath(ctx,"s","link.op"),/outside/);assert.equal(calls,1);
    mode="read-only";await assert.rejects(grantForPath(ctx,"s","valid.op"),/只读/);
    mode="danger-full-access";assert.equal((await grantForPath(ctx,"s",join(outside,"outside.op"))).sourcePath,join(outside,"outside.op"));
    await assert.rejects(grantForPath({...ctx,get:()=>undefined},"s","valid.op"),/补丁/);
  } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
