'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth.js');
const {dayStart}=require('../growth-reports.js');
function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let now=dayStart('2026-10-17')-60;
  const app=createGrowth({db,clock:()=>now,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,sendExternal:async(c,content)=>{if(content==='failed')throw Error('reject');}});
  const call=async(method,path,body)=>{const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(text){this.text=text;}};await app.handle({method,body},res,new URL('http://localhost/api/growth'+path));return res;};
  return {db,app,call,advance:n=>now+=n};
}
test('report date validation uses Shanghai day boundaries and rejects invalid ranges',async t=>{
  const {call}=setup(t);assert.equal(dayStart('2026-10-17'),Date.parse('2026-10-16T16:00:00Z')/1000);
  assert.throws(()=>dayStart('2026-02-30'),/无效/);
  assert.equal((await call('GET','/reports?from=2026-10-18&to=2026-10-17')).status,400);
  assert.equal((await call('GET','/reports?from=2020-01-01&to=2026-10-17')).status,400);
  assert.equal((await call('GET','/reports?channel=not-a-channel')).status,400);
});
test('report excludes test conversations by default, and failed/welcome/note messages from response times',async t=>{
  const {app,call,advance}=setup(t);
  let c=app.newConversation({name:'真实渠道模拟',channel:'wechat',sourceKind:'dm'});app.receive(c,'第一条消息');advance(60);
  app.receive(app.get('conversation',c.id),'连续第二条消息');advance(60);
  await app.send(app.get('conversation',c.id),'欢迎','welcome:'+c.id,'ai');advance(60);
  await app.send(app.get('conversation',c.id),'第一次有效回复','first');
  advance(10);app.receive(app.get('conversation',c.id),'新一轮消息');advance(10);
  await assert.rejects(()=>app.send(app.get('conversation',c.id),'failed','failure'));
  await call('POST','/conversations/'+c.id+'/note',{content:'不应计入回复'});advance(40);
  await app.send(app.get('conversation',c.id),'第二次有效回复','second');
  const local=app.newConversation({name:'测试'});app.receive(local,'测试消息');await app.send(local,'测试回复','local');
  const report=(await call('GET','/reports?from=2026-10-17&to=2026-10-17')).data;
  assert.equal(report.metrics.newConversations,0);assert.equal(report.metrics.incoming,2);assert.equal(report.metrics.outgoing,2);
  assert.equal(report.metrics.replySamples,2);assert.equal(report.metrics.averageReplySeconds,115);assert.equal(report.metrics.medianReplySeconds,115);assert.equal(report.metrics.p95ReplySeconds,180);assert.equal(report.metrics.failedSends,1);
  assert.equal(report.trend.length,1);assert.equal(report.channels.find(c=>c.id==='wechat').outgoing,2);
  const included=(await call('GET','/reports?from=2026-10-17&to=2026-10-17&includeSandbox=1')).data;
  assert.equal(included.metrics.newConversations,1);assert.equal(included.metrics.outgoing,3);
});
test('stage events count real changes once per customer, snapshots remain independent of date',async t=>{
  const {app,call,advance}=setup(t);advance(60);
  const c=app.newConversation({name:'测试'});app.receive(c,'电话 13800000000');
  for(const stage of ['won','qualified','won'])await call('PATCH','/leads/'+c.id,{stage});
  const r=(await call('GET','/reports?from=2026-10-17&to=2026-10-17&includeSandbox=1')).data;
  assert.equal(r.stageReached.find(s=>s.id==='won').count,1);assert.equal(r.stageReached.find(s=>s.id==='qualified').count,1);assert.equal(r.stageReached.find(s=>s.id==='scheduled').count,0);assert.equal(r.current.stages.find(s=>s.id==='won').count,1);
  const past=(await call('GET','/reports?from=2026-10-01&to=2026-10-02&includeSandbox=1')).data;
  assert.equal(past.metrics.averageReplySeconds,null);assert.equal(past.stageReached.find(s=>s.id==='won').count,0);assert.equal(past.current.stages.find(s=>s.id==='won').count,1);
});
test('report CSV exports applied filters, snapshots and channel tables with spreadsheet escaping',async t=>{
  const {app,call}=setup(t);app.put('member',{name:'=UNSAFE()',active:true},'csv-owner');
  const r=await call('GET','/reports.csv?owner=csv-owner&channel=wechat');
  assert.equal(r.status,200);assert.match(r.text,/当前负责人/);assert.ok(r.text.includes("'=UNSAFE()"));
  assert.match(r.text,/当前阶段快照/);assert.match(r.text,/期间到达的阶段/);assert.match(r.text,/无样本/);assert.match(r.text,/视频号/);
});
