import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../lib/workspace.js";
import { getBridge } from "../lib/contracts.js";
const request=(path,extras={})=>({sessionId:"s",grant:{sourcePath:path,...extras}});
beforeEach(()=>{getBridge().runtime={key:(g,s)=>g.sourcePath+s,successor:(a,b)=>a.sessionId===b.sessionId&&a.grant.liveDraft&&b.grant.liveDraft===false&&a.grant.draftId===b.grant.draftId};});
test("cancelling unsaved confirmation prevents both replacement and controller close",async()=>{
  let prompts=0,closes=0;const workspace=new Workspace(()=>{prompts++;return false;});
  await workspace.open(request("a.op"),false);workspace.onState({phase:"ready",dirty:true});workspace.onController({requestClose:async()=>{closes++;return true;}});
  assert.equal(await workspace.open(request("b.op"),false),false);assert.equal(await workspace.close(),false);
  assert.equal(prompts,2);assert.equal(closes,0);assert.equal(workspace.getSnapshot().grant.sourcePath,"a.op");
});
test("confirmed dirty close reaches official controller; saving cannot be closed",async()=>{
  let prompts=0,closes=0;const workspace=new Workspace(()=>{prompts++;return true;});
  await workspace.open(request("a.op"),false);workspace.onController({requestClose:async()=>{closes++;return true;}});workspace.onState({phase:"saving",dirty:true});
  assert.equal(await workspace.open(request("b.op"),false),false);assert.equal(await workspace.close(),false);assert.equal(prompts,0);assert.equal(closes,0);
  workspace.onState({phase:"ready",dirty:true});assert.equal(await workspace.open(request("b.op"),false),true);assert.equal(prompts,1);assert.equal(closes,1);
});
test("published draft successor detaches without asking to discard already published edits",async()=>{
  let prompts=0,closes=0;const workspace=new Workspace(()=>{prompts++;return false;});
  await workspace.open(request("live.op",{liveDraft:true,draftId:"d"}),true);workspace.onController({requestClose:async()=>{closes++;return true;}});workspace.onState({phase:"ready",dirty:true});
  assert.equal(await workspace.open(request("published.op",{liveDraft:false,draftId:"d"}),true),true);assert.equal(prompts,0);assert.equal(closes,1);
});
