'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const sales=require('../sales-dialogue.js'),{createGrowth}=require('../growth.js');
const agent={...sales.validateSales({salesEnabled:true,salesRequired:['need','quantity','timing','budget']}),collectEnabled:true};
const step=(c,raw,message)=>sales.advance(agent,c,raw,message,{messageId:'m-'+(c.salesState?.version||0),at:100,model:'test'});
test('sales facts require verbatim evidence in current customer message; corrections replace and keep provenance',()=>{
  const first=step({}, {facts:{need:{value:'做陶艺',evidence:'我想做陶艺'},quantity:{value:'四人',evidence:'四人'},budget:{value:'300元',evidence:'预算200元'}}},'我想做陶艺，四人，预算200元');
  assert.equal(first.state.facts.need.value,'做陶艺');assert.equal(first.state.facts.quantity.value,'四人');assert.equal(first.state.facts.budget,undefined);
  const next=step({salesState:first.state},{facts:{quantity:{value:'三人',evidence:'改成三人'},need:{value:'做陶艺',evidence:'我想做陶艺'}}},'改成三人');
  assert.equal(next.state.facts.quantity.value,'三人');assert.equal(next.state.facts.need.evidence,'我想做陶艺');assert.equal(next.state.facts.quantity.messageId,'m-1');
});
test('sales questions are asked once, known and declined fields skipped; no premature CRM conversion',()=>{
  let c={},result;
  for(let i=0;i<6;i++){result=step(c,{},'我先了解一下');c={salesState:result.state};}
  assert.equal(result.question,'');assert.deepEqual(Object.values(c.salesState.asked),[1,1,1,1]);assert.equal(c.salesState.stage,undefined);
  const refused=step(c,{declined:[{field:'budget',evidence:'预算不想说'}]},'预算不想说，微信也不想给');
  assert.deepEqual(refused.state.declined,['budget']);assert.equal(refused.state.noContact,true);assert.equal(refused.question,'');
});
test('sales objections avoid new questions, pause/resume respects customer pace, ordinary acknowledgement not consent',()=>{
  const objection=step({}, {objection:{kind:'price',evidence:'这个价格有点贵'}},'这个价格有点贵');assert.equal(objection.state.phase,'objection');assert.equal(objection.question,'');
  const paused=step({salesState:objection.state},{pause:{evidence:'我暂时不考虑了'}},'我暂时不考虑了');assert.equal(paused.state.phase,'paused');assert.equal(paused.question,'');
  const resumed=step({salesState:paused.state},{resume:{evidence:'我想继续了解'},resolvedObjection:{evidence:'价格现在可以接受'}},'我想继续了解，价格现在可以接受');assert.equal(resumed.state.paused,false);assert.equal(resumed.state.objections[0].resolved,true);
  assert.equal(step({}, {confirmed:{evidence:'好的知道了'}},'好的知道了').handoff,false);
  assert.equal(step({salesState:{...sales.empty(),phase:'next_step'}},{confirmed:{evidence:'不可以'}},'不可以').handoff,false);
});
test('sales confirmation requires an explicit next step and produces a factual, non-transactional summary',()=>{
  const full=sales.advance({...agent,salesRequired:[]},{},{},'我了解了',{at:100});assert.equal(full.state.phase,'next_step');assert.match(full.question,/人工/);
  const confirmed=step({salesState:full.state},{confirmed:{evidence:'可以，交给同事确认'}},'可以，交给同事确认');assert.equal(confirmed.handoff,true);assert.equal(confirmed.state.phase,'handoff');
  assert.match(sales.summary({name:'合成访客',salesState:confirmed.state}),/不代表已报价/);
  assert.equal(sales.advance({...agent,collectEnabled:false},{},{},'我想了解'),null);
  assert.equal(step({salesState:{...sales.empty(),turns:11}},{},'你好').handoff,true);
});
function setup(options={}){
  const db=new DatabaseSync(':memory:');
  const args={db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,clock:()=>100,...options};
  const app=createGrowth(args),call=async(method,path,body)=>{const r={};await app.handle({method,body},r,new URL('http://localhost/api/growth'+path));return r;};
  return {db,app,call,args};
}
test('sales memory commits only with delivered AI reply, survives restart, supports correction and internal-only handoff',async t=>{
  let raw={reply:'可以根据实际需求选择体验。',handoff:false,sales:{facts:{need:{value:'做陶艺',evidence:'我想做陶艺'}}}};
  const {db,app,call,args}=setup({modelCall:async()=>raw});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'合成体验店',salesEnabled:true,salesRequired:['need','quantity']});
  let c=app.newConversation({name:'合成访客'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'我想做陶艺');await app.autoReply(c.id);await app.autoReply(c.id);
  let current=app.get('conversation',c.id);assert.equal(current.salesState.turns,1);assert.equal(current.salesState.asked.quantity,1);assert.equal(app.all('salesTurn').length,1);
  const resumed=createGrowth(args);assert.equal(resumed.get('conversation',c.id).salesState.facts.need.value,'做陶艺');
  raw={reply:'我会把需求交给同事核实，尚未确认预约。',handoff:false,sales:{facts:{quantity:{value:'三个人',evidence:'我们三个人'}},confirmed:{evidence:'交给同事确认'}}};
  app.receive(current,'我们三个人，交给同事确认');await app.autoReply(c.id);current=app.get('conversation',c.id);
  assert.equal(current.status,'human');assert.equal(current.salesState.phase,'handoff');assert.equal(app.get('lead',c.id).stage,'new');assert.equal(app.all('task').length,1);
  const detail=await call('GET','/conversations/'+c.id);assert.match(detail.data.salesSummary,/三个人/);assert.equal(detail.data.salesTimeline.length,2);
  assert.ok(app.visitorMessages(c.id).every(m=>!('salesState' in m)&&!('refs' in m)&&!('retrieval' in m)));
  const reset=await call('POST','/conversations/'+c.id+'/sales-reset',{expectedVersion:current.salesState.version});assert.equal(reset.status,200);assert.equal(Object.keys(reset.data.salesState.facts).length,0);assert.equal(app.all('salesTurn').length,2);
  assert.equal((await call('POST','/conversations/'+c.id+'/sales-reset',{expectedVersion:current.salesState.version})).status,409);
});
test('sales model races: manual takeover or reset discards state and reply',async t=>{
  let ready,release;const started=new Promise(r=>ready=r);
  const {db,app,call}=setup({modelCall:async()=>{ready();return new Promise(r=>release=r)}});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'合成体验店',salesEnabled:true});
  let c=app.newConversation({name:'访客'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'我要做陶艺');
  const pending=app.autoReply(c.id);await started;await call('PATCH','/conversations/'+c.id,{status:'human'});
  release({reply:'可以',handoff:false,sales:{facts:{need:{value:'做陶艺',evidence:'我要做陶艺'}}}});
  assert.equal((await pending).skipped,true);assert.equal(app.get('conversation',c.id).salesState,undefined);assert.equal(app.all('salesTurn').length,0);
});
test('sales suggestions and disabled extraction do not persist memory or ask for contact',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'可以先了解。',handoff:false,sales:{facts:{need:{value:'陶艺',evidence:'想做陶艺'}}}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'体验店',salesEnabled:true});
  let c=app.newConversation({name:'访客'});app.receive(c,'想做陶艺');
  await call('POST','/conversations/'+c.id+'/suggest',{});assert.equal(app.get('conversation',c.id).salesState,undefined);
  await call('PATCH','/agent/default',{collectEnabled:false});await call('PATCH','/conversations/'+c.id,{status:'ai'});
  assert.equal(app.get('conversation',c.id).salesState,undefined);assert.equal(app.all('salesTurn').length,0);
});
test('handoff never marks an unasked planned question as asked',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'需要同事核实实时余位。',handoff:true,reason:'需要实时余位',sales:{facts:{need:{value:'陶艺',evidence:'陶艺还有余位吗'}}}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'体验店',salesEnabled:true,salesRequired:['need','quantity']});
  let c=app.newConversation({name:'访客'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'陶艺还有余位吗');await app.autoReply(c.id);
  assert.equal(app.get('conversation',c.id).status,'human');assert.deepEqual(app.get('conversation',c.id).salesState.asked,{});
});
test('reset starts a fresh original request; legacy in-progress state can recover its first request',()=>{
  const firstMessage={id:'old',content:'上次想做陶艺',ts:1};
  const fresh=sales.advance(agent,{salesState:sales.empty(5)},{},'现在想了解绘画',{firstMessage,messageId:'new',at:100});
  assert.equal(fresh.state.originalRequest.evidence,'现在想了解绘画');assert.equal(fresh.state.originalRequest.messageId,'new');
  const legacy=sales.advance(agent,{salesState:{...sales.empty(),turns:3}},{},'继续上次咨询',{firstMessage,messageId:'new',at:100});
  assert.equal(legacy.state.originalRequest.evidence,firstMessage.content);
});
test('human reply, visitor handoff and model failure keep sales phase consistent',async t=>{
  const {db,app,call}=setup({modelCall:async()=>{throw new Error('offline')}});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'体验店',salesEnabled:true});
  const make=()=>{let c=app.newConversation({name:'阶段验收'});return app.put('conversation',{...c,status:'ai',salesState:{...sales.empty(2),turns:2}},c.id)};
  const human=make();await app.send(human,'您好，由我继续接待。','human-proof','human');
  assert.equal(app.get('conversation',human.id).salesState.phase,'handoff');assert.equal(app.get('conversation',human.id).salesState.version,3);
  const visitor=make();app.put('conversation',{...visitor,status:'human'},visitor.id);app.stopAutomation(visitor.id,'网页访客申请人工服务');
  assert.equal(app.get('conversation',visitor.id).salesState.phase,'handoff');
  const failed=make();app.receive(failed,'请介绍体验');await app.autoReply(failed.id);
  assert.equal(app.get('conversation',failed.id).status,'human');assert.equal(app.get('conversation',failed.id).salesState.phase,'handoff');assert.match(app.get('conversation',failed.id).salesState.nextAction,/失败/);
});
test('reset excludes old chat from new model context while retaining history and no-contact preference',async t=>{
  let payload;
  const {db,app,call}=setup({modelConfig:()=>({model:'test',complete:async p=>{payload=p;return {choices:[{message:{content:JSON.stringify({reply:'可以重新了解。',handoff:false,sales:{}})}}]}}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'体验店',salesEnabled:true});
  const c=app.newConversation({name:'访客'});app.receive(c,'旧方案六人');let current=app.get('conversation',c.id);
  app.put('conversation',{...current,status:'human',salesState:{...sales.empty(2),turns:2,noContact:true}},c.id);
  const reset=await call('POST','/conversations/'+c.id+'/sales-reset',{expectedVersion:2});assert.equal(reset.status,200);assert.equal(reset.data.salesState.noContact,true);
  assert.deepEqual(sales.contextHistory(reset.data,app.history(c.id)),[]);assert.equal(app.history(c.id).length,1);
  current=app.put('conversation',{...reset.data,status:'ai'},c.id);app.receive(current,'现在只我一个人');await app.autoReply(c.id);
  assert.ok(!JSON.stringify(payload.messages).includes('旧方案六人'));assert.equal(app.get('conversation',c.id).salesState.originalRequest.evidence,'现在只我一个人');
});
test('paused sales mode removes model-authored questions even when no server question is scheduled',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'好的。方便留个电话吗？',handoff:false,sales:{pause:{evidence:'暂时先不考虑'}}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'体验店',salesEnabled:true});
  let c=app.newConversation({name:'访客'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'暂时先不考虑');await app.autoReply(c.id);
  assert.equal(app.history(c.id).at(-1).content,'好的。');assert.equal(app.get('conversation',c.id).salesState.phase,'paused');
});
