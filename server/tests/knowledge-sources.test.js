'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createGrowth}=require('../growth.js');
function setup(db=new DatabaseSync(':memory:'),options={}){
  let now=1000,body='业务知识：每天上午九点开始营业。请提前预约并等待确认。'.repeat(5),status=200,requests=0;
  const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,clock:()=>now,knowledgeFetch:async url=>{requests++;return url.endsWith('/robots.txt')?{status:404,headers:{},bytes:Buffer.from('')}:{status,headers:{'content-type':'text/html'},bytes:Buffer.from('<html><title>门店公开资料</title><main><p>'+body+'</p></main></html>')};},...options});
  async function call(method,path,body){const r={};await app.handle({method,body,access:{role:'admin'}},r,new URL('http://localhost/api/growth'+path));return r;}
  async function wait(id){for(let i=0;i<200;i++){const d=(await call('GET','/knowledge/sources/'+id)).data;if(!d.source.jobId)return d;await new Promise(r=>setTimeout(r,2));}throw Error('同步未完成');}
  return {db,app,call,wait,time:n=>now=n,body:b=>body=b,status:s=>status=s,requests:()=>requests};
}
test('persistent schedule, explicit review, unchanged checks, edits and failure backoff',async t=>{
  const s=setup();t.after(()=>s.db.close());const source=(await s.call('POST','/knowledge/sources',{name:'门店',url:'https://example.com/help',interval:900})).data;
  s.app.tick();let d=await s.wait(source.id);assert.equal(d.review.changes.length,1);assert.equal(s.app.all('knowledge').length,0);
  const requestCount=s.requests();s.time(3000);s.app.tick();assert.equal(s.requests(),requestCount,'pending review is not overwritten by scheduler');
  let r=await s.call('POST','/knowledge/sources/'+source.id+'/review',{action:'accept',keys:d.review.changes.map(c=>c.key),expectedVersion:d.review.version});assert.equal(r.data.added,1);const k=s.app.all('knowledge')[0];assert.equal(k.enabled,false);
  s.time(4000);s.app.tick();d=await s.wait(source.id);assert.equal(d.review,null);assert.equal(d.source.status,'unchanged');assert.equal(s.app.all('knowledgeRevision').length,1);
  s.body('每天十点开始营业，请联系人工确认预约；原九点营业安排已变更。'.repeat(6));await s.call('POST','/knowledge/sources/'+source.id+'/check',{});d=await s.wait(source.id);assert.equal(d.review.changes[0].type,'changed');
  await s.call('PATCH','/knowledge/'+k.id,{body:'人工刚刚核实的独立说明',expectedVersion:1});
  r=await s.call('POST','/knowledge/sources/'+source.id+'/review',{action:'accept',keys:d.review.changes.map(c=>c.key),expectedVersion:1});assert.equal(r.status,409);assert.equal(s.app.get('knowledge',k.id).body,'人工刚刚核实的独立说明');
  await s.call('POST','/knowledge/sources/'+source.id+'/review',{action:'ignore',keys:d.review.changes.map(c=>c.key),expectedVersion:1});
  s.status(503);await s.call('POST','/knowledge/sources/'+source.id+'/check',{});d=await s.wait(source.id);assert.equal(d.source.status,'error');assert.ok(d.source.nextAt>=5800);assert.equal(s.app.all('knowledge').length,1);assert.equal(s.app.get('knowledge',k.id).archived,false);
  const restored=setup(s.db);assert.equal((await restored.call('GET','/knowledge/sources')).data.list.length,1);
});
test('source fragment removal requires explicit archive; ignoring never deletes; paused schedule is quiet',async t=>{
  const s=setup();t.after(()=>s.db.close());s.body('长篇业务资料。'.repeat(2200));const source=(await s.call('POST','/knowledge/sources',{name:'资料',url:'https://example.com/help',interval:900})).data;
  await s.call('POST','/knowledge/sources/'+source.id+'/check',{});let d=await s.wait(source.id);assert.equal(d.review.changes.length,2);
  await s.call('POST','/knowledge/sources/'+source.id+'/review',{action:'accept',keys:d.review.changes.map(c=>c.key),expectedVersion:1});
  s.body('缩短后的正文。业务内容已经调整，请核对后更新。'.repeat(8));await s.call('POST','/knowledge/sources/'+source.id+'/check',{});d=await s.wait(source.id);assert.ok(d.review.changes.some(c=>c.type==='removed'));assert.ok(s.app.all('knowledge').every(k=>!k.archived));
  const result=await s.call('POST','/knowledge/sources/'+source.id+'/review',{action:'accept',keys:d.review.changes.map(c=>c.key),expectedVersion:1});assert.equal(result.data.archived,1);assert.equal(result.data.updated,1);assert.equal(s.app.all('knowledge').length,2);
  const current=result.data.source;await s.call('PATCH','/knowledge/sources/'+source.id,{expectedVersion:current.version,enabled:false});const n=s.requests();s.time(999999);s.app.tick();assert.equal(s.requests(),n);
  assert.equal((await s.call('POST','/knowledge/sources',{url:'http://127.0.0.1/private'})).status,400);assert.equal((await s.call('POST','/knowledge/sources',{url:'https://example.com',interval:1})).status,400);
});
test('rendering mode and hash routes persist across restart and reject invalid options',async t=>{
  const s=setup();t.after(()=>s.db.close());
  const created=await s.call('POST','/knowledge/sources',{name:'Public SPA',url:'https://example.com/#/guide',interval:900,enabled:false,renderMode:'javascript'});
  assert.equal(created.status,201);assert.equal(created.data.renderMode,'javascript');assert.equal(created.data.url,'https://example.com/#/guide');
  const restored=setup(s.db),saved=(await restored.call('GET','/knowledge/sources')).data.list[0];assert.equal(saved.renderMode,'javascript');
  assert.equal((await restored.call('PATCH','/knowledge/sources/'+saved.id,{name:'Renamed',expectedVersion:saved.version})).data.renderMode,'javascript');
  assert.equal((await restored.call('POST','/knowledge/sources',{url:'https://example.com/',renderMode:'unrestricted'})).status,400);
});
