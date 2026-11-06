'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createGrowth,onDuty,extract}=require('../growth.js');
function setup(options={}){
  const db=new DatabaseSync(':memory:');
  let now=Date.parse('2026-10-18T02:00:00Z')/1000;
  const app=createGrowth({db,sendJson:(res,status,data)=>{res.status=status;res.data=data},readBody:async req=>req.body||{},clock:()=>now,...options});
  return {db,app,advance:s=>now+=s,call:async(method,path,body)=>{const res={};await app.handle({method,body},res,new URL('http://localhost/api/growth'+path));return res;}};
}
test('business facts are opt-in, exact SKU scoped, version checked and cannot claim execution',async t=>{
  let prompt='',reply='商品 SKU-001 当前可用 5 件，单价 120.50 元。',mutate=()=>{};
  const {db,app,call}=setup({modelCall:async p=>{prompt=p;mutate();return {reply,handoff:false}}});t.after(()=>db.close());
  const p=app.put('commerceProduct',{sku:'SKU-001',name:'测试商品',price:12050,stock:5,reserved:0,unit:'件',description:'本地实际目录',version:1,enabled:true});
  app.put('commerceProduct',{sku:'SKU-002',name:'测试商品',price:99900,stock:8,reserved:0,unit:'件',version:1,enabled:true});
  await call('PATCH','/agent/default',{lookupLocalBusiness:true});
  let result=await call('POST','/preview',{message:'测试商品 SKU-001 价格和库存多少？'});assert.equal(result.data.source,'model');assert.equal(result.data.businessRefs.length,1);assert.equal(result.data.businessRefs[0].id,p.id);assert.match(prompt,/12050/);assert.doesNotMatch(prompt,/99900/);assert.equal(app.all('commerceOrder').length,0);
  reply='已经帮你下单了';result=await call('POST','/preview',{message:'SKU-001 帮我下单'});assert.equal(result.data.source,'guardrail');assert.equal(result.data.handoff,true);
  reply='还有 5 件';mutate=()=>app.put('commerceProduct',{...p,stock:0,version:2},p.id);result=await call('POST','/preview',{message:'SKU-001 库存'});assert.equal(result.data.source,'guardrail');assert.match(result.data.reason,/版本/);
  mutate=()=>{};await call('PATCH','/agent/default',{lookupLocalBusiness:false});result=await call('POST','/preview',{message:'SKU-001 库存'});assert.equal((result.data.businessRefs||[]).length,0);assert.doesNotMatch(prompt,/12050/);
});
test('knowledge: editable, disable immediately removes retrieval, scope enforced',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const a=await call('POST','/knowledge',{title:'入住时间',body:'下午三点办理入住，上午十一点退房。',enabled:true});
  assert.equal(a.status,201);
  assert.equal(app.retrieve('入住时间是什么时候')[0].id,a.data.id);
  assert.equal(app.retrieve('入住时间',[a.data.id]).length,1);
  assert.equal(app.retrieve('入住时间',['missing']).length,0);
  await call('PATCH','/knowledge/'+a.data.id,{enabled:false});
  assert.equal(app.retrieve('入住时间').length,0);
});
test('sandbox: persists messages and extracts only source contact information',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const r=await call('POST','/sandbox',{name:'测试客户',content:'我要预约，手机号 13800000000，微信 wx_test_01'});
  assert.equal(r.status,201);
  assert.equal(app.history(r.data.id).length,1);
  const lead=app.get('lead',r.data.id);
  assert.equal(lead.phone,'13800000000');assert.equal(lead.wechat,'wx_test_01');assert.equal(lead.intent,'high');
});
test('reply: idempotent send and failed delivery never reported as sent',async t=>{
  let externalCalls=0;
  const {db,app}=setup({sendExternal:async()=>{externalCalls++;throw new Error('平台拒绝')}});
  t.after(()=>db.close());
  const c=app.newConversation({name:'外部客户',channel:'wechat',sourceKind:'dm'});
  await assert.rejects(()=>app.send(c,'你好','req-1'),/平台拒绝/);
  assert.equal(app.history(c.id)[0].delivery,'failed');
  await assert.rejects(()=>app.send(c,'你好','req-1'),/上次发送失败/);
  assert.equal(externalCalls,1);
  const s=app.newConversation({name:'测试'});
  const first=await app.send(s,'收到','local-1');
  const second=await app.send(s,'收到','local-1');
  assert.equal(first.id,second.id);assert.equal(app.history(s.id).length,1);
  await assert.rejects(()=>app.send(s,'其他内容','local-1'),/已被其他消息/);
});
test('handoff: explicit request stops AI and stores reason',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true});
  const r=await call('POST','/sandbox',{name:'测试',content:'我要人工客服',agentId:'default'});
  assert.equal(r.data.status,'human');assert.match(r.data.handoffReason,/人工/);
  assert.equal(app.history(r.data.id).filter(m=>m.role==='ai').length,0);
});
test('AI preview uses supplied model and knowledge references, no customer writes',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'入住时间是下午三点。',handoff:false})});t.after(()=>db.close());
  await call('POST','/knowledge',{title:'入住时间',body:'下午三点入住。'});
  const r=await call('POST','/preview',{message:'几点入住？'});
  assert.equal(r.status,200);assert.equal(r.data.source,'model');assert.equal(r.data.refs.length,1);
  assert.equal(app.all('conversation').length,0);
});
test('AI race: takeover during model generation discards stale response',async t=>{
  let resolveModel,started;
  const ready=new Promise(r=>started=r);
  const {db,app,call}=setup({modelCall:async()=>{started();return new Promise(r=>resolveModel=r)}});
  t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false});
  let c=app.newConversation({name:'测试'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'我想咨询服务');
  const pending=app.autoReply(c.id);await ready;
  await call('PATCH','/conversations/'+c.id,{status:'human',owner:'owner'});
  resolveModel({reply:'可以的',handoff:false});
  const result=await pending;assert.equal(result.skipped,true);
  assert.equal(app.history(c.id).filter(m=>m.role==='ai').length,0);
});
test('AI assessment: grounded intent persists, triggers once, and manual correction clears evidence',async t=>{
  const evidence='我们四个人周日下午能一起过来吗';
  const {db,app,call}=setup({modelCall:async()=>({reply:'可以先告知预计到店时间，由同事确认。',handoff:false,assessment:{intent:'high',confidence:0.92,reason:'已有具体人数与到店计划',evidence,tags:['多人到店']}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,brand:'合成书店'});
  await call('POST','/rule',{name:'语义高意向跟进',trigger:'high_intent',action:'followup',value:'确认到店需求',minutes:5,enabled:true});
  let c=app.newConversation({name:'语义测试'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,evidence);
  assert.notEqual(app.get('conversation',c.id).intent,'high');
  await app.autoReply(c.id);await app.autoReply(c.id);
  assert.equal(app.history(c.id).find(m=>m.role==='ai').source,'model');
  assert.ok(Array.isArray(app.history(c.id).find(m=>m.role==='ai').refs));
  assert.equal(app.get('conversation',c.id).intentAssessment.evidence,evidence);
  assert.equal(app.get('lead',c.id).intent,'high');assert.equal(app.all('task').length,1);
  const manual=await call('PATCH','/leads/'+c.id,{intent:'low'});assert.equal(manual.status,200);
  assert.equal(app.get('lead',c.id).intentAssessment,null);assert.equal(app.get('conversation',c.id).intentAssessment,null);
});
test('rule engine: event trigger, keyword condition, assignment and replay deduplication',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const r=await call('POST','/rule',{name:'预约跟进',trigger:'high_intent',channel:'sandbox',keyword:'预约',action:'followup',value:'联系确认预约',minutes:5,enabled:true});
  const c=app.newConversation({name:'测试'});
  const next=app.receive(c,'我想预约',{id:'incoming-1'});
  app.runRules(next,'我想预约','high_intent','incoming-1');
  assert.equal(app.all('task').length,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM growth_runs').get().n,1);
  assert.equal(r.status,201);
});
test('disabled information extraction suppresses contact, keyword and semantic intent but keeps handoff',async t=>{
  const message='我想预约周末活动，电话 13800000000';
  const {db,app,call}=setup({modelCall:async()=>({reply:'收到，具体安排请等同事确认。',handoff:false,assessment:{intent:'high',confidence:.95,reason:'明确预约需求',evidence:'我想预约周末活动',tags:['预约']}})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false,collectEnabled:false,brand:'合成资料'});
  let c=app.newConversation({name:'关闭提取'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,message);await app.autoReply(c.id);
  assert.equal(app.get('lead',c.id),null);assert.equal(app.get('conversation',c.id).intent,'low');assert.equal(app.get('conversation',c.id).intentAssessment,undefined);
  assert.equal(app.get('conversation',c.id).tags.length,0);
  app.receive(app.get('conversation',c.id),'我要人工客服');assert.equal(app.get('conversation',c.id).status,'human');
});
test('silence rules: separate delays, one run per outbound message, opt-out exclusion',async t=>{
  const {db,app,call,advance}=setup();t.after(()=>db.close());
  for(const minutes of [5,30])await call('POST','/rule',{name:'等待'+minutes,trigger:'silent',action:'tag',value:'等待'+minutes,minutes,enabled:true});
  let c=app.newConversation({name:'测试'});
  app.receive(c,'你好');await app.send(app.get('conversation',c.id),'请问有什么需要？','reply');
  advance(6*60);app.tick();app.tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM growth_runs').get().n,1);
  advance(25*60);app.tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM growth_runs').get().n,2);
  c=app.receive(app.get('conversation',c.id),'别再联系');
  await assert.rejects(()=>app.send(c,'再问一下','next'),/停止联系/);
  assert.equal(c.optedOut,true);
});
test('agent schedule honors Shanghai timezone, disabled flag and selected days',()=>{
  const a={enabled:true,schedule:'weekly',days:['0'],start:'09:00',end:'18:00'};
  assert.equal(onDuty(a,Date.parse('2026-10-18T02:00:00Z')/1000),true);
  assert.equal(onDuty(a,Date.parse('2026-10-18T12:00:00Z')/1000),false);
  assert.equal(onDuty({...a,enabled:false},Date.parse('2026-10-18T02:00:00Z')/1000),false);
  assert.equal(onDuty({...a,days:['5'],start:'22:00',end:'06:00'},Date.parse('2026-10-16T18:00:00Z')/1000),true);
});

test('message history pagination handles identical timestamps without omissions',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());const c=app.newConversation({name:'历史测试'});
  for(let i=0;i<205;i++)app.receive(app.get('conversation',c.id),'消息 '+i,{id:'history-'+i,ts:100});
  const latest=app.history(c.id);assert.equal(latest.length,200);assert.equal(latest[0].content,'消息 5');
  const older=await call('GET','/conversations/'+c.id+'/messages?beforeTs=100&beforeSeq='+latest[0].sequence);
  assert.equal(older.data.messages.length,5);assert.equal(older.data.messages[0].content,'消息 0');
});

test('crash recovery: uncertain delivery is labelled unknown and not retried',async t=>{
  const {db,app}=setup();t.after(()=>db.close());const c=app.newConversation({name:'恢复测试'});
  db.prepare('INSERT INTO growth_messages VALUES(?,?,?,?,?,?,?)').run('uncertain',c.id,'human','待核实',100,'sending','uncertain-request');
  const resumed=createGrowth({db});assert.equal(resumed.history(c.id)[0].delivery,'unknown');
  await assert.rejects(()=>resumed.send(resumed.get('conversation',c.id),'待核实','uncertain-request'),/结果未知/);
});

test('unread and unanswered are separate: reading never clears pending reply',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const c=(await call('POST','/sandbox',{name:'已读未回',content:'你好'})).data;
  await call('PATCH','/conversations/'+c.id,{read:true});
  assert.equal((await call('GET','/conversations?status=unread')).data.total,0);
  assert.equal((await call('GET','/conversations?status=pending')).data.total,1);
  assert.equal(app.stats().pending,1);
  await call('POST','/conversations/'+c.id+'/reply',{content:'收到',requestId:'pending-done'});
  assert.equal(app.stats().pending,0);
});
test('resource validation rejects unknown status, owner, invalid URLs and schedule',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  assert.equal((await call('PATCH','/agent/default',{start:'25:90'})).status,400);
  assert.equal((await call('POST','/card',{name:'卡片',title:'测试',url:'javascript:alert(1)'})).status,400);
  const c=app.newConversation({name:'测试'});
  assert.equal((await call('PATCH','/conversations/'+c.id,{owner:'nonexistent'})).status,404);
  assert.equal((await call('PATCH','/conversations/'+c.id,{status:'invalid'})).status,400);
});
test('unsupported platform send and incoming injection fail explicitly',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const c=app.newConversation({name:'外部',channel:'xiaohongshu',sourceKind:'dm'});
  assert.equal((await call('POST','/conversations/'+c.id+'/incoming',{content:'伪造消息'})).status,400);
  assert.equal((await call('POST','/conversations/'+c.id+'/reply',{content:'你好',requestId:'x'})).status,409);
  assert.equal(app.history(c.id).length,0);
});
test('no key fallback is honestly labelled and unknown knowledge hands off',async t=>{
  const names=['NOTE_LLM_KEY','KIMI_API_KEY','MOONSHOT_API_KEY','DEEPSEEK_API_KEY','OPENAI_API_KEY','GROWTH_LLM_KEY'];
  const saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));for(const n of names)delete process.env[n];
  t.after(()=>{for(const [n,v] of Object.entries(saved)){if(v===undefined)delete process.env[n];else process.env[n]=v}});
  const {db,call}=setup();t.after(()=>db.close());
  const r=await call('POST','/preview',{message:'明天某特殊房型还有没有？'});
  assert.equal(r.data.source,'fallback');assert.equal(r.data.handoff,true);assert.equal(r.data.refs.length,0);
});

