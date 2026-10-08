import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { AnalysisCoordinator } from "../lib/analysis-coordinator.js";
import { resolveConfig } from "../lib/config.js";
import { McpConnectionRouter } from "../lib/mcp-router.js";
import { ManagedStdioTransport } from "../lib/managed-stdio-transport.js";
import { acquireWorkspaceLease } from "../lib/workspace-lock.js";
const result = { content: [{ type: "text", text: "ok" }] };
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),"gitnexus-router-")); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const child=join(root,"child"); for(const path of [root,child]) {mkdirSync(join(path,".gitnexus"),{recursive:true});writeFileSync(join(path,".gitnexus/meta.json"),"{}");}
 const analysis=new AnalysisCoordinator();const router=new McpConnectionRouter({},resolveConfig(),new AbortController().signal,()=>{},analysis);
 return {root,child,router,analysis};
}
function mockSlot(client = {}, transport = {}) {
 return {client:{listTools:async()=>({tools:["query","context","cypher","rename"].map(name=>({name,inputSchema:{type:"object"}}))}),callTool:async()=>result,close:async()=>{},...client},transport:{isClosed:false,close:async()=>{},...transport}};
}

test("serializes same workspace operations and closes backend before next caller",async t=>{
 const {root,router}=fixture(t);let finish;const first=new Promise(resolve=>{finish=resolve});const events=[];let calls=0;
 router.connect=async()=>mockSlot({callTool:async()=>{events.push("start");return ++calls===1?first:result;},close:async()=>{events.push("close");}});
 const a=router.callTool(root,"query",{search_query:"a"},new AbortController().signal);
 await delay(20);const b=router.callTool(root,"query",{search_query:"b"},new AbortController().signal);await delay(30);assert.deepEqual(events,["start"]);
 finish(result);assert.deepEqual(await a,result);assert.deepEqual(await b,result);assert.deepEqual(events,["start","close","start","close"]);
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});
test("parent-scoped child query takes the child physical index lease",async t=>{
 const {root,child,router}=fixture(t);const childLease=await acquireWorkspaceLease(child);let connected=false;
 router.connect=async()=>{connected=true;return mockSlot()};
 const call=router.callTool(root,"context",{repo:child,name:"x"},new AbortController().signal);await delay(40);assert.equal(connected,false);childLease.release();assert.deepEqual(await call,result);
});
test("unconfirmed backend close retains lease rather than admitting a writer",async t=>{
 const {root,router}=fixture(t);router.connect=async()=>mockSlot({}, {close:async()=>{throw new Error("exit unconfirmed");}});
 await assert.rejects(router.callTool(root,"query",{search_query:"x"},new AbortController().signal),/unconfirmed/);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);
});
test("rebuilding workspace is rejected before a new backend starts",async t=>{
 const {root,router,analysis}=fixture(t);analysis.begin(root);await assert.rejects(router.callTool(root,"query",{search_query:"x"},new AbortController().signal),/being rebuilt/);
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});

function backend(t, options = {}) {
 const state = {starts: [], stops: 0, requests: [], exitWaits: 0};
 const lifetime = new AbortController();
 const subprocess = {spawn(spec) {
  state.starts.push(spec);
  if (options.spawnError) throw new Error(options.spawnError);
  const stdin = new PassThrough(), stdout = new PassThrough();
  let settle, closed = false, buffer = "";
  const done = new Promise(resolve => {settle = resolve});
  const terminate = () => {if (!closed) {closed = true; state.stops++; settle({exitCode:0});}};
  spec.signal.addEventListener("abort", terminate, {once:true});
  done.then(()=>spec.signal.removeEventListener("abort",terminate));
  stdin.on("data", chunk => {
   buffer += chunk.toString();
   while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
    state.requests.push(request);
    if (request.id === undefined || closed || options.hang === request.method) continue;
    let response;
    if (request.method === "initialize") response = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"mock-gitnexus",version:"1"}};
    if (request.method === "tools/list") response = options.list ? options.list(request.params) : {tools:(options.tools ?? ["query"]).map(tool=>typeof tool === "string"?{name:tool,inputSchema:{type:"object"}}:tool)};
    if (request.method === "tools/call") response = options.callResult ?? result;
    const respond = () => {if (!closed) stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:response})+"\n")};
    if (options.responseDelay) setTimeout(respond, options.responseDelay); else queueMicrotask(respond);
   }
  });
  return {stdin,stdout,collected:{},done,terminate,waitForExit:async()=>{state.exitWaits++;if(options.exitError)throw new Error(options.exitError);if(options.waitForExit)return options.waitForExit();await done;return true}};
 }};
 const router = new McpConnectionRouter(subprocess,resolveConfig({toolCallTimeoutMs:options.timeout ?? 500,maxConnections:options.maxConnections ?? 4}),lifetime.signal,()=>{});
 t.after(async()=>{lifetime.abort();await router.dispose()});
 return {router,state,options,lifetime};
}

