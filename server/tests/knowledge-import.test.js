'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream'),{createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{createGrowth}=require('../growth.js'),{records}=require('../knowledge-import.js');
const sha=b=>createHash('sha256').update(b).digest('hex');
function setup(db=new DatabaseSync(':memory:'),workspaceId='default'){
  const app=createGrowth({db,workspaceId,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body});
  async function call(method,path,body){const res={};await app.handle({method,body,access:{role:'admin',name:'导入测试'}},res,new URL('http://localhost/api/growth'+path));return res;}
  async function chunk(id,offset,data,hash=sha(data)){const req=Readable.from([data]);Object.assign(req,{method:'PUT',headers:{'x-chunk-sha256':hash},access:{role:'admin'}});const res={};await app.handle(req,res,new URL('http://localhost/api/growth/knowledge/imports/'+id+'/chunk?offset='+offset));return res;}
  async function upload(content,filename='data.jsonl'){const data=Buffer.from(content),j=(await call('POST','/knowledge/imports',{filename,size:data.length})).data;for(let offset=0;offset<data.length;offset+=1024**2){assert.equal((await chunk(j.id,offset,data.subarray(offset,offset+1024**2))).status,200);}return j;}
  async function wait(id){for(let i=0;i<2000;i++){const r=(await call('GET','/knowledge/imports/'+id)).data;if(!['parsing','pausing','committing'].includes(r.status))return r;await new Promise(r=>setTimeout(r,2));}throw Error('任务未完成');}
  return {db,app,call,chunk,upload,wait};
}
test('stream parsers respect every boundary, CSV multiline and JSON escapes',async()=>{
  const csv='title,body,category\r\n问,"带逗号,换行\n以及""引号""",常见问题\r\n第二条,内容,测试';
  for(const stride of [1,2,7,1024]){const parts=[];for(let i=0;i<csv.length;i+=stride)parts.push(csv.slice(i,i+stride));const r=await Array.fromAsync(records(parts,'csv','f','c'));assert.equal(r.length,2);assert.equal(r[0].value.body,'带逗号,换行\n以及"引号"');}
  const values=[{title:'a',body:'"带括号 } [ ] { \\ 和中文"',nested:{ignored:[1,2]}},{title:'b',body:'下一条'}],json=JSON.stringify(values);
  assert.deepEqual((await Array.fromAsync(records([...json],'json','f','c'))).map(r=>r.value),values);
  for(const bad of ['[{}','[{},]','{}','[{}] junk','[{"a":"b"} {}]'])await assert.rejects(()=>Array.fromAsync(records([...bad],'json','f','c')));
});
test('chunk integrity, idempotency, pagination, dedupe, error rows and disabled committed knowledge',async t=>{
  const {db,app,call,chunk,upload,wait}=setup();t.after(()=>db.close());
  const items=Array.from({length:350},(_,i)=>({title:'大资料 '+i,body:'真实中文分块边界 '+i+'。'.repeat(4200),category:'大文件'}));
  const j=await upload(items.map(k=>JSON.stringify(k)).join('\n')+'\n'+JSON.stringify(items[0])+'\n{bad}\n'+JSON.stringify({title:'无正文'}));
  assert.ok((await call('GET','/knowledge/imports/'+j.id)).data.offset>1024**2);
  const hashes=(await call('GET','/knowledge/imports/'+j.id+'/hashes')).data.list;assert.ok(hashes.length>1);
  const fake=Buffer.alloc(1024**2);assert.equal((await chunk(j.id,0,fake)).status,409);assert.equal((await chunk(j.id,0,fake,'0'.repeat(64))).status,400);
  await call('POST','/knowledge/imports/'+j.id+'/control',{action:'parse'});let result=await wait(j.id);assert.equal(result.status,'review');assert.equal(result.valid,350);assert.equal(result.errors,2);assert.equal(result.duplicates,1);assert.equal(app.all('knowledge').length,0);
  const page=(await call('GET','/knowledge/imports/'+j.id+'/rows?page=7')).data;assert.equal(page.list[0].row,301);assert.equal(page.list.length,50);
  await call('POST','/knowledge/imports/'+j.id+'/control',{action:'commit'});result=await wait(j.id);assert.equal(result.status,'completed');assert.equal(result.added,350);
  assert.equal(app.all('knowledge').length,350);assert.ok(app.all('knowledge').every(k=>!k.enabled&&k.sourceMeta.kind==='file'&&k.sourceMeta.sha256===result.sha256));
  assert.equal((await call('POST','/knowledge/imports/'+j.id+'/control',{action:'commit'})).status,409);
  assert.equal((await call('GET','/knowledge/list?page=7')).data.list.length,50);assert.equal((await call('GET','/knowledge/imports/'+j.id+'/hashes')).data.list.length,0);
});
test('restart preserves upload; parse interruption is explicit; workspace and malformed UTF-8 isolated',async t=>{
  const a=setup();t.after(()=>a.db.close());const content=JSON.stringify([{title:'恢复测试',body:'文字保持完整'}]),j=await a.upload(content,'恢复.json');
  const b=setup(a.db);assert.equal((await b.call('GET','/knowledge/imports/'+j.id)).data.offset,Buffer.byteLength(content));
  await b.call('POST','/knowledge/imports/'+j.id+'/control',{action:'parse'});assert.equal((await b.wait(j.id)).status,'review');
  const c=setup(a.db,'isolated');assert.equal((await c.call('GET','/knowledge/imports/'+j.id)).status,404);
  const bad=(await b.call('POST','/knowledge/imports',{filename:'坏文件.txt',size:2})).data;await b.chunk(bad.id,0,Buffer.from([0xc0,0xff]));await b.call('POST','/knowledge/imports/'+bad.id+'/control',{action:'parse'});assert.equal((await b.wait(bad.id)).status,'failed');assert.equal(b.app.all('knowledge').length,0);
  assert.equal((await b.call('POST','/knowledge/imports/'+bad.id+'/control',{action:'cancel'})).data.status,'cancelled');
});
test('pause and resume batch commit never duplicates records',async t=>{
  const {db,app,call,upload,wait}=setup();t.after(()=>db.close());const j=await upload(Array.from({length:650},(_,i)=>JSON.stringify({title:'条目 '+i,body:'用于检验批次断点 '+i})).join('\n'));
  await call('POST','/knowledge/imports/'+j.id+'/control',{action:'parse'});await wait(j.id);await call('POST','/knowledge/imports/'+j.id+'/control',{action:'commit'});await call('POST','/knowledge/imports/'+j.id+'/control',{action:'pause'});assert.equal((await wait(j.id)).status,'paused');
  await call('POST','/knowledge/imports/'+j.id+'/control',{action:'resume'});assert.equal((await wait(j.id)).added,650);assert.equal(app.all('knowledge').length,650);
});
