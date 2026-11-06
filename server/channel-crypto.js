'use strict';
const fs=require('node:fs');
const {randomBytes,createCipheriv,createDecipheriv,createHash,timingSafeEqual}=require('node:crypto');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const signature=(...parts)=>createHash('sha1').update(parts.sort().join('')).digest('hex');
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function vault(keyPath){
  let key;
  function load(create){
    if(key)return key;
    if(create&&!fs.existsSync(keyPath)){try{fs.writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
    if(!fs.existsSync(keyPath)||fs.lstatSync(keyPath).isSymbolicLink())fail('渠道加密密钥缺失，请恢复完整备份',503);
    key=fs.readFileSync(keyPath);if(key.length!==32){key=null;fail('渠道加密密钥损坏',503);}return key;
  }
  return {
    seal(value,scope){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',load(true),iv);c.setAAD(Buffer.from('channels:'+scope));const bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:bytes.toString('base64')});},
    open(value,scope){try{const b=JSON.parse(value),c=createDecipheriv('aes-256-gcm',load(false),Buffer.from(b.iv,'base64'));c.setAAD(Buffer.from('channels:'+scope));c.setAuthTag(Buffer.from(b.tag,'base64'));return JSON.parse(Buffer.concat([c.update(Buffer.from(b.data,'base64')),c.final()]).toString());}catch{fail('无法解密渠道凭据或消息，请恢复本机密钥备份',503);}}
  };
}
function parseXml(body){
  if(typeof body!=='string'||Buffer.byteLength(body)>1024*1024||/<!DOCTYPE|<!ENTITY/i.test(body))fail('无效回调 XML');
  let doc,window;
  try{window=new (require('jsdom').JSDOM)(body,{contentType:'text/xml'}).window;doc=window.document;}catch{fail('无效回调 XML');}
  try{
    if(doc.documentElement.tagName!=='xml')fail('回调缺少 xml 根节点');
    const result=Object.create(null);
    for(const e of doc.documentElement.children){if(e.children.length||Object.hasOwn(result,e.tagName))fail('回调字段重复或格式不受支持');result[e.tagName]=e.textContent;}
    return result;
  }finally{window.close();}
}
function decryptWechat(encrypted,aesKey,receiver){
  try{
    if(!/^[A-Za-z0-9+/]{43}$/.test(aesKey)||!/^[A-Za-z0-9+/]+=*$/.test(encrypted))throw Error();
    const key=Buffer.from(aesKey+'=','base64'),cipher=createDecipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
    const bytes=Buffer.concat([cipher.update(Buffer.from(encrypted,'base64')),cipher.final()]);
    const pad=bytes.at(-1);if(!pad||pad>32||bytes.length<pad+20||!bytes.subarray(-pad).every(v=>v===pad))throw Error();
    const plain=bytes.subarray(0,-pad),len=plain.readUInt32BE(16);
    if(len>plain.length-20||!equal(plain.subarray(20+len).toString(),receiver))throw Error();
    return plain.subarray(20,20+len).toString('utf8');
  }catch{fail('回调加密校验失败',403);}
}
function verifyWechat(query,secrets,receiver,encrypted,now){
  const timestamp=query.get('timestamp')||'',nonce=query.get('nonce')||'';
  if(!/^\d{1,12}$/.test(timestamp)||Math.abs(now-Number(timestamp))>600||!nonce||nonce.length>256)fail('回调时间或随机串无效',403);
  const expected=signature(secrets.callbackToken,timestamp,nonce,...(encrypted?[encrypted]:[]));
  if(!equal(query.get(encrypted?'msg_signature':'signature')||'',expected))fail('回调签名不匹配',403);
  return encrypted?decryptWechat(encrypted,secrets.encodingAesKey,receiver):null;
}
module.exports={vault,digest,signature,parseXml,verifyWechat,fail};