test("diagnostics never starts a process and returns defensive workspace-local snapshots",async t=>{
 const {root,child}=fixture(t), {router,state}=backend(t);
 assert.deepEqual(router.getDiagnostics(root),{state:"unknown",supportedTools:[]});
 assert.equal(state.starts.length,0);
 await router.callTool(root,"query",{search_query:"x"},new AbortController().signal);
 const snapshot=router.getDiagnostics(root);assert.deepEqual(snapshot,{state:"ready",supportedTools:["query"]});
 snapshot.supportedTools.push("spoof");assert.deepEqual(router.getDiagnostics(join(root,".")),{state:"ready",supportedTools:["query"]});
 assert.deepEqual(router.getDiagnostics(child),{state:"unknown",supportedTools:[]});
 assert.equal(state.starts.length,1);assert.equal(state.stops,1);
 assert.equal(state.starts[0].cwd,root);assert.equal(state.starts[0].env.GITNEXUS_HOME,join(root,".gitnexus/runtime"));
 assert.equal(router.connections.size,0);assert.equal(router.pending.size,0);
});

test("a failed backend connection remains retryable on the next tool invocation",async t=>{
 const {root}=fixture(t), {router,state,options}=backend(t,{spawnError:"backend unavailable"});
 await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/backend unavailable/);
 assert.deepEqual(router.getDiagnostics(root),{state:"unavailable",supportedTools:[],lastError:"backend unavailable"});
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
 delete options.spawnError;assert.deepEqual(await router.callTool(root,"query",{},new AbortController().signal),result);
 assert.equal(state.starts.length,2);assert.deepEqual(router.getDiagnostics(root),{state:"ready",supportedTools:["query"]});
});

test("missing optional api_impact only rejects that tool and does not disable query",async t=>{
 const {root}=fixture(t), {router,state}=backend(t);
 await assert.rejects(router.callTool(root,"api_impact",{},new AbortController().signal),/does not support tool: api_impact/);
 assert.equal(router.getDiagnostics(root).state,"ready");assert.match(router.getDiagnostics(root).lastError,/api_impact/);
 assert.equal(state.requests.filter(request=>request.method==="tools/call").length,0);
 assert.deepEqual(await router.callTool(root,"query",{},new AbortController().signal),result);
 assert.equal(router.getDiagnostics(root).lastError,undefined);
 assert.equal(state.stops,2);
});

test("reported MCP tool errors remain visible in diagnostics and clear after recovery", async t => {
 const {root}=fixture(t), failure={isError:true,content:[{type:"text",text:"index checkpoint is in progress"}]};
 const {router,options}=backend(t,{callResult:failure});
 assert.deepEqual(await router.callTool(root,"query",{},new AbortController().signal),failure);
 assert.deepEqual(router.getDiagnostics(root),{state:"ready",supportedTools:["query"],lastError:"index checkpoint is in progress"});
 options.callResult={isError:true,content:[{type:"text",text:"x".repeat(4_000)}]};
 await router.callTool(root,"query",{},new AbortController().signal);
 assert.equal(router.getDiagnostics(root).lastError.length,2_000);
 delete options.callResult;
 assert.deepEqual(await router.callTool(root,"query",{},new AbortController().signal),result);
 assert.deepEqual(router.getDiagnostics(root),{state:"ready",supportedTools:["query"]});
});


test("runtime discovery rejects required MCP task execution before dispatch",async t=>{
 const {root}=fixture(t), {router,state}=backend(t,{tools:[{name:"query",inputSchema:{type:"object"},execution:{taskSupport:"required"}}]});
 await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/requires unsupported MCP task execution: query/);
 assert.equal(state.requests.filter(request=>request.method==="tools/call").length,0);assert.equal(state.stops,1);
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});