test('pending followups cancelled on resolution or opt-out; oversized knowledge rejected',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const c=app.newConversation({name:'测试'});
  await call('POST','/conversations/'+c.id+'/task',{title:'跟进'});
  await call('PATCH','/conversations/'+c.id,{status:'resolved'});
  assert.equal(app.all('task')[0].status,'cancelled');
  assert.equal((await call('POST','/conversations/'+c.id+'/task',{title:'不应创建'})).status,409);
  await call('PATCH','/conversations/'+c.id,{status:'open'});
  await call('POST','/conversations/'+c.id+'/task',{title:'新跟进'});
  app.receive(app.get('conversation',c.id),'退订');
  assert.equal(app.all('task').filter(t=>t.status==='pending').length,0);
  assert.equal((await call('POST','/knowledge',{title:'太长',body:'x'.repeat(30001)})).status,400);
});
test('AI provider failure persists customer message and hands off without fake reply',async t=>{
  const {db,app,call}=setup({modelCall:async()=>{throw new Error('service offline')}});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false});
  const r=await call('POST','/sandbox',{name:'测试',content:'你好',agentId:'default'});
  assert.equal(r.status,201);assert.equal(r.data.status,'human');assert.equal(app.history(r.data.id).length,1);
});
test('human reply itself cancels an in-flight AI response',async t=>{
  let resolveModel,started;const ready=new Promise(r=>started=r);
  const {db,app,call}=setup({modelCall:()=>{started();return new Promise(r=>resolveModel=r)}});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false});
  let c=app.newConversation({name:'测试'});c=app.put('conversation',{...c,status:'ai'},c.id);app.receive(c,'问题');
  const pending=app.autoReply(c.id);await ready;
  await call('POST','/conversations/'+c.id+'/reply',{content:'人工正在处理',requestId:'human-1'});
  resolveModel({reply:'不应出现',handoff:false});await pending;
  assert.equal(app.history(c.id).filter(m=>m.role==='ai').length,0);assert.equal(app.get('conversation',c.id).status,'human');
});
test('workflows: branch, wait, restart recovery and exactly-once task creation',async t=>{
  const {db,app,call,advance}=setup();t.after(()=>db.close());
  const w=await call('POST','/workflow',{name:'预约流程',enabled:true,trigger:'incoming',nodes:[
    {id:'condition',type:'condition',field:'text',operator:'contains',value:'预约',next:'wait'},
    {id:'wait',type:'wait',minutes:1,next:'task'},
    {id:'task',type:'task',value:'预约确认',minutes:5,next:'tag'},
    {id:'tag',type:'tag',value:'已跟进'},
  ]});assert.equal(w.status,201);
  const c=app.newConversation({name:'测试'});app.receive(c,'我想预约',{id:'w-msg-1'});
  assert.equal(app.all('workflowRun')[0].status,'waiting');assert.equal(app.all('task').length,0);
  advance(61);
  const resumed=createGrowth({db,clock:()=>Date.parse('2026-10-18T02:02:00Z')/1000});
  resumed.tick();resumed.tick();
  assert.equal(resumed.all('workflowRun')[0].status,'completed');assert.equal(resumed.all('task').length,1);
  assert.deepEqual(resumed.get('conversation',c.id).tags,['已跟进']);
  resumed.receive(resumed.get('conversation',c.id),'重复消息',{id:'w-msg-1'});
  assert.equal(resumed.all('workflowRun').length,1);
});
test('workflows: false branch, reply cancellation and invalid cycles',async t=>{
  const {db,app,call,advance}=setup();t.after(()=>db.close());
  const cyclic=await call('POST','/workflow',{name:'错误流程',nodes:[{id:'a',type:'wait',next:'b'},{id:'b',type:'wait',next:'a'}]});
  assert.equal(cyclic.status,400);assert.match(cyclic.data.error,/循环/);
  await call('POST','/workflow',{name:'沉默跟进',enabled:true,trigger:'incoming',nodes:[{id:'a',type:'wait',minutes:1,next:'b'},{id:'b',type:'tag',value:'已沉默'}]});
  const c=app.newConversation({name:'测试'});app.receive(c,'你好',{id:'msg-a'});app.receive(app.get('conversation',c.id),'补充消息',{id:'msg-b'});
  advance(61);app.tick();
  assert.equal(app.all('workflowRun').filter(r=>r.status==='cancelled').length,1);
  assert.equal(app.all('workflowRun').filter(r=>r.status==='completed').length,1);
  const w=await call('POST','/workflow',{name:'分支',enabled:true,trigger:'manual',nodes:[{id:'a',type:'condition',field:'phone',operator:'exists',next:'b',otherwise:'c'},{id:'b',type:'tag',value:'已留资'},{id:'c',type:'note',value:'需人工询问联系方式'}]});
  await call('POST','/workflow/start',{workflowId:w.data.id,conversationId:c.id,requestId:'run'});
  assert.equal(app.history(c.id).at(-1).content,'需人工询问联系方式');
  assert.ok(!app.get('conversation',c.id).tags.includes('已留资'));
});
test('source import: correct original dates, threaded replies, handled state and replay dedup',async t=>{
  const {db,app}=setup();t.after(()=>db.close());
  db.exec(`CREATE TABLE accounts(id INTEGER,label TEXT,username TEXT);INSERT INTO accounts VALUES(1,'测试账号','self');
    CREATE TABLE dm_sessions(platform TEXT,accountId INTEGER,sessionId TEXT,nickname TEXT,username TEXT);
    INSERT INTO dm_sessions VALUES('wechat',1,'session','客户','peer');
    CREATE TABLE dm_messages(platform TEXT,accountId INTEGER,sessionId TEXT,svrMsgId TEXT,fromUsername TEXT,content TEXT,ts INTEGER);
    INSERT INTO dm_messages VALUES('wechat',1,'session','1','peer','你好',100),('wechat',1,'session','2','self','您好',200);
    CREATE TABLE comments(platform TEXT,accountId INTEGER,commentId TEXT,rootCommentId TEXT,nickname TEXT,content TEXT,createTime INTEGER,isAuthor INTEGER);
    INSERT INTO comments VALUES('wechat',1,'root','','客户','多少钱',100,0),('wechat',1,'reply','root','店主','请看详情',200,1);
    CREATE TABLE handled_marks(platform TEXT,accountId INTEGER,kind TEXT,targetId TEXT,createdAt INTEGER);
    INSERT INTO handled_marks VALUES('wechat',1,'session','session',210);`);
  assert.equal(app.sync().added,4);assert.equal(app.sync().added,0);
  const dm=app.all('conversation').find(c=>c.sourceKind==='dm'),comment=app.all('conversation').find(c=>c.sourceKind==='comment');
  assert.equal(dm.created,100);assert.equal(dm.status,'resolved');assert.equal(dm.lastContent,'您好');assert.equal(dm.unread,0);
  assert.equal(app.history(comment.id).length,2);assert.equal(comment.lastContent,'请看详情');
});

