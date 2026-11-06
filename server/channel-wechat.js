'use strict';
const {fail}=require('./channel-crypto.js');
const HOSTS={wecom_kf:'https://qyapi.weixin.qq.com',wechat_official:'https://api.weixin.qq.com'};
function apiError(code){
  const labels={40001:'凭据失效，请重新验证',40013:'企业 ID 或 AppID 不正确',40014:'访问凭据无效',42001:'访问凭据已过期',40125:'Secret 不正确',40164:'请在平台后台配置服务器 IP 白名单',48002:'接口未获授权',45009:'平台调用频率或额度已达上限',45015:'顾客回复窗口已过期',45047:'回复条数已达到平台限制',60020:'请检查企业可信 IP'};
  return Object.assign(new Error(labels[code]||'平台拒绝请求，请按错误码检查平台权限和会话状态（'+code+'）'),{status:502,platformCode:code,retryable:[-1,45009].includes(code),authExpired:[40001,40014,42001].includes(code)});
}
function createWechatApi({fetcher=fetch,clock=()=>Math.floor(Date.now()/1000)}={}){
  const cache=new Map(),refreshes=new Map();
  async function request(c,path,body,write=false){
    let r;
    try{r=await fetcher(HOSTS[c.provider]+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Object.assign(new Error(write?'发送结果未知，请在原平台核实，禁止自动重发':'平台连接失败，请检查网络后重试'),{status:502,deliveryUnknown:write});}
    if(!r.ok)throw Object.assign(new Error('平台返回 HTTP '+r.status),{status:502,deliveryUnknown:write});
    let data;
    try{const chunks=[];let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>4*1024*1024)throw Error();chunks.push(chunk);}data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('平台响应无效'),{status:502,deliveryUnknown:write});}
    if(Number(data.errcode))throw apiError(Number(data.errcode));
    if(data.errcode===undefined&&!data.access_token)throw Object.assign(new Error('平台未返回可确认的结果'),{status:502,deliveryUnknown:write});
    return data;
  }
  async function token(c,s,force=false){
    const key=c.id+':'+c.revision;
    if(!force&&cache.get(key)?.expires>clock()+120)return cache.get(key).value;
    if(refreshes.has(key))return refreshes.get(key);
    const task=(async()=>{
      const path=c.provider==='wecom_kf'?'/cgi-bin/gettoken?corpid='+encodeURIComponent(c.appId)+'&corpsecret='+encodeURIComponent(s.secret):'/cgi-bin/stable_token';
      const data=await request(c,path,c.provider==='wecom_kf'?undefined:{grant_type:'client_credential',appid:c.appId,secret:s.secret,force_refresh:force});
      if(!data.access_token||!Number(data.expires_in))fail('平台未返回有效访问凭据',502);
      if(cache.size>500)cache.clear();cache.set(key,{value:data.access_token,expires:clock()+Math.min(7200,Number(data.expires_in))});return data.access_token;
    })();refreshes.set(key,task);try{return await task;}finally{refreshes.delete(key);}
  }
  async function call(c,s,path,body,write=false,guard){
    for(let attempt=0;attempt<2;attempt++){
      const key=await token(c,s,attempt===1);
      // A token refresh can take seconds. Pause/opt-out/handoff must still win
      // immediately before every external write, including auth-refresh retry.
      guard?.();
      try{return await request(c,path+'?access_token='+encodeURIComponent(key),body,write);}catch(e){if(e.authExpired&&attempt===0)continue;throw e;}
    }
  }
  async function verify(c,s){
    await token(c,s,true);
    if(c.provider==='wechat_official'){
      await call(c,s,'/cgi-bin/customservice/getkflist');
      return {message:'公众号凭据和客服查询权限已验证；收发权限需真实消息验收',accounts:[]};
    }
    const accounts=[];
    for(let offset=0;offset<10000;offset+=100){const r=await call(c,s,'/cgi-bin/kf/account/list',{offset,limit:100});if(!Array.isArray(r.account_list))fail('客服账号列表格式无效',502);accounts.push(...r.account_list.map(a=>({id:a.open_kfid,name:a.name,manageable:a.manage_privilege===true})));if(r.account_list.length<100)break;}
    return {message:'已读取微信客服账号，请选择拥有管理权限的账号',accounts};
  }
  const sync=(c,s,cursor,callbackToken)=>call(c,s,'/cgi-bin/kf/sync_msg',{open_kfid:c.kfId,limit:1000,cursor:cursor||undefined,token:callbackToken||undefined});
  const send=(c,s,userId,text,msgId,role,guard)=>call(c,s,c.provider==='wecom_kf'?'/cgi-bin/kf/send_msg':'/cgi-bin/message/custom/send',{
    touser:userId,msgtype:'text',text:{content:text},...(c.provider==='wecom_kf'?{open_kfid:c.kfId,msgid:msgId}:role==='ai'?{aimsgcontext:{is_ai_msg:1}}:{})
  },true,guard);
  return {verify,sync,send};
}
module.exports={createWechatApi};
