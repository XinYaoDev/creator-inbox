'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth.js');
const {parseImport,cosine}=require('../growth-knowledge.js');
function setup(options={}) {
  const db=new DatabaseSync(':memory:');
  const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,clock:()=>100,...options});
  const call=async(method,path,body)=>{const r={};await app.handle({method,body,access:{name:'测试编辑'}},r,new URL('http://localhost/api/growth'+path));return r;};
  return {db,app,call};
}
test('import parser: CSV escaped quotes, quoted newlines, BOM, Chinese columns and empty values',()=>{
  const list=parseImport({format:'csv',content:'\uFEFF标题,内容,分类\r\n营业时间,"每天 9 点, 至 18 点\n备注：""需预约""",门店'});
  assert.equal(list.length,1);assert.equal(list[0].body,'每天 9 点, 至 18 点\n备注："需预约"');assert.equal(list[0].enabled,false);
  assert.throws(()=>parseImport({format:'csv',content:'title,body\na,"oops'}),/未闭合/);
  assert.throws(()=>parseImport({format:'csv',content:'title,body\na,b,c'}),/列数/);
  assert.throws(()=>parseImport({format:'json',content:'{"title":"not array"}'}),/数组/);
  assert.throws(()=>parseImport({format:'json',content:'[{"title":"a"}]'}),/缺少/);
  assert.throws(()=>parseImport({format:'pdf',content:'binary'}),/PDF/);
  const split=parseImport({format:'md',filename:'长文.md',content:'文'.repeat(25000)});assert.equal(split.length,3);assert.equal(split.map(k=>k.body).join('').length,25000);
});
test('bulk import: preview never mutates, duplicate replay safe, invalid batch writes nothing',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const body={format:'json',filename:'知识.json',content:JSON.stringify([{title:'营业时间',body:'9–18点',enabled:true},{title:'营业时间',body:'9–18点'}])};
  const preview=await call('POST','/knowledge/import-preview',body);assert.equal(preview.data.added,1);assert.equal(preview.data.skipped,1);assert.equal(app.all('knowledge').length,0);
  const imported=await call('POST','/knowledge/import',body);assert.equal(imported.status,201);assert.equal(imported.data.added,1);assert.equal(app.all('knowledge')[0].enabled,false);
  assert.equal(app.all('knowledge')[0].source,'知识.json');
  const repeated=await call('POST','/knowledge/import',body);assert.equal(repeated.data.added,0);assert.equal(repeated.data.skipped,2);
  const bad=await call('POST','/knowledge/import',{format:'json',content:JSON.stringify([{title:'ok',body:'yes'},{title:'missing'}])});assert.equal(bad.status,400);assert.equal(app.all('knowledge').length,1);
});
test('knowledge versions: optimistic conflict, archive stops retrieval, restore creates disabled revision',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const first=(await call('POST','/knowledge',{title:'营业时间',body:'每天九点营业'})).data;
  const next=await call('PATCH','/knowledge/'+first.id,{body:'每天十点营业',expectedVersion:1});assert.equal(next.data.version,2);
  assert.equal((await call('PATCH','/knowledge/'+first.id,{body:'过时编辑',expectedVersion:1})).status,409);
  const versions=await call('GET','/knowledge/'+first.id+'/versions');assert.deepEqual(versions.data.list.map(r=>r.version),[2,1]);assert.equal(versions.data.list[0].actor,'测试编辑');
  const archive=await call('PATCH','/knowledge/'+first.id,{archived:true});assert.equal(archive.data.enabled,false);assert.equal(app.retrieve('营业时间').length,0);
  assert.equal((await call('PATCH','/knowledge/'+first.id,{enabled:true})).status,400);
  const restored=await call('POST','/knowledge/'+first.id+'/restore',{revisionId:versions.data.list[1].id,expectedVersion:3});assert.equal(restored.data.body,first.body);assert.equal(restored.data.version,4);assert.equal(restored.data.enabled,false);assert.equal(restored.data.archived,false);
  assert.equal((await call('GET','/knowledge/'+first.id+'/versions')).data.list.length,4);
});
test('semantic retrieval: explicit indexing, query cache, scope, changed content invalidation',async t=>{
  let calls=0;
  const embed=async inputs=>{calls++;return inputs.map(s=>/营业|开门|新内容/.test(s)?[1,0,0]:[0,1,0]);};
  const {db,app,call}=setup({embeddingCall:embed});t.after(()=>db.close());
  const a=(await call('POST','/knowledge',{title:'营业时间',body:'每日九点至十八点营业'})).data;
  const b=(await call('POST','/knowledge',{title:'退款规则',body:'未使用的订单可申请退款'})).data;
  assert.equal((await call('POST','/knowledge/search',{query:'几点开门'})).data.mode,'keyword');assert.equal(calls,0);
  assert.equal((await call('POST','/knowledge/index',{})).data.indexed,2);
  const found=(await call('POST','/knowledge/search',{query:'几点开门'})).data;assert.equal(found.mode,'hybrid');assert.equal(found.list[0].id,a.id);assert.equal(found.list[0].match,'semantic');
  const before=calls;await call('POST','/knowledge/search',{query:'几点开门'});assert.equal(calls,before);
  await call('PATCH','/agent/default',{knowledgeIds:[b.id]});const preview=await call('POST','/preview',{message:'几点开门'});assert.equal(preview.data.refs.length,0);
  await call('PATCH','/knowledge/'+a.id,{body:'新内容'});assert.equal(app.stats().knowledgeIndex.pending,1);
  const stale=(await call('POST','/knowledge/search',{query:'几点开门'})).data;assert.equal(stale.list.some(k=>k.id===a.id),false);
  await call('POST','/knowledge/index',{});assert.equal(app.stats().knowledgeIndex.pending,0);
  await call('PATCH','/knowledge/'+a.id,{archived:true});assert.equal((await call('POST','/knowledge/search',{query:'几点开门'})).data.list.length,0);
  assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([0,0],[1,0]),-1);
});
test('semantic provider failure falls back honestly and never loses saved knowledge',async t=>{
  let fail=false;
  const {db,app,call}=setup({embeddingCall:async inputs=>{if(fail)throw Error('down');return inputs.map(()=>[1,0]);}});t.after(()=>db.close());
  await call('POST','/knowledge',{title:'营业时间',body:'九点营业'});await call('POST','/knowledge/index',{});fail=true;
  const r=await call('POST','/knowledge/search',{query:'营业时间'});assert.equal(r.status,200);assert.equal(r.data.mode,'keyword');assert.match(r.data.warning,/回退/);assert.equal(r.data.list.length,1);assert.equal(app.all('knowledge').length,1);
});
test('index race: archive during remote embedding does not persist stale vectors',async t=>{
  let ready,release;const started=new Promise(r=>ready=r);
  const {db,app,call}=setup({embeddingCall:async inputs=>{ready();await new Promise(r=>release=r);return inputs.map(()=>[1,0]);}});t.after(()=>db.close());
  const k=(await call('POST','/knowledge',{title:'营业时间',body:'九点营业'})).data;
  const building=call('POST','/knowledge/index',{});await started;
  await call('PATCH','/knowledge/'+k.id,{archived:true});release();const r=await building;
  assert.equal(r.data.indexed,0);assert.equal(app.all('knowledgeVector').length,0);
});
test('AI race: edit cited knowledge while generating discards outdated response',async t=>{
  let ready,release;const started=new Promise(r=>ready=r);
  const {db,app,call}=setup({modelCall:async()=>{ready();await new Promise(r=>release=r);return {reply:'九点营业',handoff:false};}});t.after(()=>db.close());
  const k=(await call('POST','/knowledge',{title:'营业时间',body:'九点营业'})).data;
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false});
  let c=app.newConversation({name:'访客'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'营业时间？');
  const run=app.autoReply(c.id);await started;
  await call('PATCH','/knowledge/'+k.id,{body:'十点营业'});release();assert.equal((await run).skipped,true);
  assert.equal(app.history(c.id).filter(m=>m.role==='ai').length,0);
});
test('index provider race never saves vectors under a changed provider or model',async t=>{
  let release,ready;const started=new Promise(r=>ready=r);let model='embedding-a';
  const {db,app,call}=setup({modelConfig:()=>({base:'test',embeddingModel:model}),embeddingCall:async input=>{ready();await new Promise(r=>release=r);return input.map(()=>[1,0]);}});t.after(()=>db.close());
  await call('POST','/knowledge',{title:'测试',body:'这是用于测试的业务资料'});
  const pending=call('POST','/knowledge/index',{});await started;model='embedding-b';release();
  assert.equal((await pending).status,409);assert.equal(app.all('knowledgeVector').length,0);
});
test('semantic indexing rejects malformed, zero and inconsistent vectors without partial writes',async t=>{
  for(const vector of [[0,0],[NaN,1],[Infinity,2],[1]]){
    const {db,app,call}=setup({embeddingCall:async()=>[vector]});
    await call('POST','/knowledge',{title:'测试',body:'业务知识'});
    assert.equal((await call('POST','/knowledge/index',{})).status,502);assert.equal(app.all('knowledgeVector').length,0);db.close();
  }
});
test('vector keys separate identical documents and workspace tables isolate semantic results',async t=>{
  const {db,app,call}=setup({embeddingCall:async input=>input.map(()=>[1,0])});t.after(()=>db.close());
  const first=(await call('POST','/knowledge',{title:'一样',body:'同一内容'})).data;
  const second=(await call('POST','/knowledge',{title:'一样',body:'同一内容'})).data;
  assert.equal((await call('POST','/knowledge/index',{})).data.indexed,2);assert.equal(app.all('knowledgeVector').length,2);
  const other=createGrowth({db,workspaceId:'other',embeddingCall:async input=>input.map(()=>[1,0])});assert.equal(other.all('knowledgeVector').length,0);
  await call('PATCH','/knowledge/'+first.id,{enabled:false});
  const results=(await call('POST','/knowledge/search',{query:'另一个语义问题'})).data;assert.deepEqual(results.list.map(k=>k.id),[second.id]);
});
