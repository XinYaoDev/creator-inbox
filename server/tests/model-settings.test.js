'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,readFileSync,statSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createModelSettings}=require('../model-settings.js');
const {createGrowth}=require('../growth.js');
function setup(t,options={}){
  const db=new DatabaseSync(':memory:'),directory=mkdtempSync(join(tmpdir(),'model-settings-test-')),keyPath=join(directory,'master');
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  return {db,keyPath,settings:createModelSettings({db,keyPath,env:{},...options})};
}
const testKey='sk-local-fake-key-for-tests-1234';
test('local embeddings are independent of Hermes credentials, per-workspace and validated',t=>{
  const {settings}=setup(t,{hermes:{available:()=>true,complete:async()=>{}}});
  const saved=settings.save('default',{provider:'hermes-codex',embeddingProvider:'local',embeddingMinScore:.6});
  assert.equal(saved.embeddingsEnabled,true);assert.equal(saved.embeddingProvider,'local');assert.equal(settings.resolve().embeddingMinScore,.6);assert.equal(settings.resolve().key,'');
  assert.equal(settings.publicSettings('other').embeddingProvider,'disabled');
  assert.throws(()=>settings.save('default',{embeddingProvider:'api'}),/Hermes/);
  assert.throws(()=>settings.save('default',{embeddingMinScore:NaN}),/门槛/);
  assert.throws(()=>settings.save('default',{embeddingMinScore:.1}),/门槛/);
  assert.throws(()=>settings.save('default',{embeddingProvider:'arbitrary-command'}),/无效/);
});
test('Hermes provider: explicit opt-in, default-workspace only, no token persistence and no API fallback',async t=>{
  let calls=0;
  const hermes={available:()=>true,status:async()=>({available:true,model:'gpt-local'}),complete:async payload=>{calls++;assert.equal(payload.model,'gpt-local');return {choices:[{message:{content:'OK'}}],usage:{total_tokens:15}}}};
  const {db,settings}=setup(t,{hermes,fetcher:()=>{throw Error('must not call API endpoint')}});
  assert.throws(()=>settings.save('other',{provider:'hermes-codex'}),/默认空间/);
  assert.throws(()=>settings.save('default',{provider:'hermes-codex',key:testKey}),/不接收/);
  const configured=settings.save('default',{provider:'hermes-codex',model:'gpt-local',embeddingsEnabled:true});
  assert.equal(configured.connectionConfigured,true);assert.equal(configured.keyConfigured,false);assert.equal(configured.embeddingsEnabled,false);
  assert.equal(settings.resolve('default').key,'');assert.equal(settings.resolve('other').complete,undefined);
  assert.equal((await settings.test('default')).usage.totalTokens,15);assert.equal(calls,1);
  assert.equal((await settings.hermesStatus('default')).model,'gpt-local');await assert.rejects(()=>settings.hermesStatus('other'));
  assert.ok(!db.prepare('SELECT data FROM team_model_settings').get().data.includes('api_key'));
  settings.save('default',{provider:'api'});assert.equal(settings.resolve('default').complete,undefined);assert.equal(settings.publicSettings('default').connectionConfigured,false);
  const disabled=setup(t).settings;assert.throws(()=>disabled.save('default',{provider:'hermes-codex'}),/启用/);
});
test('Hermes detection route remains admin-only',async t=>{
  const {db,settings}=setup(t,{hermes:{available:()=>true,status:async()=>({ok:true,available:true,model:'gpt-local'})}});
  const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,modelSettings:settings});
  for(const role of ['viewer','operator','admin']){const r={};await app.handle({method:'GET',access:{role,name:role}},r,new URL('http://localhost/api/growth/model/hermes'));assert.equal(r.status,role==='admin'?200:403);}
});
test('model settings: encrypted at rest, redacted reads, preserved blank key, restart decrypts',t=>{
  const {db,keyPath,settings}=setup(t);
  const saved=settings.save('a',{key:testKey,model:'gpt-6-astra'});
  assert.equal(saved.keyHint,'••••1234');assert.equal(saved.key,undefined);assert.equal(saved.encryptedKey,undefined);
  assert.ok(!db.prepare('SELECT data FROM team_model_settings').get().data.includes(testKey));
  assert.equal(readFileSync(keyPath).length,32);assert.equal(statSync(keyPath).mode&0o777,0o600);
  assert.equal(settings.resolve('a').key,testKey);
  settings.save('a',{model:'gpt-configurable-model',key:''});assert.equal(settings.resolve('a').key,testKey);
  const restarted=createModelSettings({db,keyPath,env:{}});assert.equal(restarted.resolve('a').key,testKey);assert.equal(restarted.resolve('a').model,'gpt-configurable-model');
  const a=db.prepare('SELECT data FROM team_model_settings WHERE workspaceId=?').get('a').data;
  db.prepare('INSERT INTO team_model_settings VALUES(?,?,?)').run('b',a,1);
  assert.throws(()=>restarted.resolve('b'),/无法解密/);assert.match(restarted.publicSettings('b').keyError,/无法解密/);
});
test('workspace model settings: no cross-tenant environment key; clear overrides env fallback',t=>{
  const {settings}=setup(t,{env:{OPENAI_API_KEY:'environment-fake-key-5678',GROWTH_LLM_MODEL:'gpt-env'}});
  assert.equal(settings.resolve('default').key,'environment-fake-key-5678');assert.equal(settings.resolve('other').key,'');
  settings.save('default',{clearKey:true});assert.equal(settings.resolve('default').key,'');
  settings.save('default',{key:testKey});assert.equal(settings.resolve('default').key,testKey);
  settings.save('default',{useEnvironment:true});assert.equal(settings.resolve('default').key,'environment-fake-key-5678');
  assert.throws(()=>settings.save('other',{useEnvironment:true}),/默认空间/);
  settings.save('other',{key:testKey,embeddingsEnabled:true,embeddingModel:'text-embedding-3-large'});
  assert.equal(settings.resolve('other').embeddingsEnabled,true);assert.equal(settings.resolve('default').embeddingsEnabled,false);
});
test('model endpoint validation denies unsafe protocols, credentials, arbitrary gateways and invalid models',t=>{
  const {settings}=setup(t);
  for(const base of ['file:///etc/passwd','http://api.openai.com/v1','https://user:pass@api.openai.com/v1','https://api.openai.com/v1?token=x','https://api.openai.com/v1#x','https://internal.example/v1'])assert.throws(()=>settings.save('a',{base}));
  assert.throws(()=>settings.save('a',{model:'invalid model'}));assert.throws(()=>settings.save('a',{key:'short'}));
  const {settings:gateway}=setup(t,{env:{GROWTH_LLM_ALLOWED_HOSTS:'127.0.0.1,model.example'}});
  assert.equal(gateway.save('a',{base:'http://127.0.0.1:4000/v1'}).base,'http://127.0.0.1:4000/v1');
  assert.equal(gateway.save('a',{base:'https://model.example/v1/'}).base,'https://model.example/v1');
});
test('connection test uses saved workspace credentials and returns only safe metadata',async t=>{
  let captured;
  const {settings}=setup(t,{fetcher:async(url,init)=>{captured={url,init};return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}],usage:{total_tokens:12}})};}});
  settings.save('a',{key:testKey});const result=await settings.test('a');
  assert.equal(captured.url,'https://api.openai.com/v1/chat/completions');assert.equal(captured.init.headers.Authorization,'Bearer '+testKey);
  assert.equal(result.ok,true);assert.equal(result.usage.totalTokens,12);assert.ok(!JSON.stringify(result).includes(testKey));
  assert.equal(JSON.parse(captured.init.body).messages[0].content,'Reply with OK.');
});
test('connection errors never echo upstream credential messages or report false success',async t=>{
  const {settings}=setup(t,{fetcher:async()=>({ok:false,status:401,json:async()=>({error:{message:testKey}})})});settings.save('a',{key:testKey});
  await assert.rejects(()=>settings.test('a'),e=>!e.message.includes(testKey)&&/密钥无效/.test(e.message));
  const {settings:empty}=setup(t,{fetcher:async()=>({ok:true,json:async()=>({choices:[]})})});empty.save('a',{key:testKey});await assert.rejects(()=>empty.test('a'),/没有返回文本/);
});
test('growth settings route is admin-only, saves without restart and changes actual model configuration',async t=>{
  const {db,settings}=setup(t);const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,modelConfig:()=>settings.resolve('default'),modelSettings:settings});
  const call=async(role,method,path,body)=>{const r={};await app.handle({method,body,access:{role,name:role}},r,new URL('http://localhost/api/growth'+path));return r;};
  assert.equal((await call('viewer','GET','/model')).status,403);assert.equal((await call('operator','PATCH','/model',{key:testKey})).status,403);
  assert.equal((await call('admin','PATCH','/model',{key:testKey,model:'gpt-saved'})).status,200);
  assert.equal(app.stats().model,'gpt-saved');assert.equal(app.stats().modelConfigured,true);
  assert.equal((await call('admin','GET','/model')).data.key,undefined);
  await call('admin','PATCH','/model',{clearKey:true});assert.equal(app.stats().modelConfigured,false);
});
