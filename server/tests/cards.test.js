'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth.js');
function setup(t){
  const db=new DatabaseSync(':memory:');let now=1800000000;t.after(()=>db.close());
  const options={db,clock:()=>now,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body};
  let app=createGrowth(options);
  const call=async(method,path,body)=>{const r={};await app.handle({method,body},r,new URL('http://localhost/api/growth'+path));return r;};
  const card=async(b={})=>(await call('POST','/card',{name:'预约指引',title:'预约需人工确认',body:'请提供日期，由同事确认空位。',enabled:true,trigger:'high_intent',channel:'sandbox',keywords:['预约'],excludeKeywords:['取消'],cooldownMinutes:10,dailyLimit:2,...b})).data;
  return {get app(){return app;},call,card,advance:n=>now+=n,restart:()=>app=createGrowth(options)};
}
test('cards: channel and keyword rules produce one durable suggestion, never send automatically',async t=>{
  const s=setup(t);await s.card();const c=s.app.newConversation({name:'卡片测试'});
  s.app.receive(c,'想预约周末',{id:'first'});s.app.receive(c,'想预约周末',{id:'first'});
  let detail=(await s.call('GET','/conversations/'+c.id)).data;
  assert.equal(detail.cardSuggestions.length,1);assert.equal(detail.cardSuggestions[0].available,true);
  assert.deepEqual(detail.messages.map(m=>m.role),['customer']);
  s.restart();detail=(await s.call('GET','/conversations/'+c.id)).data;assert.equal(detail.cardSuggestions.length,1);
  const adopted=await s.call('POST',`/conversations/${c.id}/cards/${detail.cardSuggestions[0].id}/adopt`,{});
  assert.equal(adopted.status,200);assert.match(adopted.data.text,/预约需人工确认/);assert.equal(s.app.history(c.id).length,1);
  assert.equal((await s.call('POST',`/conversations/${c.id}/cards/${detail.cardSuggestions[0].id}/adopt`,{})).status,409);
});
test('cards: exclude, all-keywords, cooldown, pending dedupe and 24-hour frequency are enforced',async t=>{
  const s=setup(t);await s.card({keywords:['预约','周末'],matchMode:'all'});const c=s.app.newConversation({name:'频控'});
  const incoming=text=>s.app.receive(s.app.get('conversation',c.id),text);
  incoming('预约');incoming('取消周末预约');assert.equal(s.app.all('cardSuggestion').length,0);
  incoming('周末预约');incoming('周末预约');assert.equal(s.app.all('cardSuggestion').length,1);
  const dismiss=async()=>{const item=s.app.all('cardSuggestion').find(x=>x.status==='pending');await s.call('POST',`/conversations/${c.id}/cards/${item.id}/dismiss`,{});};
  await dismiss();s.advance(599);incoming('周末预约');assert.equal(s.app.all('cardSuggestion').length,1);
  s.advance(1);incoming('周末预约');assert.equal(s.app.all('cardSuggestion').length,2);await dismiss();
  s.advance(600);incoming('周末预约');assert.equal(s.app.all('cardSuggestion').length,2);
  s.advance(86400);incoming('周末预约');assert.equal(s.app.all('cardSuggestion').length,3);
  const other=s.app.newConversation({name:'其他渠道',channel:'web',sourceKind:'dm'});s.app.receive(other,'周末预约');assert.equal(s.app.all('cardSuggestion').length,3);
});
test('cards: stale, disabled, expired, opted-out and cross-conversation suggestions cannot be adopted',async t=>{
  const s=setup(t),card=await s.card(),c=s.app.newConversation({name:'时效'});s.app.receive(c,'预约');
  const item=s.app.all('cardSuggestion')[0],path=`/conversations/${c.id}/cards/${item.id}/adopt`;
  const other=s.app.newConversation({name:'别人'});assert.equal((await s.call('POST',`/conversations/${other.id}/cards/${item.id}/adopt`,{})).status,404);
  await s.call('PATCH','/card/'+card.id,{enabled:false});assert.equal((await s.call('POST',path,{})).status,409);
  await s.call('PATCH','/card/'+card.id,{enabled:true,title:'新内容'});assert.match((await s.call('POST',path,{})).data.error,/更新/);
  await s.call('PATCH','/card/'+card.id,{title:card.title});s.advance(86400);assert.match((await s.call('POST',path,{})).data.error,/过期/);
  s.app.receive(s.app.get('conversation',c.id),'预约');const fresh=s.app.all('cardSuggestion').find(x=>x.id!==item.id);assert.ok(fresh);
  s.app.receive(s.app.get('conversation',c.id),'别再联系，退订');assert.equal(s.app.all('cardSuggestion').length,2);
  assert.match((await s.call('POST',`/conversations/${c.id}/cards/${fresh.id}/adopt`,{})).data.error,/停止联系/);
});
test('cards: imports do not trigger marketing and invalid links are rejected',async t=>{
  const s=setup(t);await s.card({channel:'all'});const c=s.app.newConversation({name:'历史'});s.app.receive(c,'预约',{imported:true});assert.equal(s.app.all('cardSuggestion').length,0);
  for(const url of ['javascript:alert(1)','https://','https://user:secret@example.com'])assert.equal((await s.call('POST','/card',{name:'卡片',title:'标题',url})).status,400);
});
