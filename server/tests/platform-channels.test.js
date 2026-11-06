'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{mkdtempSync,rmSync,readFileSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {randomBytes,createCipheriv}=require('node:crypto'),{Readable}=require('node:stream');
const {createPlatformChannels}=require('../platform-channels.js'),{createGrowth}=require('../growth.js'),{signature,parseXml,vault}=require('../channel-crypto.js');
function encrypt(xml,key,receiver){const k=Buffer.from(key+'=','base64'),length=Buffer.alloc(4);length.writeUInt32BE(Buffer.byteLength(xml));const raw=Buffer.concat([randomBytes(16),length,Buffer.from(xml),Buffer.from(receiver)]),pad=32-raw.length%32,c=createCipheriv('aes-256-cbc',k,k.subarray(0,16));c.setAutoPadding(false);return Buffer.concat([c.update(Buffer.concat([raw,Buffer.alloc(pad,pad)])),c.final()]).toString('base64');}
function setup(t,options={}){
  const directory=mkdtempSync(join(tmpdir(),'channels-')),db=new DatabaseSync(':memory:');let now=1792300000;
  const spaces=new Map(),calls=[],responses=[],sent=[];let sendError=null,hub;
  const fetcher=async(url,options)=>{const u=new URL(url),b=options.body&&JSON.parse(options.body);calls.push({path:u.pathname,body:b});
    if(u.pathname.endsWith('gettoken')||u.pathname.endsWith('stable_token'))return new Response(JSON.stringify({access_token:'test-access-token',expires_in:7200}));
    if(u.pathname.endsWith('account/list'))return new Response(JSON.stringify({errcode:0,account_list:[{open_kfid:'wk_test',name:'客服一',manage_privilege:true}]}));
    if(u.pathname.endsWith('getkflist'))return new Response(JSON.stringify({errcode:0,kf_list:[]}));
    if(u.pathname.endsWith('sync_msg'))return new Response(JSON.stringify(responses.shift()||{errcode:0,msg_list:[],next_cursor:'end',has_more:0}));
    sent.push(b);if(sendError)throw sendError;return new Response(JSON.stringify({errcode:0,msgid:b.msgid||'oa-response'}));
  };
  const growthFor=(id='default')=>{if(!spaces.has(id))spaces.set(id,createGrowth({db,workspaceId:id,platformChannels:hub,clock:()=>now,sendJson:(res,status,data)=>Object.assign(res,{status,data}),readBody:async r=>r.body,modelCall:options.modelCall||(async()=>({reply:'请问你的需求是什么？',handoff:false}))}));return spaces.get(id);};
  const make=()=>createPlatformChannels({db,keyPath:join(directory,'key'),growthFor,clock:()=>now,fetcher:async(u,o)=>{await options.beforeFetch?.(new URL(u).pathname);return fetcher(u,o)},sendJson:(res,status,data)=>Object.assign(res,{status,data}),readBody:async r=>r.body});hub=make();
  const input=(provider='wecom_kf',extra={})=>({provider,name:'隔离测试',appId:provider==='wecom_kf'?'ww_test':'wx_test',originalId:provider==='wechat_official'?'gh_test':'',kfId:provider==='wecom_kf'?'wk_test':'',secret:'test-secret-never-expose',callbackToken:'testCallbackToken123',encodingAesKey:randomBytes(32).toString('base64').slice(0,-1),publicBase:'https://callbacks.example.com',...extra});
  async function callback(c,s,xml,{get=false,timestamp=now,tamper=false}={}){
    const encrypted=encrypt(xml,s.encodingAesKey,c.appId),u=new URL('http://localhost/api/channel-callback/'+c.id);u.searchParams.set('timestamp',String(timestamp));u.searchParams.set('nonce','abc123');u.searchParams.set('msg_signature',tamper?'wrong':signature(s.callbackToken,String(timestamp),'abc123',encrypted));
    if(get)u.searchParams.set('echostr',encrypted);
    const req=Readable.from(get?[]:[Buffer.from('<xml><Encrypt><![CDATA['+encrypted+']]></Encrypt></xml>')]);req.method=get?'GET':'POST';const res={writeHead(status){this.status=status},end(body){this.body=body}};
    await hub.callback(req,res,u);return res;
  }
  async function connect(provider='wecom_kf',workspace='default',extra={}){const s=input(provider,extra);let c=hub.save(workspace,s);await hub.verify(workspace,c.id);
    if(provider==='wecom_kf')await callback(c,s,'hello',{get:true});else{const u=new URL('http://localhost/api/channel-callback/'+c.id+'?timestamp='+now+'&nonce=oa&echostr=plain');u.searchParams.set('signature',signature(s.callbackToken,String(now),'oa'));await hub.callback({method:'GET'},{writeHead(){},end(){}},u);}
    c=hub.save(workspace,{expectedRevision:c.revision,enabled:true},c.id);return {c,s};}
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true})});
  return {db,directory,calls,responses,sent,input,connect,callback,growthFor,get hub(){return hub},advance:s=>now+=s,now:()=>now,setSendError:e=>sendError=e,restart:()=>{hub=make();spaces.clear();}};
}
const customer=(s,id='m1',extra={})=>({msgid:id,open_kfid:'wk_test',external_userid:'user_one',send_time:s.now(),origin:3,msgtype:'text',text:{content:'想咨询产品'},...extra});

