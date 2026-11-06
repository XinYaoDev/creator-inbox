'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth.js');
const {publicAddress,publicURL,resolvePublic,extractPage}=require('../knowledge-web.js');
const html=(title,body,links='')=>`<!doctype html><html><head><title>${title}</title></head><body><nav>导航广告</nav><main><h1>${title}</h1><p>${body.repeat(4)}</p>${links}</main><script>throw Error('must not execute')</script><footer>页脚广告</footer></body></html>`;
const response=(text,status=200,headers={})=>({status,headers:{'content-type':'text/html; charset=utf-8',...headers},bytes:Buffer.from(text)});
function setup(fetcher,db=new DatabaseSync(':memory:'),workspaceId='default'){
  const app=createGrowth({db,workspaceId,knowledgeFetch:fetcher,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,clock:()=>1000});
  // These fixtures verify the explicitly non-executing static collector. The
  // actual Chromium dynamic path has its own execution and safety tests.
  const call=async(method,path,body)=>{if(method==='POST'&&path==='/knowledge/web')body={renderMode:'static',...body};const r={};await app.handle({method,body,access:{name:'测试管理员',role:'admin'}},r,new URL('http://localhost/api/growth'+path));return r;};
  const wait=async id=>{for(let i=0;i<100;i++){const r=await call('GET','/knowledge/web/'+id);if(!['queued','running'].includes(r.data.status))return r.data;await new Promise(r=>setTimeout(r,5));}throw Error('job did not finish');};
  return {db,app,call,wait};
}
test('web collection blocks private, reserved, obfuscated and mixed DNS addresses',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','169.254.169.254','100.64.0.1','0.0.0.0','192.168.1.1','192.0.2.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  for(const url of ['http://2130706433','http://0x7f000001','http://localhost','http://a.local','http://user:pass@example.com','http://example.com:8080','file:///etc/passwd','https://[::ffff:127.0.0.1]'])assert.throws(()=>publicURL(url));
  await assert.rejects(()=>resolvePublic(new URL('https://example.com'),async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/内网/);
});
test('HTML extraction does not execute scripts and strips navigation; indexing directives respected',()=>{
  const result=extractPage(html('营业时间','每天上午九点至下午六点营业，周末需提前预约。'), 'https://example.com/help');
  assert.match(result.body,/上午九点/);assert.doesNotMatch(result.body,/导航广告|页脚广告|must not execute/);
  assert.throws(()=>extractPage('<meta name="robots" content="noindex"><main>禁止采集</main>','https://example.com'),/不允许索引/);
  assert.throws(()=>extractPage('<div id="app"></div>','https://example.com'),/足够正文/);
});
test('bounded crawl traverses deeper same-origin links without loops, queries or budget overflow',async t=>{
  const visited=[];
  const {db,call,wait}=setup(async url=>{visited.push(url);if(url.endsWith('/robots.txt'))return response('',404);const n=Number(new URL(url).pathname.slice(1))||0;return response(html('页面'+n,'每一层都有真实结构的正文，供有限深度采集规则测试。',`<a href="/${n+1}">下一层</a><a href="/0">循环</a><a href="/private?token=no">查询参数</a>`));});t.after(()=>db.close());
  const first=(await call('POST','/knowledge/web',{url:'https://example.com/0',maxPages:20,maxDepth:3})).data;
  const job=await wait(first.id);assert.equal(job.status,'completed');assert.equal(job.pages.length,4);assert.deepEqual(job.pages.map(p=>p.depth),[0,1,2,3]);assert.equal(visited.some(u=>u.includes('?')),false);
  assert.equal((await call('POST','/knowledge/web',{url:'https://example.com',maxPages:21})).status,400);
  assert.equal((await call('POST','/knowledge/web',{url:'https://example.com',maxDepth:4})).status,400);
});
test('PDF parser rejects invalid bytes and oversized inputs without running a worker',async()=>{
  const {extractPDF}=require('../knowledge-pdf');
  await assert.rejects(()=>extractPDF(Buffer.from('not pdf')),/不是有效/);
  await assert.rejects(()=>extractPDF(Buffer.alloc(16*1024*1024+1)),/16 MiB/);
  const controller=new AbortController();controller.abort();
  assert.throws(()=>extractPDF(Buffer.from('%PDF-test'),{signal:controller.signal}),/abort/i);
});
test('web job preview, same-origin scope, dedupe, explicit revision update and conflicts',async t=>{
  let revision='九点';const requests=[];
  const {db,app,call,wait}=setup(async url=>{requests.push(url);return url.endsWith('/robots.txt')?response('User-agent: *\nDisallow: /private',200,{'content-type':'text/plain'}):response(html('门店知识',`每天${revision}营业，支持提前预约，请联系人工确认具体时间。`,'<a href="/private">私有</a><a href="https://other.example.org">外站</a>'));});t.after(()=>db.close());
  const first=(await call('POST','/knowledge/web',{url:'https://example.com/help',maxPages:3})).data,job=await wait(first.id);
  assert.equal(job.status,'completed');assert.equal(job.pages.length,2);assert.match(job.pages[1].error,/robots/);assert.equal(app.all('knowledge').length,0);assert.equal(requests.includes('https://example.com/private'),false);assert.equal(requests.some(u=>u.includes('other.')),false);
  let r=await call('POST','/knowledge/web/'+job.id+'/import',{items:job.items,update:false});assert.equal(r.data.added,1);const k=app.all('knowledge')[0];assert.equal(k.enabled,false);assert.equal(k.sourceMeta.url,'https://example.com/help');
  assert.equal((await call('POST','/knowledge/web/'+job.id+'/import',{items:job.items})).data.skipped,1);
  revision='十点';const second=(await call('POST','/knowledge/web',{url:'https://example.com/help'})).data,j2=await wait(second.id);
  r=await call('POST','/knowledge/web/'+j2.id+'/import',{items:j2.items,update:true});assert.equal(r.data.updated,1);assert.equal(app.get('knowledge',k.id).version,2);assert.equal(app.get('knowledge',k.id).enabled,false);
  revision='十一点';const third=(await call('POST','/knowledge/web',{url:'https://example.com/help'})).data,j3=await wait(third.id);
  await call('PATCH','/knowledge/'+k.id,{body:'人工更新',expectedVersion:2});
  assert.equal((await call('POST','/knowledge/web/'+j3.id+'/import',{items:j3.items,update:true})).status,409);
  assert.equal(app.get('knowledge',k.id).body,'人工更新');assert.equal(app.all('knowledgeRevision').length,3);
});
test('web collector stops on cross-site redirects, supports cancellation and workspace isolation',async t=>{
  let release;const {db,call,wait}=setup(async(url,{signal})=>{if(url.endsWith('/robots.txt'))return response('',404);if(url.endsWith('/redirect'))return response('',302,{location:'http://127.0.0.1/secret'});return new Promise((resolve,reject)=>{release=()=>resolve(response(html('业务','周末营业可提前预约。')));signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});});t.after(()=>db.close());
  const a=(await call('POST','/knowledge/web',{url:'https://example.com/redirect'})).data;assert.equal((await wait(a.id)).status,'failed');
  const b=(await call('POST','/knowledge/web',{url:'https://example.com/slow'})).data;await new Promise(r=>setTimeout(r,10));await call('POST','/knowledge/web/'+b.id+'/cancel',{});assert.equal((await wait(b.id)).status,'cancelled');release?.();
  const other=setup(async()=>response('',404),db,'other');assert.equal((await other.call('GET','/knowledge/web/'+b.id)).status,404);
});
test('document import retains OCR provenance through revision and archive restore',async t=>{
  const {db,app,call}=setup(async()=>response('',404));t.after(()=>db.close());
  const item={title:'扫描营业时间',body:'每天九点至十八点营业。',sourceMeta:{kind:'ocr',filename:'资料.pdf',page:2,confidence:91.2}};
  const r=await call('POST','/knowledge/import',{format:'json',filename:'资料.pdf',content:JSON.stringify([item])});const k=r.data.items[0];assert.equal(k.sourceMeta.page,2);assert.equal(k.enabled,false);
  const edited=(await call('PATCH','/knowledge/'+k.id,{body:'核对后的九点营业'})).data;assert.equal(edited.sourceMeta.kind,'ocr');assert.equal(app.all('knowledgeRevision')[0].snapshot.sourceMeta.filename,'资料.pdf');
});
test('workflow layout, version conflicts, real trace and individual cancellation',async t=>{
  const {db,app,call}=setup(async()=>response('',404));t.after(()=>db.close());
  const n={id:'a',type:'wait',minutes:1,next:'b',position:{x:240,y:120}},b={id:'b',type:'tag',value:'已跟进'};
  const saved=(await call('POST','/workflow',{name:'可视化测试',enabled:true,trigger:'manual',channel:'sandbox',nodes:[n,b]})).data;assert.deepEqual(saved.nodes[0].position,n.position);assert.equal(saved.version,1);
  assert.equal((await call('PATCH','/workflow/'+saved.id,{name:'新版本',expectedVersion:1})).data.version,2);
  assert.equal((await call('PATCH','/workflow/'+saved.id,{name:'旧覆盖',expectedVersion:1})).status,409);
  const c=app.newConversation({name:'测试访客'}),run=(await call('POST','/workflow/start',{workflowId:saved.id,conversationId:c.id,requestId:'trace'})).data;assert.equal(run.workflowVersion,2);assert.equal(run.steps[0].nodeId,'a');
  assert.equal((await call('POST','/workflow-runs/'+run.id+'/cancel',{})).data.status,'cancelled');assert.equal(app.get('conversation',c.id).tags.includes('已跟进'),false);
  assert.equal((await call('PATCH','/workflow/'+saved.id,{nodes:[{...n,position:{x:Infinity,y:0}},b]})).status,400);
});