test('agent screening: all/any include criteria and exclusions hand off rather than discarding leads',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,screeningEnabled:true,screeningMode:'all',screeningKeywords:['预约','周末'],excludeKeywords:['广告'],welcomeEnabled:false});
  const reject=await call('POST','/sandbox',{name:'筛选测试',agentId:'default',content:'广告：周末预约'});
  assert.equal(reject.data.status,'human');assert.equal(reject.data.qualification,'needs_review');assert.ok(app.get('lead',reject.data.id));
  const c=app.newConversation({name:'筛选通过'}),matched=app.receive(c,'我想预约周末参观');
  assert.equal(matched.qualification,'matched');
  const partial=app.receive(app.newConversation({name:'信息不足'}),'预约');assert.equal(partial.status,'human');
});
test('GPT transport: sends one copy of current message, reasoning parameters, and retains refs',async t=>{
  const http=require('node:http');let payload;
  const fake=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;payload=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"reply":"可在营业时间预约参观","handoff":false}'}}]}));});
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>fake.close(r)));
  const vars=['GROWTH_LLM_KEY','GROWTH_LLM_BASE_URL','GROWTH_LLM_MODEL'];const saved=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
  process.env.GROWTH_LLM_KEY='test-key';process.env.GROWTH_LLM_BASE_URL='http://127.0.0.1:'+fake.address().port;process.env.GROWTH_LLM_MODEL='gpt-6-astra';
  t.after(()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const {db,app}=setup();t.after(()=>db.close());
  const c=app.newConversation({name:'测试'});app.receive(c,'周末营业时间？');
  const result=await app.generate(app.get('agent','default'),c,'周末营业时间？');
  assert.equal(result.source,'model');assert.equal(payload.model,'gpt-6-astra');assert.equal(payload.reasoning_effort,'low');assert.ok(!('temperature' in payload));
  assert.equal(payload.messages.filter(m=>m.content==='周末营业时间？').length,1);
});
test('malicious reply content blocked by configured terms',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'保证收益，放心报名',handoff:false})});t.after(()=>db.close());
  const r=await call('POST','/preview',{message:'介绍一下'});
  assert.equal(r.data.source,'guardrail');assert.equal(r.data.handoff,true);
  const c=app.newConversation({name:'测试'});await assert.rejects(()=>app.send(c,'保证收益','x'),/限制词/);
});
test('lead edits, state persistence and filters are real database operations',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const r=await call('POST','/sandbox',{name:'演示客户',content:'多少钱'});
  await call('PATCH','/leads/'+r.data.id,{stage:'scheduled',tags:['周末'],notes:'等待确认'});
  assert.equal(app.get('lead',r.data.id).stage,'scheduled');
  const rows=await call('GET','/conversations?q=演示&status=unread&channel=sandbox');
  assert.equal(rows.data.total,1);
  await call('PATCH','/conversations/'+r.data.id,{read:true,status:'resolved'});
  assert.equal((await call('GET','/conversations?status=unread')).data.total,0);
  assert.equal(app.stats().resolved,1);
});

