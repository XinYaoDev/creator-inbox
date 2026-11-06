'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
const {mkdtempSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');

test('real HTTP web channel survives service restart and keeps visitor/team scopes separate',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'webchat-http-'));let child,base;
  const admin='webchat-admin-test-123456789012345',operator='webchat-operator-test-123456789012345';
  const env={...process.env,HOST:'127.0.0.1',PORT:'0',DB_PATH:join(directory,'web.db'),MEDIA_ROOT:join(directory,'media'),DISABLE_COLLECT:'1',GROWTH_DEMO:'1',AUTH_TOKEN:admin,GROWTH_TEAM_TOKENS:JSON.stringify([{token:operator,name:'接待员',role:'operator'}]),COOKIE_FILE:join(directory,'none'),DY_COOKIE_FILE:join(directory,'none')};
  for(const k of ['OPENAI_API_KEY','GROWTH_LLM_KEY','KIMI_API_KEY','NOTE_LLM_KEY','MOONSHOT_API_KEY','DEEPSEEK_API_KEY'])env[k]='';
  async function stop(){if(child&&child.exitCode===null){child.kill();await once(child,'exit')}}
  async function start(){child=spawn(process.execPath,[join(__dirname,'../index.js')],{env,stdio:['ignore','pipe','pipe']});base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('early exit'))});child.stdout.on('data',chunk=>{const m=String(chunk).match(/listening on :(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1])}})})}
  t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true})});await start();
  const team=(path,body,token=admin,method=body===undefined?'GET':'POST')=>fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const settings=await team('/api/growth/web-channel',{enabled:true},admin,'PATCH');assert.equal(settings.status,200);const site=await settings.json();
  assert.equal((await team('/api/growth/web-channel',undefined,operator)).status,403);
  const token=randomBytes(32).toString('hex');
  const visitor=(action,body,extra={})=>fetch(base+'/api/webchat/'+site.id+'/'+action,{method:body===undefined?'GET':'POST',headers:{'X-Webchat-Client':'1','Content-Type':'application/json',Authorization:'Bearer '+token,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await visitor('session',{token,name:'HTTP访客'})).status,201);
  assert.equal((await visitor('messages',{content:'真实 HTTP 进线',requestId:'http-incoming-one'})).status,201);
  const conversations=await (await team('/api/growth/conversations')).json(),c=conversations.list[0];assert.equal(c.sourceKind,'web');
  assert.equal((await team('/api/growth/conversations/'+c.id+'/reply',{content:'真实 HTTP 人工回复',requestId:'http-staff-reply'},operator)).status,200);
  await team('/api/growth/conversations/'+c.id+'/note',{content:'仅团队可见',requestId:'http-private-note'},operator);
  let messages=(await (await visitor('messages')).json()).messages;assert.equal(messages.length,2);assert.ok(!JSON.stringify(messages).includes('仅团队可见'));
  const page=await fetch(base+'/chat/'+site.id);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.match(page.headers.get('cache-control'),/no-store/);
  assert.equal((await visitor('messages',undefined,{Origin:'https://attacker.example'})).status,403);
  assert.equal((await team('/api/growth/state',undefined,token)).status,401);
  const notes=await (await team('/api/notes/status')).json();assert.equal(notes.modelSource,'workspace');assert.equal(notes.llm,false);
  await stop();await start();messages=(await (await visitor('messages')).json()).messages;assert.equal(messages.length,2);assert.equal(messages[1].content,'真实 HTTP 人工回复');
  await visitor('ack',{sequence:messages[1].sequence});const detail=await (await team('/api/growth/conversations/'+c.id)).json();assert.equal(detail.messages[1].delivery,'delivered');
  await team('/api/growth/web-channel',{enabled:false},admin,'PATCH');assert.equal((await visitor('messages')).status,404);
});