test('channel credentials encrypted, redacted, immutable identity, revision and workspace isolation',async t=>{
  const s=setup(t),input=s.input(),c=s.hub.save('one',input);
  const raw=s.db.prepare('SELECT * FROM channel_connections').get();assert.ok(!raw.secrets.includes(input.secret));assert.ok(!JSON.stringify(c).includes(input.secret));assert.equal(readFileSync(join(s.directory,'key')).length,32);
  assert.throws(()=>s.hub.save('two',{expectedRevision:c.revision},c.id),/不存在/);
  assert.throws(()=>s.hub.save('one',{expectedRevision:0},c.id),/已更新/);
  assert.throws(()=>s.hub.save('one',{expectedRevision:c.revision,appId:'other'},c.id),/身份不能/);
  assert.throws(()=>s.hub.save('two',input),/已绑定/);
  assert.throws(()=>s.hub.save('one',{...input,provider:'xiaohongshu'}),/假连接/);
  assert.throws(()=>vault(join(s.directory,'key')).open(raw.secrets,'two:'+c.id),/无法解密/);
});
test('activation requires credentials and signed callback; credential changes pause receiving and AI',async t=>{
  const s=setup(t);let c=s.hub.save('default',s.input());assert.throws(()=>s.hub.save('default',{expectedRevision:c.revision,enabled:true},c.id),/先通过/);
  await s.hub.verify('default',c.id);assert.throws(()=>s.hub.save('default',{expectedRevision:c.revision,enabled:true},c.id),/先通过/);
  const other=await s.connect('wechat_official');c=s.hub.save('default',{expectedRevision:other.c.revision,secret:'different-platform-secret'},other.c.id);assert.equal(c.enabled,false);assert.equal(c.verifiedAt,0);assert.equal(c.autoReply,false);
});
test('encrypted callback rejects tampering, old timestamps, wrong receiver, plaintext and XML entities',async t=>{
  const s=setup(t),{c,s:secrets}=await s.connect();
  assert.equal((await s.callback(c,secrets,'hello',{get:true,tamper:true})).status,403);
  assert.equal((await s.callback(c,secrets,'hello',{get:true,timestamp:s.now()-601})).status,403);
  assert.equal((await s.callback(c,{...secrets,encodingAesKey:randomBytes(32).toString('base64').slice(0,-1)},'hello',{get:true})).status,403);
  const res=await s.callback(c,secrets,'<xml><ToUserName>anotherCorp</ToUserName></xml>');assert.equal(res.status,403);
  assert.throws(()=>parseXml('<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///etc/passwd">]><xml><Content>&x;</Content></xml>'),/无效/);
  assert.throws(()=>parseXml('<xml><MsgId>1</MsgId><MsgId>2</MsgId></xml>'),/重复/);
});
test('WeCom callback is durable, paginates empty pages, deduplicates and resumes cursor after restart',async t=>{
  const s=setup(t),{c,s:sec}=await s.connect();
  s.responses.push({errcode:0,msg_list:[],next_cursor:'page1',has_more:1},{errcode:0,msg_list:[customer(s)],next_cursor:'page2',has_more:0});
  const xml=`<xml><ToUserName>${c.appId}</ToUserName><Event>kf_msg_or_event</Event><OpenKfId>wk_test</OpenKfId><Token>sync-token-private</Token><CreateTime>${s.now()}</CreateTime></xml>`;
  assert.equal((await s.callback(c,sec,xml)).status,200);await s.hub.pump(c.id);
  let g=s.growthFor(),conv=g.all('conversation')[0];assert.equal(g.history(conv.id).length,1);assert.equal(s.hub.get(c.id).cursor,'page2');
  await s.callback(c,sec,xml);await s.hub.pump(c.id);assert.equal(g.history(conv.id).length,1);assert.equal(s.calls.filter(x=>x.path.endsWith('sync_msg')).length,2);
  const raw=s.db.prepare('SELECT payload FROM channel_events').get().payload;assert.ok(!raw.includes('sync-token-private'));
  s.restart();g=s.growthFor();assert.equal(g.history(conv.id).length,1);assert.equal(s.hub.get(c.id).cursor,'page2');
});
test('official account encrypted inbound is deduplicated and unsubscribe stops sending',async t=>{
  const s=setup(t),{c,s:sec}=await s.connect('wechat_official');
  const xml=`<xml><ToUserName>gh_test</ToUserName><FromUserName>user_oa</FromUserName><MsgType>text</MsgType><Content>咨询价格</Content><CreateTime>${s.now()}</CreateTime><MsgId>123456789123456789</MsgId></xml>`;
  await s.callback(c,sec,xml);await s.hub.pump(c.id);await s.callback(c,sec,xml);await s.hub.pump(c.id);
  const g=s.growthFor(),conv=g.all('conversation')[0];assert.equal(conv.channel,'wechat_official');assert.equal(g.history(conv.id).length,1);
  await g.send(conv,'你好','official-reply');assert.equal(s.sent[0].touser,'user_oa');assert.equal(s.sent[0].msgtype,'text');
  await s.callback(c,sec,`<xml><ToUserName>gh_test</ToUserName><FromUserName>user_oa</FromUserName><MsgType>event</MsgType><Event>unsubscribe</Event><CreateTime>${s.now()}</CreateTime></xml>`);await s.hub.pump(c.id);
  assert.equal(g.get('conversation',conv.id).optedOut,true);await assert.rejects(()=>g.send(g.get('conversation',conv.id),'再见','after-unsubscribe'),/停止联系/);
});
test('send quotas serialize concurrent requests, enforce time window, and new incoming renews quota',async t=>{
  const s=setup(t),{c}=await s.connect();s.hub.ingest(s.hub.get(c.id),customer(s));const g=s.growthFor(),conv=g.all('conversation')[0];
  const results=await Promise.allSettled(Array.from({length:8},(_,i)=>g.send(conv,'回复 '+i,'parallel-'+i)));assert.equal(results.filter(x=>x.status==='fulfilled').length,5);assert.equal(s.sent.length,5);
  assert.ok(g.history(conv.id).some(m=>m.delivery==='failed'));s.advance(1);s.hub.ingest(s.hub.get(c.id),customer(s,'m2'));await g.send(g.get('conversation',conv.id),'可以继续','new-window');assert.equal(s.sent.length,6);
  s.advance(48*3600+1);await assert.rejects(()=>g.send(g.get('conversation',conv.id),'过期','expired'),/窗口已过期/);assert.equal(s.sent.length,6);
});
test('ambiguous network failure is unknown in outbox and inbox; never auto resends',async t=>{
  const s=setup(t),{c}=await s.connect();s.hub.ingest(s.hub.get(c.id),customer(s));const g=s.growthFor(),conv=g.all('conversation')[0];s.setSendError(Error('network timeout'));
  await assert.rejects(()=>g.send(conv,'收到','ambiguous'),/结果未知/);assert.equal(g.history(conv.id).at(-1).delivery,'unknown');assert.equal(s.db.prepare('SELECT state FROM channel_outbox').get().state,'unknown');
  await assert.rejects(()=>g.send(conv,'收到','ambiguous'),/结果未知/);assert.equal(s.sent.length,1);s.restart();assert.equal(s.growthFor().history(conv.id).at(-1).delivery,'unknown');
  await assert.rejects(()=>s.growthFor().send(conv,'收到','new-id-unsafe-retry'),/结果未知/);assert.equal(s.sent.length,1);
});
test('failed receiving retries with backoff without advancing cursor or dropping source message',async t=>{
  const s=setup(t),{c,s:sec}=await s.connect();s.responses.push({errcode:45009});
  const xml=`<xml><ToUserName>${c.appId}</ToUserName><Event>kf_msg_or_event</Event><OpenKfId>wk_test</OpenKfId><Token>test-token</Token><CreateTime>${s.now()}</CreateTime></xml>`;
  await s.callback(c,sec,xml);await s.hub.pump(c.id);let ev=s.db.prepare('SELECT * FROM channel_events').get();assert.equal(ev.state,'retry');assert.equal(ev.attempts,1);assert.equal(s.hub.get(c.id).cursor,undefined);
  s.responses.push({errcode:0,msg_list:[customer(s)],next_cursor:'recovered',has_more:0});s.advance(11);await s.hub.pump(c.id);ev=s.db.prepare('SELECT * FROM channel_events').get();assert.equal(ev.state,'done');assert.equal(s.hub.get(c.id).cursor,'recovered');assert.equal(s.growthFor().all('conversation').length,1);
});
test('async failure receipt updates the original message; platform agent reply and recall halt AI',async t=>{
  const s=setup(t),{c}=await s.connect();s.hub.ingest(s.hub.get(c.id),customer(s));const g=s.growthFor(),conv=g.all('conversation')[0];
  await g.send(conv,'回复','receipt');const out=s.db.prepare('SELECT * FROM channel_outbox').get();
  s.hub.ingest(c,{msgid:'failure',msgtype:'event',event:{event_type:'msg_send_fail',external_userid:'user_one',open_kfid:'wk_test',fail_msgid:out.platformId,fail_type:10}});
  assert.equal(g.history(conv.id).at(-1).delivery,'failed');
  g.put('conversation',{...g.get('conversation',conv.id),status:'ai'},conv.id);
  s.hub.ingest(c,customer(s,'agent-message',{origin:5,text:{content:'我已接手'}}));assert.equal(g.get('conversation',conv.id).status,'human');assert.equal(g.get('conversation',conv.id).awaitingReply,false);
  s.hub.ingest(c,{msgid:'recall',msgtype:'event',event:{event_type:'user_recall_msg',external_userid:'user_one',open_kfid:'wk_test',recall_msgid:'m1'}});assert.match(g.history(conv.id)[0].content,/撤回/);
});
test('non-text input never enters blind AI reply; per-account customer identity never collides',async t=>{
  const s=setup(t),a=await s.connect(),b=await s.connect('wecom_kf','two',{appId:'ww_other'});s.hub.ingest(a.c,customer(s,'picture',{msgtype:'image'}));s.hub.ingest(b.c,customer(s));
  const one=s.growthFor().all('conversation')[0],two=s.growthFor('two').all('conversation')[0];assert.equal(one.status,'human');assert.match(one.handoffReason,/非文本/);assert.notEqual(one.id,two.id);assert.equal(s.hub.permitted('two',one),false);
});
test('account disabled while model runs cannot send stale AI response',async t=>{
  let enter,release;const entered=new Promise(r=>enter=r),result=new Promise(r=>release=r);
  const s=setup(t,{modelCall:async()=>{enter();return result}}),{c}=await s.connect(),g=s.growthFor();g.put('agent',{...g.get('agent','default'),enabled:true,channels:['wecom'],welcomeEnabled:false},'default');
  let active=s.hub.save('default',{expectedRevision:c.revision,autoReply:true},c.id);s.hub.ingest(active,customer(s));const conv=g.all('conversation')[0];
  const pending=g.autoReply(conv.id);await entered;s.hub.save('default',{expectedRevision:active.revision,enabled:false,autoReply:false},c.id);release({reply:'已完成生成的回复',handoff:false});assert.equal((await pending).skipped,true);assert.equal(s.sent.length,0);
});
test('pause during token refresh cancels outbound before any message request',async t=>{
  let paused=false,enter,release;const entered=new Promise(r=>enter=r),continueToken=new Promise(r=>release=r);
  const s=setup(t,{beforeFetch:async path=>{if(paused&&path.endsWith('gettoken')){enter();await continueToken}}}),{c}=await s.connect();s.hub.ingest(c,customer(s));const g=s.growthFor(),conv=g.all('conversation')[0];
  paused=true;const pending=g.send(conv,'不得发出的回复','pause-before-write');await entered;
  s.hub.save('default',{expectedRevision:c.revision,enabled:false},c.id);release();await assert.rejects(()=>pending,/已取消外发/);assert.equal(s.sent.length,0);assert.equal(s.db.prepare('SELECT state FROM channel_outbox').get().state,'failed');
});
test('unknown delivery reconciliation requires administrator, ownership, explicit confirmation and evidence',async t=>{
  const s=setup(t),{c}=await s.connect();s.hub.ingest(c,customer(s));const g=s.growthFor(),conv=g.all('conversation')[0];s.setSendError(Error('timeout'));await assert.rejects(()=>g.send(conv,'结果未知','reconcile-test'));
  const out=s.db.prepare('SELECT * FROM channel_outbox').get(),call=async(body,role='admin',workspaceId='default')=>{const res={};await s.hub.handle({access:{role,workspaceId,name:'测试管理员'},method:'POST',body},res,new URL('http://localhost/api/growth/channels/'+c.id+'/reconcile'));return res};
  const body={outboxId:out.id,result:'accepted',confirmed:true,note:'仅测试场景：已检查聊天记录'};
  assert.equal((await call(body,'operator')).status,403);assert.equal((await call(body,'admin','other')).status,404);assert.equal((await call({...body,confirmed:false})).status,400);assert.equal((await call({...body,note:''})).status,400);
  assert.equal((await call(body)).status,200);assert.equal(g.history(conv.id).at(-1).delivery,'sent');assert.equal(s.sent.length,1);assert.equal((await call(body)).status,409);
});
test('configuration routes block non-admin and scope activity records',async t=>{
  const s=setup(t),{c}=await s.connect();const call=async(access,path)=>{const res={};await s.hub.handle({access,method:'GET'},res,new URL('http://localhost/api/growth/channels'+path));return res};
  assert.equal((await call({role:'operator',workspaceId:'default'},'')).status,403);assert.equal((await call({role:'admin',workspaceId:'other'},'/'+c.id+'/activity')).status,404);
  const result=await call({role:'admin',workspaceId:'default'},'');assert.equal(result.status,200);assert.ok(!JSON.stringify(result).includes('test-secret'));assert.equal(result.data.list[0].enabled,true);
});