test('return to AI handles an unanswered message once, but never repeats a human answer',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'您好，我来为您解答。',handoff:false})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:false});
  const c=(await call('POST','/sandbox',{name:'接管验收',content:'你好'})).data;
  await call('PATCH','/conversations/'+c.id,{status:'human'});
  await call('POST','/conversations/'+c.id+'/incoming',{content:'您好'});
  const before=app.history(c.id).length;
  const back=await call('PATCH','/conversations/'+c.id,{status:'ai'});
  assert.equal(back.status,200);assert.equal(app.history(c.id).length,before+1);assert.equal(back.data.awaitingReply,false);
  await call('PATCH','/conversations/'+c.id,{status:'ai'});assert.equal(app.history(c.id).length,before+1);
  await call('PATCH','/conversations/'+c.id,{status:'human'});
  await call('POST','/conversations/'+c.id+'/incoming',{content:'还在吗'});
  await call('POST','/conversations/'+c.id+'/reply',{content:'我已在处理',requestId:'handled'});
  const handled=app.history(c.id).length;
  await call('PATCH','/conversations/'+c.id,{status:'ai'});assert.equal(app.history(c.id).length,handled);
});
test('opt-out remains effective after another incoming message and cancelled task cannot revive',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());
  const c=(await call('POST','/sandbox',{name:'退订验收',content:'预约'})).data;
  const task=(await call('POST','/conversations/'+c.id+'/task',{title:'回访'})).data;
  app.receive(app.get('conversation',c.id),'退订');app.receive(app.get('conversation',c.id),'谢谢');
  assert.equal(app.get('conversation',c.id).awaitingReply,false);assert.equal(app.stats().pending,0);
  assert.equal((await call('PATCH','/tasks/'+task.id,{status:'pending'})).status,409);
  assert.equal((await call('PATCH','/conversations/'+c.id,{status:'ai'})).status,409);
});
test('internal notes are idempotent across a lost response and reject reused message IDs',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());const c=app.newConversation({name:'备注'});
  const path='/conversations/'+c.id+'/note',body={content:'团队可见',requestId:'note-once'};
  const first=await call('POST',path,body),again=await call('POST',path,body);
  assert.equal(first.data.id,again.data.id);assert.equal(app.history(c.id).length,1);
  assert.equal((await call('POST',path,{...body,content:'另一条'})).status,409);
});
test('workflows reject unsupported channels rather than silently never running',async t=>{
  const {db,call}=setup();t.after(()=>db.close());
  assert.equal((await call('POST','/workflow',{name:'错误渠道',channel:'typo',nodes:[{id:'end',type:'end'}]})).status,400);
});
test('AI welcome does not consume the pending question; invalid sandbox leaves no orphan',async t=>{
  const {db,app,call}=setup({modelCall:async()=>({reply:'您好，欢迎咨询。',handoff:false})});t.after(()=>db.close());
  await call('PATCH','/agent/default',{enabled:true,welcomeEnabled:true});
  const c=(await call('POST','/sandbox',{name:'欢迎语',agentId:'default',content:'你好'})).data;
  assert.equal(app.history(c.id).filter(m=>m.role==='ai').length,2);
  assert.equal((await call('POST','/sandbox',{name:'空消息',content:''})).status,400);
  assert.equal((await call('POST','/sandbox',{name:'不存在',agentId:'missing',content:'你好'})).status,404);
  assert.equal(app.all('conversation').length,1);
});
test('inactive members cannot receive new conversations, leads, reminders or workflow assignments',async t=>{
  const {db,app,call}=setup();t.after(()=>db.close());app.put('member',{name:'离职成员',active:false},'inactive');
  const c=(await call('POST','/sandbox',{name:'分配',content:'预约'})).data;
  for(const path of ['/conversations/','/leads/'])assert.equal((await call('PATCH',path+c.id,{owner:'inactive'})).status,409);
  assert.equal((await call('POST','/conversations/'+c.id+'/task',{title:'回访',owner:'inactive'})).status,409);
  assert.equal((await call('POST','/workflow',{name:'错误分配',nodes:[{id:'a',type:'assign',value:'inactive'}]})).status,400);
});

