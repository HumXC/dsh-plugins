#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, cp, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { Script } from "node:vm";
import { registerHooks } from "node:module";
import { manage, HASHES, hash } from "./patch-openpencil.mjs";
import { apply as applyWorkspace } from "../lib/index.js";
const source=resolve(process.argv[2]??"");if(!process.argv[2]||!process.argv[3])throw new Error("Usage: node scripts/validate-patch.mjs /path/to/@zseven-w/dsh-openpencil /path/to/@deepseek-ai/dsh");
const sdkParent=pathToFileURL(join(resolve(process.argv[3]),"package.json")).href;
// DSH supplies these SDK modules to plugins; reproduce that fallback only inside this subprocess.
const resolver=registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(error.code!=="ERR_MODULE_NOT_FOUND"||!specifier.startsWith("@deepseek-ai/"))throw error;return nextResolve(specifier,{...context,parentURL:sdkParent});}}});
const temp=await mkdtemp(join(tmpdir(),"op-workspace-patch-")),copy=join(temp,"official");process.env.DSH_HOME=join(temp,"state");
const cleanups=[],routes=[],services=new Map();let officialDispose,server;
try {
  await cp(join(source,"lib"),join(copy,"lib"),{recursive:true});
  for (const file of ["package.json", "platforms.json"]) await cp(join(source,file),join(copy,file));
  await symlink(resolve(source,"../.."),join(copy,"node_modules"),"dir");
  await manage("apply",copy);assert.ok((await manage("check",copy)).files.every(item=>item.state==="patched"));
  new Script(await readFile(join(copy,"lib/client.js"),"utf8"));
  const ctx={fs:{resolve:async(path,{cwd})=>resolve(cwd,path),processPath:path=>path,readBytes:async(path)=>readFile(path)},sessions:{get:id=>id==="validation-session"?{}:undefined},sandboxPolicy:{resolve:()=>({mode:"workspace-write",workspaceRoot:temp})},
    logger:{info:()=>{},warn:()=>{}},tools:{register:()=>()=>{}},on:()=>()=>{},emit:()=>{},
    provide:(name,value)=>services.set(name,value),get:name=>services.get(name),
    effect(fn){let cleanup=fn(),active=true;const stop=async()=>{if(active){active=false;await cleanup?.();}};cleanups.push(stop);return stop;},
    inject(names,fn){fn(ctx);return{dispose:()=>{}};},webServer:{register:route=>{routes.push(route);return()=>{};}}};
  const {apply}=await import(pathToFileURL(join(copy,"lib/index.js")));officialDispose=await apply(ctx);applyWorkspace(ctx);
  assert.equal(services.get("openpencilWorkspaceHost")?.version,1);
  server=createServer((req,res)=>{const path=new URL(req.url,"http://localhost").pathname,route=routes.find(r=>r.kind==="exact"?r.path===path:path.startsWith(r.path));if(!route){res.writeHead(404);res.end();}else void route.handler(req,res);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin="http://127.0.0.1:"+server.address().port;
  const post=(path,body)=>fetch(new URL(path,origin),{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const document=join(temp,"file.op");await writeFile(document,JSON.stringify({version:"1.0.0",children:[{id:"r",type:"frame",width:400,height:300}]}));
  const response=await post("/_dsh/openpencil-workspace/open",{sessionId:"validation-session",path:document});assert.equal(response.status,200,await response.clone().text());const {grant}=await response.json();assert.equal(grant.sourcePath,document);assert.ok(grant.document.url);assert.ok(grant.editor.launchUrl);
  const snapshot=await fetch(new URL(grant.document.url,origin));assert.equal(snapshot.status,200);assert.equal(JSON.parse(await snapshot.text()).children[0].id,"r");
  const launch=await post(grant.editor.launchUrl,{});assert.equal(launch.status,200,await launch.clone().text());const session=await launch.json();assert.equal((await fetch(session.iframeUrl)).status,200);
  await fetch(new URL(session.closeUrl,origin),{method:"DELETE",headers:{Origin:origin}});
  await manage("restore",copy);for(const [file,expected]of Object.entries(HASHES)){assert.equal(hash(await readFile(join(source,file))),expected,"original installed bundle untouched");assert.equal(hash(await readFile(join(copy,file))),expected,"copied bundle restored");}
  console.log(JSON.stringify({passed:["real official bundles patch and parse","patched backend exports capability service","add-on HTTP endpoint returns official grant","snapshot and native editor open through registered routes","copied patch rolls back; installed bundles unchanged"]},null,2));
} finally {await officialDispose?.();for(const cleanup of cleanups.reverse())await cleanup();if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
