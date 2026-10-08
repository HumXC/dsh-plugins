import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { HASHES, VERSION, hash, manage, patch, recoveryClientAnchor, recoveryClientReplacement, recoveryPromptSource } from "../scripts/patch-openpencil.mjs";
let root; const originals = {...HASHES};
const client = 'function ManagedOpenPencilEditor({ onLifecycleController, workbenchActions, allowTakeover = true }) { const documentGrant={path:"a.op"},title="a.op",panelStyles={toolbar:{display:"flex"}};return { style: panelStyles.toolbar, title: documentGrant.path,\n\t\t\t\t\tchildren: title }; }\nfunction mountEditorWorkbenchHost(options) { globalThis.sidebarMounted = true; return null; }'
  + "\nasync function recoveryFixture(launch, localeRef) { let documentJson = 'disk'; const restoredRecoveryRef = {current:false}; " + recoveryClientAnchor + "; return {documentJson, dirty:restoredRecoveryRef.current}; }";
const server = 'export async function apply(ctx) { const accessKey = "test"; const controller = { routeAvailable:true };\n    const editorHost = new EditorHostController(accessKey);\n}';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "op-patch-test-")); await mkdir(join(root,"lib")); await writeFile(join(root,"package.json"),JSON.stringify({name:"@zseven-w/dsh-openpencil",version:VERSION})); for(const [file,text] of [["lib/client.js",client],["lib/index.js",server]]) { HASHES[file]=hash(text); await writeFile(join(root,file),text); } });
afterEach(async () => { Object.assign(HASHES,originals); await rm(root,{recursive:true,force:true}); });
test("apply/check/restore are idempotent and preserve original bytes", async()=>{
  await manage("apply",root); const first=await readFile(join(root,"lib/client.js"),"utf8"); await manage("apply",root);
  assert.equal(await readFile(join(root,"lib/client.js"),"utf8"),first);
  assert.deepEqual((await manage("check",root)).files.map(f=>f.state),["patched","patched"]);
  await manage("restore",root); await manage("restore",root); assert.equal(await readFile(join(root,"lib/client.js"),"utf8"),client);
});
test("unknown bundle and version fail before any mutation",async()=>{
  await writeFile(join(root,"lib/index.js"),server+"// drift"); await assert.rejects(manage("apply",root),/ENOENT|Unsupported|modified/);
  assert.equal(await readFile(join(root,"lib/client.js"),"utf8"),client);
  await writeFile(join(root,"package.json"),JSON.stringify({name:"@zseven-w/dsh-openpencil",version:"future"})); await assert.rejects(manage("apply",root),/Unsupported OpenPencil version/);
});
test("restore refuses edited patched bundles",async()=>{
  await manage("apply",root); const path=join(root,"lib/client.js"); await writeFile(path,await readFile(path,"utf8")+"// user edit");
  await assert.rejects(manage("restore",root),/modified bundle/);
});
test("partially applied patch can be completed and restored",async()=>{
  await manage("apply",root); await writeFile(join(root,"lib/index.js"),server); await manage("apply",root);
  assert.deepEqual((await manage("check",root)).files.map(f=>f.state),["patched","patched"]); await manage("restore",root);
});
test("previous workspace patches upgrade recovery controls and restore original bytes",async()=>{
  await manage("apply",root);
  const current=await readFile(join(root,"lib/client.js"),"utf8");
  const toolbar=current.replace(recoveryPromptSource, "").replace(recoveryClientReplacement, recoveryClientAnchor).replace('className: "dsh-openpencil-workspace-toolbar", ', "");
  const legacy=toolbar.replace("workbenchActions, hideToolbar = false, allowTakeover", "workbenchActions, allowTakeover").replace('style: hideToolbar ? { display: "none" } : panelStyles.toolbar,', "style: panelStyles.toolbar,");
  const titled=legacy.replace("workbenchActions, allowTakeover", "workbenchActions, workbenchTitle, allowTakeover").replace("children: title", "children: workbenchTitle ?? title").replace("  workspaceBridge.runtime = {\n", "  workspaceBridge.runtime = {\n    titleSlot: true,\n");
  for(const previous of [toolbar,legacy,titled]) {
    await writeFile(join(root,"lib/client.js"),previous);
    assert.equal((await manage("check",root)).files[0].state,"outdated");
    await manage("apply",root);assert.equal(await readFile(join(root,"lib/client.js"),"utf8"),current);
  }
  await manage("restore",root);assert.equal(await readFile(join(root,"lib/client.js"),"utf8"),client);
});
test("patched host bypasses the original sidebar and exposes lifecycle adapter",async()=>{
  const bridge={}, calls=[];
  const context={globalThis:{__DSH_OPENPENCIL_WORKSPACE_V1__:bridge},ManagedOpenPencilEditor:()=>null,editorWorkbenchEditorKey:()=>"key",editorLocaleFromDsh:x=>x,isPublishedSuccessorOfLiveDraft:()=>false,preserveEditorBeforeWorkbenchDispose:async()=>"clean",Event:class{}};
  const mount=runInNewContext(patch("lib/client.js",client)+";mountEditorWorkbenchHost;",context);
  const host=mount({}); assert.equal(context.globalThis.sidebarMounted,undefined);
  assert.equal(await host.openIfIdle({}),false); await assert.rejects(host.open({}),/Enable dsh-openpencil-workspace/);
  bridge.handler={open:async(r,automatic)=>{calls.push(automatic);return true;},dispose:async()=>calls.push("dispose")};
  await host.open({}); await host.openIfIdle({}); await host.dispose(); await host.dispose();
  assert.deepEqual(calls,[false,true,"dispose"]); assert.equal(bridge.runtime.Editor,context.ManagedOpenPencilEditor);
  assert.equal(bridge.runtime.titleSlot,undefined);
  assert.equal(bridge.runtime.Editor({hideToolbar:true}).style.display,"none");
  assert.equal(bridge.runtime.Editor({}).style.display,"flex");
  assert.equal(bridge.runtime.Editor({}).children,"a.op");
  assert.equal(bridge.runtime.Editor({}).className,"dsh-openpencil-workspace-toolbar");
});
function recoveryHarness(answers, {conflict=true, locale="zh-CN", failRestore=false, failDiscard=false}={}) {
  const launch={sessionId:"editor-session", recovery:{id:"recovery-id",sourceName:"design.op",sourceChangedSinceCapture:conflict}};
  const messages=[], calls=[];
  let retained=true;
  const run=runInNewContext(patch("lib/client.js",client)+";recoveryFixture;", {
    window:{confirm(message){messages.push(message);assert.ok(answers.length,"Unexpected extra confirmation");return answers.shift();}},
    editorRecoveryCopy(){return {conflict:name=>"conflict:"+name,available:name=>"available:"+name};},
    async restoreManagedEditorRecovery(actualLaunch,recovery){
      assert.equal(actualLaunch,launch);assert.equal(recovery,launch.recovery);calls.push("restore");
      if(failRestore) throw new Error("restore failed");return "recovered";
    },
    async discardManagedEditorRecovery(actualLaunch,recovery){
      assert.equal(actualLaunch,launch);assert.equal(recovery,launch.recovery);calls.push("discard");
      if(failDiscard) throw new Error("discard failed");retained=false;
    }
  });
  return {run:()=>run(launch,{current:locale}),messages,calls,retained:()=>retained};
}
test("restoring loads the draft as dirty and retains recovery until Save",async()=>{
  const h=recoveryHarness([true]);const result=await h.run();
  assert.equal(result.documentJson,"recovered");assert.equal(result.dirty,true);
  assert.equal(h.retained(),true);assert.deepEqual(h.calls,["restore"]);assert.equal(h.messages.length,1);
  assert.equal(h.messages[0],"conflict:design.op");
});
test("cancelling both confirmations keeps disk contents and the recovery draft",async()=>{
  const h=recoveryHarness([false,false]);const result=await h.run();
  assert.equal(result.documentJson,"disk");assert.equal(result.dirty,false);assert.equal(h.retained(),true);
  assert.deepEqual(h.calls,[]);assert.match(h.messages[1],/永久放弃 design.op/);
  assert.match(h.messages[1],/取消：保留恢复稿，下次打开仍会提示/);
});
test("only explicit discard confirmation removes recovery and keeps disk contents",async()=>{
  const h=recoveryHarness([false,true]);const result=await h.run();
  assert.equal(result.documentJson,"disk");assert.equal(result.dirty,false);assert.equal(h.retained(),false);
  assert.deepEqual(h.calls,["discard"]);assert.match(h.messages[1],/源文件保持不变/);
});
test("unchanged source and English locale use the appropriate recovery choices",async()=>{
  const h=recoveryHarness([false,true],{conflict:false,locale:"en-US"});await h.run();
  assert.equal(h.messages[0],"available:design.op");assert.match(h.messages[1],/permanently discard/);
  assert.match(h.messages[1],/without changing the source file/);assert.equal(h.retained(),false);
});
test("restore and discard failures remain visible and never silently lose recovery",async()=>{
  const restore=recoveryHarness([true],{failRestore:true});
  await assert.rejects(restore.run(),/restore failed/);assert.equal(restore.retained(),true);assert.equal(restore.messages.length,1);
  const discard=recoveryHarness([false,true],{failDiscard:true});
  await assert.rejects(discard.run(),/discard failed/);assert.equal(discard.retained(),true);
});
