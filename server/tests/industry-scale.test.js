'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth}=require('../growth.js'),sales=require('../sales-dialogue.js');
const wait=()=>new Promise(r=>setImmediate(r));
function setup(extra={}){
  const db=new DatabaseSync(':memory:'),options={db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,...extra};
  const app=createGrowth(options),call=async(method,path,body)=>{const r={};await app.handle({method,body,access:{role:'admin',name:'验收'}},r,new URL('http://localhost/api/growth'+path));return r;};
  return {db,app,call,options};
}
for(const scenario of sales.catalog.scenarios)test('industry '+scenario.id+': grounded slots, corrections, refusal, isolation and summary',()=>{
  const agent={...sales.validateSales({salesScenario:scenario.id,salesEnabled:true}),collectEnabled:true};
  assert.deepEqual(agent.salesRequired,scenario.required);assert.equal(agent.salesGoal,scenario.goal);assert.match(sales.prompt(agent,{}),new RegExp(scenario.name));
  let c={};
  for(const key of scenario.fields){
    const raw={facts:{[key]:{value:'测试需求',evidence:'我的测试需求'},unknown:{value:'其他',evidence:'其他'}}};
    const r=sales.advance(agent,c,raw,'我的测试需求，其他',{at:1,messageId:'a'});c={salesState:r.state};
    assert.equal(r.state.facts[key].value,'测试需求');assert.equal(r.state.facts.unknown,undefined);
  }
  const field=scenario.required[0],correction=sales.advance(agent,c,{facts:{[field]:{value:'新的需求',evidence:'改为新的需求'}}},'改为新的需求');
  assert.equal(correction.state.facts[field].value,'新的需求');
  const refused=sales.advance(agent,{salesState:correction.state},{declined:[{field,evidence:'这项不想说'}]},'这项不想说');
  assert.equal(refused.state.facts[field],undefined);assert.ok(refused.state.declined.includes(field));
  assert.match(sales.summary({name:'合成客户',salesState:refused.state}),new RegExp(scenario.name));
  const invalid=sales.advance(agent,{}, {facts:{[field]:{value:'伪造',evidence:'伪造旧原话'}}},'当前未提供');assert.equal(invalid.state.facts[field],undefined);
  assert.ok(Object.keys(sales.validateSales({salesScenario:scenario.id,salesRequired:['unknown',...scenario.fields]}).salesQuestions).every(k=>scenario.fields.includes(k)));
});
test('resolving one concern never resolves a different or ambiguous concern',()=>{
  const agent={...sales.validateSales({salesEnabled:true}),collectEnabled:true};
  const previous={salesState:{...sales.empty(),objections:[{kind:'price',evidence:'价格贵',resolved:false},{kind:'trust',evidence:'担心不可靠',resolved:false}]}};
  const r=sales.advance(agent,previous,{resolvedObjection:{kind:'price',evidence:'价格可以接受'}},'价格可以接受');
  assert.equal(r.state.objections[0].resolved,true);assert.equal(r.state.objections[1].resolved,false);
  const ambiguous=sales.advance(agent,previous,{resolvedObjection:{evidence:'这点可以接受'}},'这点可以接受');assert.equal(ambiguous.state.objections.filter(o=>o.resolved).length,0);
});
test('excluding an extra service preserves the agreed core scope and handoff summary',()=>{
  const agent={...sales.validateSales({salesScenario:'services',salesEnabled:true}),collectEnabled:true};
  const c={salesState:{...sales.empty(),facts:{serviceScope:{value:'地面和厨卫日常保洁',evidence:'地面和厨卫日常保洁'}}}};
  const r=sales.advance(agent,c,{facts:{serviceScope:{value:'不增加油烟机拆洗',evidence:'不增加油烟机拆洗'}}},'不增加油烟机拆洗');
  assert.equal(r.state.facts.serviceScope.value,'地面和厨卫日常保洁');assert.equal(r.state.constraints[0].value,'不增加油烟机拆洗');
  const implicit=sales.advance(agent,c,{facts:{serviceScope:{value:'油烟机拆洗',evidence:'不增加油烟机拆洗'}}},'不增加油烟机拆洗');assert.equal(implicit.state.facts.serviceScope.value,'地面和厨卫日常保洁');assert.equal(implicit.state.constraints[0].value,'不增加油烟机拆洗');
  const explicit=sales.advance(agent,c,{constraints:[{field:'serviceScope',value:'不增加油烟机拆洗',evidence:'不增加油烟机拆洗'},{field:'unknown',value:'不要其他',evidence:'不要其他'},{field:'serviceScope',value:'不要旧原话',evidence:'不要旧原话'},{field:'serviceScope',value:'日常保洁',evidence:'还是日常保洁'}]},'不增加油烟机拆洗，不要其他，还是日常保洁');
  assert.equal(explicit.state.facts.serviceScope.value,'地面和厨卫日常保洁');assert.equal(explicit.state.constraints.length,1);assert.equal(explicit.state.constraints[0].value,'不增加油烟机拆洗');
  const summary=sales.summary({name:'验收',salesState:r.state});assert.match(summary,/地面和厨卫日常保洁/);assert.match(summary,/补充限制.*不增加油烟机拆洗/);
});
test('withdrawing an exact prior value clears it without treating the negation as a new value',()=>{
  const agent={...sales.validateSales({salesScenario:'hospitality',salesEnabled:true}),collectEnabled:true};
  const r=sales.advance(agent,{salesState:{...sales.empty(),facts:{stayLength:{value:'两晚',evidence:'两晚'}}}},{facts:{stayLength:{value:'不是两晚',evidence:'不是两晚'}}},'不是两晚');
  assert.equal(r.state.facts.stayLength,undefined);assert.equal(r.state.constraints[0].value,'不是两晚');
});
test('a partial word exclusion does not erase core scope; an explicit later choice replaces the same exclusion',()=>{
  const agent={...sales.validateSales({salesScenario:'services',salesEnabled:true}),collectEnabled:true};
  const c={salesState:{...sales.empty(),facts:{serviceScope:{value:'保洁',evidence:'保洁'}}}};
  const excluded=sales.advance(agent,c,{facts:{serviceScope:{value:'不要开荒保洁',evidence:'不要开荒保洁'}}},'不要开荒保洁');
  assert.equal(excluded.state.facts.serviceScope.value,'保洁');assert.equal(excluded.state.constraints.length,1);
  const correction=sales.advance(agent,{salesState:excluded.state},{facts:{serviceScope:{value:'开荒保洁',evidence:'改为开荒保洁'}}},'改为开荒保洁');
  assert.equal(correction.state.facts.serviceScope.value,'开荒保洁');assert.equal(correction.state.constraints.length,0);
});
test('exact product identifiers cannot be replaced by a semantically similar SKU',async t=>{
  const {db,call,app}=setup({embeddingCall:async input=>input.map(()=>[1,0])});t.after(()=>db.close());
  for(const code of ['SKU-0001','SKU-0002','L100','L200'])await call('POST','/knowledge',{title:code+' 产品',body:'合成商品 '+code+' 说明和报价',category:'零售'});
  await call('POST','/knowledge/index',{});
  for(const code of ['SKU-0001','SKU-0002','L100','L200']){const r=(await call('POST','/knowledge/search',{query:'请介绍 '+code})).data;assert.equal(r.list.length,1);assert.ok(r.list[0].title.startsWith(code));}
  assert.equal((await call('POST','/knowledge/search',{query:'请介绍 SKU-9999'})).data.list.length,0);
  assert.equal(app.retrieve('请介绍 SKU-9999').length,0);
});
test('general product policy remains eligible for a compact model query; business concept expansion is observable',async t=>{
  const {db,call}=setup();t.after(()=>db.close());
  await call('POST','/knowledge',{title:'灯具保修说明',body:'台灯整机保修一年',category:'零售'});
  const found=(await call('POST','/knowledge/search',{query:'L200的质保'})).data;
  assert.equal(found.list[0].title,'灯具保修说明');assert.deepEqual(found.expandedTerms,['保修']);
});
test('weak semantic-only hits abstain; exact lexical evidence is still usable',async t=>{
  const {db,call}=setup({modelConfig:()=>({embeddingMinScore:.4}),embeddingCall:async input=>input.map(s=>s.includes('\n')?[.405,Math.sqrt(1-.405**2)]:[1,0])});t.after(()=>db.close());
  await call('POST','/knowledge',{title:'客房资料',body:'双床房入住说明'});await call('POST','/knowledge/index',{});
  const weak=(await call('POST','/knowledge/search',{query:'完全无关的问题'})).data;assert.equal(weak.list.length,0);assert.match(weak.warning,/偏低/);
  const exact=(await call('POST','/knowledge/search',{query:'客房资料'})).data;assert.equal(exact.list.length,1);assert.equal(exact.list[0].match,'hybrid');
});
test('lexical Chinese connectors do not create cross-word false positives',async t=>{
  const {db,call}=setup();t.after(()=>db.close());
  await call('POST','/knowledge',{title:'课程形式与课时',body:'基础摄影为四次线下课，每次两小时。'});
  assert.equal((await call('POST','/knowledge/search',{query:'欧拉公式与复平面的关系'})).data.list.length,0);
  assert.equal((await call('POST','/knowledge/search',{query:'课程课时是多少'})).data.list.length,1);
});
test('sales keeps valid prior evidence, but never after knowledge retirement or scope changes',async t=>{
  let prompt='';const {db,call,app}=setup({modelCall:async p=>{prompt=p;return {reply:'已理解您的需求。',handoff:false};}});t.after(()=>db.close());
  const k=(await call('POST','/knowledge',{title:'客房设施',body:'双床房是两张单人床',category:'住宿'})).data;
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'测试客栈',salesEnabled:true,knowledgeCategories:['住宿']});
  const c=(await call('POST','/sandbox',{agentId:'default',content:'客房设施是什么'})).data;
  await call('POST','/conversations/'+c.id+'/incoming',{content:'我想继续了解'});assert.match(prompt,/双床房是两张单人床/);
  await call('PATCH','/knowledge/'+k.id,{enabled:false});await call('POST','/conversations/'+c.id+'/incoming',{content:'再解释一下'});assert.doesNotMatch(prompt,/双床房是两张单人床/);
  await call('PATCH','/knowledge/'+k.id,{enabled:true});await call('PATCH','/agent/default',{knowledgeCategories:['其他']});
  await call('POST','/conversations/'+c.id+'/incoming',{content:'客房设施'});assert.doesNotMatch(prompt,/双床房是两张单人床/);assert.equal(app.all('knowledge').length,1);
});
test('bulk review is atomic, version checked, bounded and preserves revision history',async t=>{
  const {db,call,app}=setup();t.after(()=>db.close());
  const docs=[];for(let i=0;i<100;i++)docs.push((await call('POST','/knowledge',{title:'条目'+i,body:'独立正文'+i,enabled:false})).data);
  const items=docs.map(k=>({id:k.id,expectedVersion:1}));
  assert.equal((await call('POST','/knowledge/batch',{action:'enable',items:[...items.slice(0,99),{id:items[99].id,expectedVersion:2}]})).status,409);
  assert.equal(app.all('knowledge').filter(k=>k.enabled).length,0);
  assert.equal((await call('POST','/knowledge/batch',{action:'enable',items})).data.updated,100);
  assert.equal(app.all('knowledgeRevision').length,200);
  assert.equal((await call('POST','/knowledge/batch',{action:'disable',items})).status,409);
  assert.equal((await call('POST','/knowledge/batch',{action:'enable',items:[items[0],items[0]]})).status,400);
  assert.equal((await call('POST','/knowledge/batch',{action:'archive',items:items.map(k=>({...k,expectedVersion:2}))})).status,200);
  assert.equal(app.retrieve('独立正文').length,0);
});
test('paged knowledge, lightweight state, category scopes and cache invalidation',async t=>{
  const {db,call,app}=setup({embeddingCall:async input=>input.map(()=>[1,0])});t.after(()=>db.close());
  for(let i=0;i<125;i++)app.put('knowledge',{title:'知识'+i,body:'服务时段与营业时间 '+i,category:i%2?'零售':'住宿',enabled:true,version:1},'doc'+i);
  const page=await call('GET','/knowledge/list?page=2&limit=50');assert.equal(page.data.total,125);assert.equal(page.data.list.length,50);
  assert.equal((await call('GET','/knowledge/list?q=知识124')).data.list[0].id,'doc124');
  const state=(await call('GET','/state')).data;assert.ok(state.knowledge.every(k=>!('body'in k)));
  assert.equal((await call('GET','/knowledge/doc124')).data.body,'服务时段与营业时间 124');
  await call('PATCH','/agent/default',{knowledgeCategories:['住宿']});
  while(app.stats().knowledgeIndex.pending)assert.equal((await call('POST','/knowledge/index',{})).status,200);
  const result=(await call('POST','/knowledge/search',{query:'什么时候营业',agentId:'default'})).data;assert.ok(result.list.every(k=>k.category==='住宿'));
  const before=result.list[0];await call('PATCH','/knowledge/'+before.id,{enabled:false});
  assert.ok(!(await call('POST','/knowledge/search',{query:'什么时候营业',agentId:'default'})).data.list.some(k=>k.id===before.id));
  app.put('knowledge',{...app.get('knowledge','doc124'),body:'全新特殊口径'} ,'doc124');assert.equal(app.retrieve('全新特殊口径')[0].id,'doc124');
});
test('background indexing pauses after current batch, resumes, deduplicates start and persists progress',async t=>{
  let release,started;let block=true;const entered=new Promise(r=>started=r);
  const {db,call,app}=setup({embeddingCall:async input=>{if(block){started();await new Promise(r=>release=r)}return input.map(()=>[1,0]);}});t.after(()=>db.close());
  for(let i=0;i<75;i++)app.put('knowledge',{title:'知识'+i,body:'正文'+i,category:'测试',enabled:true},'doc'+i);
  assert.equal((await call('POST','/knowledge/index-jobs',{action:'start'})).status,202);await entered;
  await call('POST','/knowledge/index-jobs',{action:'start'});await call('POST','/knowledge/index-jobs',{action:'pause'});block=false;release();
  for(let i=0;i<100&&app.stats().knowledgeIndex.job.status!=='paused';i++)await wait();
  assert.equal(app.stats().knowledgeIndex.ready,32);assert.equal(app.stats().knowledgeIndex.job.status,'paused');
  await call('POST','/knowledge/index-jobs',{action:'resume'});
  for(let i=0;i<100&&app.stats().knowledgeIndex.job.status!=='completed';i++)await wait();
  assert.equal(app.stats().knowledgeIndex.ready,75);assert.equal(app.stats().knowledgeIndex.job.indexed,43);assert.equal(app.all('knowledgeVector').length,75);
});
test('interrupted jobs require explicit resume; errors retain completed vectors',async t=>{
  let shouldFail=false;const {db,call,app,options}=setup({embeddingCall:async input=>{if(shouldFail)throw Error('服务暂不可用');return input.map(()=>[1,0]);}});t.after(()=>db.close());
  app.put('knowledge',{title:'资料',body:'正文',enabled:true},'doc');await call('POST','/knowledge/index',{});
  app.put('knowledgeIndexJob',{status:'running',indexed:1,batches:1},'active');const restarted=createGrowth(options);
  assert.equal(restarted.stats().knowledgeIndex.job.status,'interrupted');assert.equal(restarted.stats().knowledgeIndex.ready,1);
  app.put('knowledge',{title:'新资料',body:'新正文',enabled:true},'doc2');shouldFail=true;await call('POST','/knowledge/index-jobs',{action:'resume'});
  for(let i=0;i<100&&app.stats().knowledgeIndex.job.status!=='failed';i++)await wait();
  assert.equal(app.stats().knowledgeIndex.job.status,'failed');assert.equal(app.stats().knowledgeIndex.ready,1);
});
test('large exact scan yields, and a concurrent edit cannot leak stale knowledge',async t=>{
  const {db,call,app}=setup({embeddingCall:async input=>input.map(()=>[1,0])});t.after(()=>db.close());
  for(let i=0;i<1100;i++)app.put('knowledge',{title:'资料'+i,body:'内容 '+i,category:'验收',enabled:true},'doc'+i);
  while(app.stats().knowledgeIndex.pending)await call('POST','/knowledge/index',{});
  const pending=call('POST','/knowledge/search',{query:'问题'});
  setImmediate(()=>{for(const k of app.all('knowledge'))app.put('knowledge',{...k,enabled:false},k.id)});
  const result=await pending;assert.equal(result.data.mode,'keyword');assert.equal(result.data.list.length,0);
});