for (const stage of ["initialize","tools/list","tools/call"]) {
 test(`tool deadline bounds stalled ${stage} and cleans the process and lease`,async t=>{
  const {root}=fixture(t), {router,state}=backend(t,{hang:stage,timeout:35});
  await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/timed out/i);
  assert.equal(state.stops,1);assert.equal(router.connections.size,0);assert.equal(router.pending.size,0);
  assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
  assert.match(router.getDiagnostics(root).lastError,/timed out/i);
 });
 test(`caller cancellation during ${stage} closes process before releasing lease`,async t=>{
  const {root}=fixture(t), {router,state}=backend(t,{hang:stage}), controller=new AbortController();
  const call=router.callTool(root,"query",{},controller.signal);
  await delay(10);controller.abort(new Error("caller cancelled"));await assert.rejects(call,/caller cancelled/);
  assert.equal(state.stops,1);assert.equal(router.connections.size,0);assert.equal(router.pending.size,0);
  assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
 });
}

test("the deadline spans discovery and execution rather than restarting per request",async t=>{
 const {root}=fixture(t), {router,state}=backend(t,{responseDelay:20,timeout:50});
 await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/timed out/i);
 assert.equal(state.stops,1);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});

test("workspace lease wait obeys tool deadline without starting or releasing another owner",async t=>{
 const {root}=fixture(t), lease=await acquireWorkspaceLease(root), {router,state}=backend(t,{timeout:20});
 try {
  await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/abort|timed out/i);
  assert.equal(state.starts.length,0);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);
 } finally {lease.release()}
});

test("discovery follows pagination and remains public with bounded cleanup",async t=>{
 const {root}=fixture(t), {router,state}=backend(t,{list:params=>params?.cursor?{tools:[{name:"context",inputSchema:{type:"object"}}]}:{tools:[{name:"query",inputSchema:{type:"object"}}],nextCursor:"page2"}});
 assert.deepEqual((await router.discoverTools(root)).map(tool=>tool.name),["query","context"]);
 assert.deepEqual(router.getDiagnostics(root),{state:"ready",supportedTools:["query","context"]});
 assert.equal(state.stops,1);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});

test("failed discovery can retry and a stuck pagination cursor cannot loop forever",async t=>{
 const {root}=fixture(t), {router,state,options}=backend(t,{list:()=>({tools:[],nextCursor:"repeat"})});
 await assert.rejects(router.discoverTools(root),/repeated a pagination cursor/);
 assert.equal(router.getDiagnostics(root).state,"unavailable");assert.equal(state.stops,1);
 delete options.list;assert.deepEqual(await router.callTool(root,"query",{},new AbortController().signal),result);
 assert.equal(router.getDiagnostics(root).state,"ready");
});

test("capabilities and failures stay isolated across concurrent workspace backends",async t=>{
 const {root,child}=fixture(t), {router,state}=backend(t,{tools:["query"]});
 await Promise.all([
  router.callTool(root,"query",{},new AbortController().signal),
  assert.rejects(router.callTool(child,"context",{},new AbortController().signal),/does not support tool: context/),
 ]);
 assert.equal(router.getDiagnostics(root).lastError,undefined);assert.match(router.getDiagnostics(child).lastError,/context/);
 assert.deepEqual(state.starts.map(spec=>spec.cwd).sort(),[root,child].sort());
 assert.deepEqual(state.starts.map(spec=>spec.env.GITNEXUS_HOME).sort(),[join(root,".gitnexus/runtime"),join(child,".gitnexus/runtime")].sort());
 assert.equal(state.stops,2);
});

test("unconfirmed connection cleanup keeps both workspace and child repository leases",async t=>{
 const {root,child}=fixture(t), {router}=backend(t,{spawnError:"connect failed"});
 t.mock.method(ManagedStdioTransport.prototype,"close",async()=>{throw new Error("exit unconfirmed")});
 await assert.rejects(router.callTool(root,"context",{repo:child,name:"x"},new AbortController().signal),/process exit unconfirmed; workspace lease retained/);
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);
 assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),true);
 assert.equal(router.getDiagnostics(root).state,"unavailable");
});

test("a failed refresh retains last known supported tools while remaining retryable",async t=>{
 const {root}=fixture(t), {router,options}=backend(t);
 await router.callTool(root,"query",{},new AbortController().signal);options.spawnError="backend unavailable";
 await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/backend unavailable/);
 assert.deepEqual(router.getDiagnostics(root),{state:"unavailable",supportedTools:["query"],lastError:"backend unavailable"});
 delete options.spawnError;await router.callTool(root,"query",{},new AbortController().signal);
 assert.deepEqual(router.getDiagnostics(root),{state:"ready",supportedTools:["query"]});
});

