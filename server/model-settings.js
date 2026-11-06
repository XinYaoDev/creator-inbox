'use strict';
const fs=require('node:fs');
const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {usesReasoningEffort}=require('./llm.js');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const officialBase='https://api.openai.com/v1';

function createModelSettings({db,keyPath,env=process.env,fetcher=fetch,hermes}) {
  db.exec('CREATE TABLE IF NOT EXISTS team_model_settings(workspaceId TEXT PRIMARY KEY,data TEXT NOT NULL,updated INTEGER NOT NULL)');
  let encryptionKey;
  function masterKey(create=false) {
    if(encryptionKey)return encryptionKey;
    if(!fs.existsSync(keyPath)) {
      if(!create)fail('模型密钥加密文件缺失，请从备份恢复，或重新保存 API 密钥',503);
      try {fs.writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    }
    const stat=fs.lstatSync(keyPath);if(!stat.isFile()||stat.isSymbolicLink())fail('模型密钥加密文件无效',503);
    const key=fs.readFileSync(keyPath);if(key.length!==32)fail('模型密钥加密文件损坏',503);
    try{fs.chmodSync(keyPath,0o600);}catch{/* Windows ACLs are managed by the host. */}
    encryptionKey=key;return key;
  }
  function encrypt(value,workspaceId){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',masterKey(true),iv);cipher.setAAD(Buffer.from(workspaceId));const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),value:encrypted.toString('base64')};}
  function decrypt(data,workspaceId){try{const decipher=createDecipheriv('aes-256-gcm',masterKey(),Buffer.from(data.iv,'base64'));decipher.setAAD(Buffer.from(workspaceId));decipher.setAuthTag(Buffer.from(data.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(data.value,'base64')),decipher.final()]).toString('utf8');}catch{fail('无法解密模型密钥，请检查加密文件备份或重新保存密钥',503);}}
  const saved=id=>{const r=db.prepare('SELECT * FROM team_model_settings WHERE workspaceId=?').get(id);return r?{...JSON.parse(r.data),updated:r.updated}:null;};
  function defaults(id){return {key:id==='default'?(env.GROWTH_LLM_KEY||env.OPENAI_API_KEY||''):'',base:id==='default'?(env.GROWTH_LLM_BASE_URL||env.OPENAI_BASE_URL||officialBase).replace(/\/$/,''):officialBase,model:id==='default'?(env.GROWTH_LLM_MODEL||'gpt-6-astra'):'gpt-6-astra',embeddingModel:env.GROWTH_EMBEDDING_MODEL||'text-embedding-3-small',embeddingsEnabled:env.GROWTH_EMBEDDINGS_ENABLED==='1'};}
  function resolve(id='default'){
    const fallback=defaults(id),s=saved(id);if(!s)return fallback;
    const embeddingProvider=s.embeddingProvider||(s.embeddingsEnabled?'api':'disabled');
    if(s.provider==='hermes-codex'){
      if(id!=='default'||!hermes?.available())fail('本机 Hermes 连接不可用；仅默认空间可使用服务器已启用的本机登录',503);
      return {...fallback,provider:'hermes-codex',base:'https://chatgpt.com/backend-api/codex',model:s.model,key:'',embeddingProvider:embeddingProvider==='local'?'local':'disabled',embeddingsEnabled:embeddingProvider==='local',embeddingMinScore:s.embeddingMinScore,complete:hermes.complete};
    }
    return {...fallback,base:s.base,model:s.model,embeddingModel:s.embeddingModel,embeddingProvider,embeddingsEnabled:embeddingProvider!=='disabled',embeddingMinScore:s.embeddingMinScore,key:s.keyMode==='custom'?decrypt(s.encryptedKey,id):s.keyMode==='none'?'':fallback.key};
  }
  function publicSettings(id){
    const s=saved(id),fallback=defaults(id);let key='',keyError='';try{key=resolve(id).key;}catch(e){keyError=e.message;}
    const provider=s?.provider||'api',hermesAvailable=id==='default'&&!!hermes?.available();
    const embeddingProvider=s?.embeddingProvider||((s?.embeddingsEnabled??fallback.embeddingsEnabled)&&provider!=='hermes-codex'?'api':'disabled');
    return {provider,hermesAvailable,connectionConfigured:provider==='hermes-codex'?hermesAvailable&&!keyError:!!key,base:s?.base||fallback.base,model:s?.model||fallback.model,embeddingModel:s?.embeddingModel||fallback.embeddingModel,embeddingProvider,embeddingMinScore:s?.embeddingMinScore??(embeddingProvider==='local'?0.4:0.3),embeddingsEnabled:embeddingProvider!=='disabled',keyConfigured:!!key,keyHint:key?'••••'+(key.length>=8?key.slice(-4):''):'',keySource:s?.keyMode==='custom'?'encrypted':s?.keyMode==='none'?'none':fallback.key?'environment':'none',keyError,updated:s?.updated||0};
  }
  function save(id,b){
    const old=saved(id),fallback=defaults(id);
    const provider=b.provider??old?.provider??'api';
    if(!['api','hermes-codex'].includes(provider))fail('不支持的模型连接方式');
    if(provider==='hermes-codex'&&(id!=='default'||!hermes?.available()))fail('只有默认空间可以使用服务器已启用的本机 Hermes 连接',403);
    if(provider==='hermes-codex'&&b.key)fail('Hermes 模式不接收 API 密钥');
    const base=String(b.base??old?.base??fallback.base).trim().replace(/\/+$/,'');let url;
    try{url=new URL(base);}catch{fail('接口地址不是有效 URL');}
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&local))||url.username||url.password||url.search||url.hash)fail('接口地址需使用 HTTPS；仅本机调试可使用 HTTP，且不能包含账号、查询参数或片段');
    // Workspace administrators cannot turn a model endpoint into an arbitrary network proxy.
    // Server operators can explicitly permit their trusted gateways via environment configuration.
    const allowed=new Set(['api.openai.com',...String(env.GROWTH_LLM_ALLOWED_HOSTS||'').split(',').map(s=>s.trim()).filter(Boolean)]);
    const envHost=id==='default'?(()=>{try{return new URL(fallback.base).hostname;}catch{return '';}})():'';
    if(!allowed.has(url.hostname)&&url.hostname!==envHost)fail('该接口主机未获服务器许可。请配置 GROWTH_LLM_ALLOWED_HOSTS 后再保存');
    const model=String(b.model??old?.model??fallback.model).trim(),embeddingModel=String(b.embeddingModel??old?.embeddingModel??fallback.embeddingModel).trim();
    if(![model,embeddingModel].every(m=>/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(m)))fail('请填写有效的模型名称');
    const data={provider,base,model,embeddingModel,embeddingsEnabled:provider==='hermes-codex'?false:b.embeddingsEnabled===undefined?old?.embeddingsEnabled??fallback.embeddingsEnabled:b.embeddingsEnabled===true,keyMode:old?.keyMode||'inherit',encryptedKey:old?.encryptedKey};
    data.embeddingProvider=b.embeddingProvider??(b.embeddingsEnabled!==undefined?(data.embeddingsEnabled?'api':'disabled'):old?.embeddingProvider||(data.embeddingsEnabled?'api':'disabled'));
    if(!['disabled','local','api'].includes(data.embeddingProvider))fail('无效的知识检索方式');
    if(provider==='hermes-codex'&&data.embeddingProvider==='api')fail('Hermes 不提供向量 API，请选择本地中文向量检索');
    data.embeddingsEnabled=data.embeddingProvider!=='disabled';
    data.embeddingMinScore=b.embeddingMinScore===undefined?(old?.embeddingProvider===data.embeddingProvider?old?.embeddingMinScore:undefined)??(data.embeddingProvider==='local'?0.4:0.3):Number(b.embeddingMinScore);
    if(!Number.isFinite(data.embeddingMinScore)||data.embeddingMinScore<0.3||data.embeddingMinScore>0.95)fail('向量相似度门槛必须在 0.30–0.95 之间');
    if(b.clearKey===true){data.keyMode='none';delete data.encryptedKey;}
    if(b.useEnvironment===true){if(id!=='default')fail('只有默认空间可以使用服务器环境密钥');data.keyMode='inherit';delete data.encryptedKey;}
    if(b.key!==undefined&&b.key!==''){
      if(typeof b.key!=='string'||b.key.trim().length<12||b.key.length>4096||/\s/.test(b.key.trim()))fail('API 密钥格式无效');
      data.keyMode='custom';data.encryptedKey=encrypt(b.key.trim(),id);
    }
    db.prepare('INSERT INTO team_model_settings VALUES(?,?,?) ON CONFLICT(workspaceId) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(id,JSON.stringify(data),Math.floor(Date.now()/1000));
    return publicSettings(id);
  }
  async function test(id){
    const c=resolve(id);if(!c.key&&!c.complete)fail('请先保存模型连接设置');
    const body={model:c.model,messages:[{role:'user',content:'Reply with OK.'}],max_completion_tokens:256};
    if(usesReasoningEffort(c.model))body.reasoning_effort='low';
    const start=Date.now();let response;
    if(c.complete){const result=await c.complete(body);return {ok:true,model:c.model,latencyMs:Date.now()-start,usage:{totalTokens:result.usage?.total_tokens||null},message:'已通过本机 Hermes → Codex 收到完整的真实模型响应'};}
    try{response=await fetcher(c.base+'/chat/completions',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});}catch{fail('连接失败或超时，请检查服务地址与网络',502);}
    if(!response.ok){const reasons={401:'密钥无效或已失效',403:'账户没有访问权限',404:'模型或接口路径不存在',429:'额度不足或请求过于频繁'};fail('连接测试失败：'+(reasons[response.status]||'服务端返回 HTTP '+response.status),502);}
    let data;try{data=await response.json();}catch{fail('服务未返回有效的 JSON 响应',502);}
    if(typeof data.choices?.[0]?.message?.content!=='string'||!data.choices[0].message.content.trim())fail('接口已响应，但没有返回文本；请核对模型与 Chat Completions 支持情况',502);
    return {ok:true,model:c.model,latencyMs:Date.now()-start,usage:{totalTokens:Number(data.usage?.total_tokens)||null},message:'已收到模型真实文本响应'};
  }
  async function hermesStatus(id){if(id!=='default'||!hermes?.available())fail('此空间不可使用本机 Hermes 连接',403);return hermes.status();}
  return {resolve,publicSettings,save,test,hermesStatus};
}
module.exports={createModelSettings};
