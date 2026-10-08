#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
const packageRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/native-smoke.mjs /path/to/@zseven-w/dsh-openpencil");
const temp=await mkdtemp(join(tmpdir(),"op-workspace-native-"));
// Only this disposable subprocess receives the override. User settings and documents stay untouched.
process.env.DSH_HOME=join(temp,"state");
let editor,server,detach; const results=[];
try {
  const {EditorHostController}=await import(pathToFileURL(join(packageRoot,"lib/editor-host.js")));
  const {createDocumentSnapshotFromText}=await import(pathToFileURL(join(packageRoot,"lib/renderer.js")));
  editor=new EditorHostController(randomBytes(32));assert.equal(editor.available,true,editor.runtimeError?.message);detach=editor.attachRoute();
  server=createServer((req,res)=>{void editor.handle(req,res);});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+server.address().port;
  const request=(url,method,body)=>fetch(new URL(url,origin),{method,headers:{Origin:origin,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const source=join(temp,"test.op");const original={version:"1.0.0",children:[{id:"n1",type:"frame",name:"Native smoke",width:400,height:300,fill:[{type:"solid",color:"#FFFFFF"}]}]};
  await writeFile(source,JSON.stringify(original));const snapshot=await createDocumentSnapshotFromText(JSON.stringify(original));const grant=editor.grantFor(source,snapshot.sha256);assert.ok(grant);
  const launched=await request(grant.launchUrl,"POST",{});assert.equal(launched.status,200,await launched.clone().text());const launch=await launched.json();assert.ok(launch.sessionId);assert.equal(typeof launch.docJson,"string");results.push("official managed host launches temporary document");
  const html=await fetch(launch.iframeUrl);assert.equal(html.status,200);assert.match(await html.text(),/html/i);results.push("bundled web editor responds HTTP 200");
  const saved={...original,children:[{...original.children[0],name:"Saved through official controller"}]};const response=await request(launch.saveUrl,"POST",{sessionId:launch.sessionId,docJson:JSON.stringify(saved),generation:0,revision:1});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(JSON.parse(await readFile(source,"utf8")),saved);results.push("official save persists edited document");
  const external={...saved,externalChange:true};await writeFile(source,JSON.stringify(external));const conflict=await request(launch.saveUrl,"POST",{sessionId:launch.sessionId,docJson:JSON.stringify(original),generation:0,revision:2});assert.equal(conflict.status,409);assert.deepEqual(JSON.parse(await readFile(source,"utf8")),external);results.push("external edit produces 409 and is preserved");
  const closed=await request(launch.closeUrl,"DELETE");assert.ok(closed.ok,await closed.text());results.push("managed session closes cleanly");
  const retired=await request(launch.saveUrl,"POST",{sessionId:launch.sessionId,docJson:JSON.stringify(original),generation:0,revision:3});assert.equal(retired.status,410);
  await assert.rejects(fetch(launch.iframeUrl,{signal:AbortSignal.timeout(2000)}));results.push("close revokes session authority and stops native editor process");
  const latest=await createDocumentSnapshotFromText(await readFile(source,"utf8"));const reopenedGrant=editor.grantFor(source,latest.sha256);assert.ok(reopenedGrant);
  const reopening=await request(reopenedGrant.launchUrl,"POST",{});assert.equal(reopening.status,200,await reopening.clone().text());const reopened=await reopening.json();assert.notEqual(reopened.sessionId,launch.sessionId);assert.deepEqual(JSON.parse(reopened.docJson),external);
  const closedAgain=await request(reopened.closeUrl,"DELETE");assert.ok(closedAgain.ok,await closedAgain.text());results.push("same file reopens after close with latest disk content");
  console.log(JSON.stringify({passed:results},null,2));
} finally {detach?.();await editor?.dispose();if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