test("pending handshakes count toward the connection limit",async t=>{
 const {root,child}=fixture(t), {router,state}=backend(t,{hang:"initialize",maxConnections:1}), controller=new AbortController();
 const first=router.callTool(root,"query",{},controller.signal);
 const rejected=assert.rejects(first,/caller cancelled/);
 await delay(10);
 await assert.rejects(router.callTool(child,"query",{},new AbortController().signal),/connections are busy/);
 assert.equal(state.starts.length,1);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),false);
 controller.abort(new Error("caller cancelled"));await rejected;assert.equal(state.stops,1);
});

for (const stage of ["initialize", "tools/list", "tools/call"]) {
 for (const cancelled of [false, true]) {
  test(`${cancelled?"cancellation":"timeout"} during ${stage} bounds never-settling exit cleanup`, {timeout:2000}, async t=>{
   const {root,child}=fixture(t), {router,state}=backend(t,{tools:["context"],hang:stage,timeout:25,waitForExit:()=>new Promise(()=>{})});
   const controller=new AbortController();
   const call=router.callTool(root,"context",{repo:child,name:"x"},controller.signal);
   const rejected=assert.rejects(call,/exit unconfirmed|cleanup timed out/);
   if(cancelled){await delay(10);controller.abort(new Error("caller cancelled"))}
   await rejected;
   assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),true);
   assert.equal(router.connections.size,1);assert.equal(router.pending.size,0);assert.equal(router.getDiagnostics(root).state,"unavailable");
   assert.equal(state.starts.length,1);assert.ok(state.exitWaits>=1);
   await router.dispose();assert.equal(router.connections.size,1);
   await assert.rejects(router.evict(root),/cleanup timed out/);assert.equal(router.connections.size,1);
   assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),true);
  });
 }
}

test("failed connection cleanup reserves capacity and disposal retries owned transport", {timeout:2000}, async t=>{
 const {root,child}=fixture(t), {router,state,options}=backend(t,{hang:"initialize",timeout:25,maxConnections:1,exitError:"range exit unconfirmed"});
 await assert.rejects(router.callTool(root,"query",{},new AbortController().signal),/exit unconfirmed/);
 assert.equal(router.connections.size,1);assert.equal(router.pending.size,0);
 const firstWaits=state.exitWaits;assert.ok(firstWaits>0);
 await assert.rejects(router.callTool(child,"query",{},new AbortController().signal),/connections are busy/);assert.equal(state.starts.length,1);
 assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),false);
 delete options.exitError;await router.dispose();
 assert.ok(state.exitWaits>firstWaits);assert.equal(router.connections.size,0);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
 assert.equal(router.getDiagnostics(root).state,"unavailable");
});

test("late cleanup settlement cannot release quarantined leases or delete records", {timeout:2000}, async t=>{
 const {root,child}=fixture(t);let finish;const exit=new Promise(resolve=>{finish=resolve});
 const {router}=backend(t,{tools:["context"],timeout:20,waitForExit:()=>exit});
 await assert.rejects(router.callTool(root,"context",{repo:child,name:"x"},new AbortController().signal),/cleanup timed out/);
 finish(true);await delay(1);
 assert.equal(router.connections.size,1);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),true);
 await router.evict(root);assert.equal(router.connections.size,0);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);assert.equal(existsSync(join(child,".gitnexus/coordination.lock")),false);
});

test("dispose aborts pending handshakes and itself bounds unconfirmed range exit", {timeout:2000}, async t=>{
 const {root}=fixture(t), {router}=backend(t,{hang:"initialize",timeout:25,waitForExit:()=>new Promise(()=>{})});
 const call=router.callTool(root,"query",{},new AbortController().signal);const rejected=assert.rejects(call,/exit unconfirmed/);
 await delay(5);await router.dispose();await rejected;
 assert.equal(router.connections.size,1);assert.equal(router.pending.size,0);assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),true);
});

test("a late connect continuation cannot reinsert a disposed connection",async t=>{
 const {root,router}=fixture(t);let finish;const connecting=new Promise(resolve=>{finish=resolve});
 router.connect=()=>connecting;const call=router.callTool(root,"query",{},new AbortController().signal);
 const rejected=assert.rejects(call,/router is disposed/);
 await delay(5);await router.dispose();finish(mockSlot());await rejected;
 assert.equal(router.connections.size,0);assert.equal(router.getDiagnostics(root).state,"unavailable");assert.equal(existsSync(join(root,".gitnexus/coordination.lock")),false);
});
