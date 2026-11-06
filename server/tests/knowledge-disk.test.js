'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth');
const {chunks,literalTitleScore,fuseDiskRanks}=require('../growth-knowledge');
const {identifiers,matchesIdentifier}=require('../knowledge-cache');
const wait=()=>new Promise(r=>setImmediate(r));
function setup(db,options={}){const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,...options});const call=async(method,path,body)=>{const r={};await app.handle({method,body},r,new URL('http://local/api/growth'+path));return r;};return {app,call};}
test('large disk retrieval builds persistently, scopes correctly, handles edits, and scans real stored vector rows in bounded batches',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const {app,call}=setup(db,{embeddingCall:async inputs=>inputs.map(()=>[1,0])});
  db.exec('BEGIN');for(let i=0;i<5100;i++)app.put('knowledge',{title:'CODE-'+String(i).padStart(5,'0')+' 营业指南',body:'营业时间为上午九点到下午六点，周末需要预约。',category:i%2?'A':'B',enabled:true,version:1},'k'+i);db.exec('COMMIT');
  const first=(await call('GET','/knowledge/index')).data;assert.equal(first.strategy,'disk-exact');assert.equal(first.preparing,5100);
  for(let i=0;i<1000;i++){await wait();if(!(await call('GET','/knowledge/index')).data.preparing)break;}
  assert.equal((await call('GET','/knowledge/index')).data.preparing,0);
  const indexed=(await call('POST','/knowledge/index',{})).data;assert.equal(indexed.indexed,32);
  const result=(await call('POST','/knowledge/search',{query:'CODE-00001 营业时间'})).data;assert.equal(result.list[0].id,'k1');assert.equal(result.strategy,'disk-exact');
  assert.equal((await call('POST','/knowledge/search',{query:'CODE-00001 营业时间',categories:['B']})).data.list.length,0);
  const patched=await call('PATCH','/knowledge/k1',{enabled:false,expectedVersion:1});assert.equal(patched.status,200);assert.equal(app.retrieve('CODE-00001 营业时间').length,0);
  await wait();const other=setup(db,{workspaceId:'isolated'});assert.equal(other.app.retrieve('营业时间').length,0);
  // Re-creating an instance keeps the persisted plans, not an in-memory-only index.
  const reopened=setup(db,{embeddingCall:async inputs=>inputs.map(()=>[1,0])});assert.equal((await reopened.call('GET','/knowledge/index')).data.strategy,'disk-exact');
  for(let i=0;i<100;i++){await wait();if(!(await reopened.call('GET','/knowledge/index')).data.preparing)break;}
  assert.equal((await reopened.call('POST','/knowledge/search',{query:'CODE-00002 营业时间'})).data.list[0].id,'k2');
});
test('language chunking retains the full English text and literal title evidence is not rank-only',()=>{
  const body=Array.from({length:80},(_,i)=>`Unique sentence number ${i} explains a separate public fact.`).join('\n');
  const parts=chunks({id:'english',title:'Public facts',body},true);
  assert.ok(parts.length<15);assert.ok(parts.every(p=>p.body.length<=640));
  for(let i=0;i<80;i++)assert.ok(parts.some(p=>p.body.includes(`Unique sentence number ${i} explains a separate public fact.`)));
  assert.equal(literalTitleScore('Who invented track lighting?','Reference 27 · Who invented track lighting?'),.99);
  assert.equal(literalTitleScore('Who invented track lighting?','Who became president of Africa?'),0);
  assert.ok(literalTitleScore('Who developed track lighting?','Who invented track lighting?')===0);
  assert.deepEqual(identifiers('BeiDou-Y33 was put into orbit?'),['beidou-y33']);
  assert.equal(matchesIdentifier({title:'BeiDou-Y33',body:'satellite'},identifiers('BeiDou-Y33')),true);
  assert.equal(matchesIdentifier({title:'BeiDou-Y34',body:'satellite'},identifiers('BeiDou-Y33')),false);
});
test('large hybrid ranking retains relevant lexical evidence instead of comparing BM25 to cosine',()=>{
  const semantic=Array.from({length:20},(_,i)=>({id:'semantic-'+i,title:'Candidate topic '+i,body:'Vector passage',similarity:.72-i*.001,score:.72-i*.001,match:'semantic'}));
  const lexical=[{id:'lexical-first',title:'Related subject',body:'A lexical result',score:18.5},{id:'lexical-second',title:'Definition of the subject',body:'The grounded answer',score:18.3},{...semantic[3],score:18.2},{id:'lexical-fourth',title:'Additional subject',score:18.1}];
  const list=fuseDiskRanks('Which levels of study belong to tertiary education?',semantic,lexical);
  assert.equal(list.length,4);assert.ok(list.some(k=>k.id==='lexical-second'));
  assert.equal(list.find(k=>k.id==='semantic-3').match,'hybrid');assert.equal(list.find(k=>k.id==='semantic-3').similarity,.717);
  const exact=fuseDiskRanks('How do I change my reservation?',semantic,[{id:'exact',title:'How do I change my reservation?',score:1}]);
  assert.equal(exact[0].id,'exact');assert.equal(exact[0].score,.99);
});
test('paged scan discards concurrent edits, and binary vectors remain usable below the large-index threshold',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const s=setup(db,{embeddingCall:async inputs=>inputs.map(()=>[1,0])});
  db.exec('BEGIN');for(let i=0;i<5001;i++)s.app.put('knowledge',{title:'Document '+i,body:'Stable public opening hours information.',enabled:true,category:'A',version:1},'v'+i);db.exec('COMMIT');
  await s.call('GET','/knowledge/index');while(db.prepare('SELECT count(*) n FROM growth_search_dirty').get().n)await wait();
  for(let i=0;i<10;i++)await s.call('POST','/knowledge/index',{});
  const target=db.prepare('SELECT knowledgeId FROM growth_vector_blobs LIMIT 1').get().knowledgeId;
  const search=s.call('POST','/knowledge/search',{query:'public opening hours'});
  await wait();await s.call('PATCH','/knowledge/'+target,{enabled:false,expectedVersion:1});
  const result=(await search).data;assert.equal(result.mode,'keyword');assert.match(result.warning,/变化|更新/);assert.ok(result.list.every(k=>k.id!==target));
  const small=(await s.call('GET','/knowledge/index')).data;assert.notEqual(small.strategy,'disk-exact');assert.ok(small.ready>=319);
  assert.equal((await s.call('POST','/knowledge/search',{query:'public opening hours'})).data.mode,'hybrid');
});
