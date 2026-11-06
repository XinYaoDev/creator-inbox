'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {mkdtempSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite'),{randomBytes,createCipheriv}=require('node:crypto');
const {signature}=require('../channel-crypto.js');
test('real desktop HTTP keeps callback listener separate, persists config, validates encrypted ingress and admin boundaries',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'channel-http-')),admin='channel-test-admin-123456789012345',secret=randomBytes(32).toString('hex');let child,base,cookie='';
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,HOST:'127.0.0.1',PORT:'0',DB_PATH:join(dir,'test.db'),MEDIA_ROOT:join(dir,'media'),DISABLE_COLLECT:'1',GROWTH_DEMO:'0',AUTH_TOKEN:admin,GROWTH_TEAM_TOKENS:'',LAIKE_DESKTOP_SECRET:secret,CHANNEL_CALLBACK_PORT:'0',COOKIE_FILE:join(dir,'none'),DY_COOKIE_FILE:join(dir,'none')};
  for(const k of ['OPENAI_API_KEY','GROWTH_LLM_KEY','KIMI_API_KEY','NOTE_LLM_KEY','MOONSHOT_API_KEY','DEEPSEEK_API_KEY'])env[k]='';
  async function stop(){if(child?.exitCode===null){child.kill();await once(child,'exit');}}
  async function start(){child=spawn(process.execPath,[join(__dirname,'../index.js')],{env,stdio:['ignore','pipe','pipe']});base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.on('exit',()=>{clearTimeout(timer);reject(Error('early exit'))});child.stdout.on('data',chunk=>{const m=String(chunk).match(/listening on :(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}})});const r=await fetch(base+'/_desktop/connect?ticket='+secret);cookie=r.headers.get('set-cookie').split(';')[0];}
  const call=(path,body,method=body===undefined?'GET':'POST')=>fetch(base+path,{method,headers:{Authorization:'Bearer '+admin,Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true})});await start();
  assert.equal((await fetch(base+'/api/growth/channels')).status,401);
  let r=await call('/api/growth/channels/runtime',{enabled:true,port},'PATCH');assert.equal(r.status,200);assert.equal((await r.json()).listening,true);
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/growth/state')).status,404);assert.equal((await fetch('http://127.0.0.1:'+port+'/')).status,404);
  const aes=randomBytes(32).toString('base64').slice(0,-1),token='testHTTPCallback123';
  r=await call('/api/growth/channels',{provider:'wechat_official',name:'HTTP 隔离账号',appId:'wx_http',originalId:'gh_http',secret:'http-test-secret-12345',callbackToken:token,encodingAesKey:aes});assert.equal(r.status,201);const c=await r.json();
  assert.ok(!JSON.stringify(c).includes(aes));await stop();
  // Fixture represents a previously verified account. This is protocol/service
  // acceptance, NOT an assertion of a successful real WeChat authorization.
  const db=new DatabaseSync(join(dir,'test.db')),row=db.prepare('SELECT data FROM channel_connections WHERE id=?').get(c.id);db.prepare('UPDATE channel_connections SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),verifiedAt:Math.floor(Date.now()/1000),callbackVerifiedAt:Math.floor(Date.now()/1000),enabled:true}),c.id);db.close();
  await start();for(let i=0;i<20;i++){try{await fetch('http://127.0.0.1:'+port+'/');break}catch{await new Promise(r=>setTimeout(r,50))}}
  const timestamp=String(Math.floor(Date.now()/1000)),xml=`<xml><ToUserName>gh_http</ToUserName><FromUserName>testVisitor</FromUserName><CreateTime>${timestamp}</CreateTime><MsgType>text</MsgType><Content><![CDATA[真实 HTTP 加密进线，中文不乱码]]></Content><MsgId>123456789987654321</MsgId></xml>`;
  const key=Buffer.from(aes+'=','base64'),len=Buffer.alloc(4);len.writeUInt32BE(Buffer.byteLength(xml));const plain=Buffer.concat([randomBytes(16),len,Buffer.from(xml),Buffer.from('wx_http')]),pad=32-plain.length%32,cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);const encrypted=Buffer.concat([cipher.update(Buffer.concat([plain,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');
  const path='/api/channel-callback/'+c.id+'?timestamp='+timestamp+'&nonce=http&msg_signature='+signature(token,timestamp,'http',encrypted),body='<xml><Encrypt>'+encrypted+'</Encrypt></xml>';
  const incoming=()=>fetch('http://127.0.0.1:'+port+path,{method:'POST',body,headers:{'Content-Type':'application/xml'}});
  assert.equal((await incoming()).status,200);assert.equal((await incoming()).status,200);
  const rows=await (await call('/api/growth/conversations')).json();assert.equal(rows.list.length,1);
  const detail=await (await call('/api/growth/conversations/'+rows.list[0].id)).json();assert.equal(detail.messages.length,1);assert.match(detail.messages[0].content,/中文不乱码/);
  assert.equal((await fetch('http://127.0.0.1:'+port+path.replace('msg_signature=','msg_signature=bad'),{method:'POST',body})).status,403);
  assert.equal((await call('/api/growth/channels/runtime',{enabled:false,port},'PATCH')).status,200);
  await stop();await start();const status=await (await call('/api/growth/channels')).json();assert.equal(status.callbackListener.enabled,false);assert.equal(status.list.length,1);
});
