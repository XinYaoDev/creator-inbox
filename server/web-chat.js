'use strict';
const {randomBytes,createHash}=require('node:crypto');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const text=(v,n)=>String(v??'').trim().slice(0,n);

// Public visitor access is deliberately separate from team authentication. A site ID
// is public; a random, hashed, expiring visitor token grants access to ONE conversation.
function createWebChat({db,growthFor,sendJson,readBody,clock=()=>Math.floor(Date.now()/1000)}) {
  db.exec(`CREATE TABLE IF NOT EXISTS web_sites(id TEXT PRIMARY KEY,workspaceId TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_visitors(tokenHash TEXT PRIMARY KEY,siteId TEXT NOT NULL,conversationId TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS web_visitors_site ON web_visitors(siteId);
    CREATE TABLE IF NOT EXISTS web_daily(siteId TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(siteId,day));`);
  const buckets=new Map(),jobs=new Map();
  const parse=row=>row?{id:row.id,workspaceId:row.workspaceId,...JSON.parse(row.data)}:null;
  const siteById=id=>parse(db.prepare('SELECT * FROM web_sites WHERE id=?').get(id));
  const settings=workspaceId=>parse(db.prepare('SELECT * FROM web_sites WHERE workspaceId=?').get(workspaceId))||{id:'',workspaceId,title:'在线咨询',intro:'你好，请告诉我们你想了解的问题。',enabled:false,autoReply:false,workflowReply:false,agentId:'default',origins:[],dailyLimit:200};
  function save(workspaceId,b) {
    const old=settings(workspaceId),v={...old,...b};
    const origins=[...new Set((Array.isArray(v.origins)?v.origins:[]).map(raw=>{
      let u;try{u=new URL(raw);}catch{fail('嵌入网站地址无效');}
      const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
      if((u.protocol!=='https:'&&!(u.protocol==='http:'&&local))||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('填写网站源地址，如 https://example.com，不带路径；HTTP 仅允许本机');
      return u.origin;
    }))];
    if(origins.length>10)fail('最多允许 10 个嵌入网站');
    const agent=growthFor(workspaceId).get('agent',v.agentId);
    if(!agent)fail('接待员工不存在');
    if(v.enabled&&v.autoReply&&(!agent.enabled||!agent.channels.includes('web')))fail('请先启用所选 AI 员工，并勾选网页咨询渠道');
    if(v.autoReply&&v.workflowReply)fail('AI 接待与工作流接待请选择一种，避免重复回复');
    const dailyLimit=Number(v.dailyLimit);
    if(!Number.isSafeInteger(dailyLimit)||dailyLimit<10||dailyLimit>10000)fail('每日进线消息上限应为 10–10000');
    const data={title:text(v.title,80)||'在线咨询',intro:text(v.intro,600),enabled:!!v.enabled,autoReply:!!v.autoReply,workflowReply:!!v.workflowReply,agentId:agent.id,origins,dailyLimit};
    const id=old.id||randomBytes(18).toString('hex');
    db.prepare('INSERT INTO web_sites VALUES(?,?,?) ON CONFLICT(workspaceId) DO UPDATE SET data=excluded.data').run(id,workspaceId,JSON.stringify(data));
    const g=growthFor(workspaceId);
    for(const c of g.all('conversation').filter(c=>c.sourceKind==='web'&&c.sourceId===id)){
      if(c.status==='ai'&&(!data.enabled||!data.autoReply||c.agentId!==data.agentId))g.put('conversation',{...c,status:'human',handoffReason:'网页接待配置已变更，请人工确认'},c.id);
      if(old.workflowReply&&(!data.enabled||!data.workflowReply))g.stopAutomation(c.id,'网页工作流接待已停用');
    }
    return settings(workspaceId);
  }
  function permitted(workspaceId,c,automatic=false) {
    const s=settings(workspaceId);
    return s.enabled&&c.sourceKind==='web'&&c.channel==='web'&&c.sourceId===s.id&&(!automatic||(automatic==='workflow'?s.workflowReply:s.autoReply&&s.agentId===c.agentId));
  }
  function limit(key,max,seconds) {
    const now=clock();let b=buckets.get(key);
    if(!b||b.until<=now){b={n:0,until:now+seconds};buckets.set(key,b);}
    if(++b.n>max)fail('操作过于频繁，请稍后再试',429);
    if(buckets.size>10000){for(const [k,v] of buckets)if(v.until<=now)buckets.delete(k);if(buckets.size>10000)buckets.delete(buckets.keys().next().value);}
  }
  function consume(s) {
    const day=new Date(clock()*1000+8*3600000).toISOString().slice(0,10);
    const used=db.prepare('SELECT count FROM web_daily WHERE siteId=? AND day=?').get(s.id,day)?.count||0;
    if(used>=s.dailyLimit)fail('今日在线咨询消息已达接待上限，请稍后联系',429);
    db.prepare('INSERT INTO web_daily VALUES(?,?,1) ON CONFLICT(siteId,day) DO UPDATE SET count=count+1').run(s.id,day);
  }
  function queue(s,id) {
    if(jobs.has(id)||!s.autoReply)return;
    const g=growthFor(s.workspaceId);
    const promise=Promise.resolve().then(async()=>{
      // Coalesce a burst into the newest customer message; do not grow a promise queue
      // or send a stale answer when a customer types again during generation.
      for(let i=0;i<3;i++){
        const before=g.get('conversation',id)?.lastIncomingId;
        await g.autoReply(id);
        const c=g.get('conversation',id);
        if(!c||c.status!=='ai'||!c.awaitingReply||c.lastIncomingId===before)break;
      }
    }).catch(()=>{}).finally(()=>jobs.delete(id));
    jobs.set(id,promise);
  }
  function tick() {
    db.prepare('DELETE FROM web_visitors WHERE expires<?').run(clock());
    for(const row of db.prepare('SELECT * FROM web_sites').all()){
      const s=parse(row);if(!s.enabled||!s.autoReply)continue;
      for(const c of growthFor(s.workspaceId).all('conversation').filter(c=>c.sourceKind==='web'&&c.sourceId===s.id&&c.status==='ai'&&c.awaitingReply&&!c.optedOut).slice(0,20))queue(s,c.id);
    }
  }
  function frameHeaders(id) {
    const s=siteById(id);
    return {'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' ${s?.enabled?s.origins.join(' '):''}`,'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  }
  async function handle(req,res,u) {
    try {
      const m=u.pathname.match(/^\/api\/webchat\/([a-f0-9]{36})\/(config|session|messages|contact|handoff|ack)$/);
      if(!m)fail('接口不存在',404);
      const s=siteById(m[1]);if(!s||!s.enabled)fail('此在线咨询暂未开放',404);
      const origin=req.headers.origin;
      const ownOrigin=(req.socket.encrypted?'https':'http')+'://'+req.headers.host;
      // Same-origin iframe uses no CORS. Direct client integrations must be explicitly
      // allowed, never use cookies, and cannot access workspace endpoints with this token.
      if(origin){if(origin!==ownOrigin&&!s.origins.includes(origin))fail('网站来源未获允许',403);res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Webchat-Client');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.writeHead(204);return res.end();}
      if(req.headers['x-webchat-client']!=='1')fail('无效的咨询客户端',403);
      const ip=req.socket.remoteAddress||'unknown';limit('requests:'+s.id+':'+ip,240,60);
      const g=growthFor(s.workspaceId),action=m[2];
      if(req.method==='GET'&&action==='config')return sendJson(res,200,{title:s.title,intro:s.intro,aiEnabled:s.autoReply,privacy:'会话和自愿提交的联系方式由本网站运营方保存，用于接待与跟进。请勿发送密码、支付信息等敏感内容。'});
      if(req.method==='POST'&&action==='session'){
        const b=await readBody(req),token=String(b.token||'');
        if(!/^[a-f0-9]{64}$/.test(token))fail('访客凭据无效');
        const old=db.prepare('SELECT * FROM web_visitors WHERE tokenHash=?').get(digest(token));
        if(old){if(old.siteId!==s.id||old.expires<=clock())fail('会话已过期，请开始新会话',401);return sendJson(res,200,{expires:old.expires});}
        limit('sessions:'+s.id+':'+ip,10,600);
        const c=g.newConversation({name:text(b.name,80)||'网页访客',channel:'web',sourceKind:'web',sourceId:s.id});
        g.put('conversation',{...c,agentId:s.agentId,status:s.autoReply?'ai':'open'},c.id);
        const expires=clock()+7*86400;
        db.prepare('INSERT INTO web_visitors VALUES(?,?,?,?)').run(digest(token),s.id,c.id,expires);
        return sendJson(res,201,{expires});
      }
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const visitor=/^[a-f0-9]{64}$/.test(token)?db.prepare('SELECT * FROM web_visitors WHERE tokenHash=? AND siteId=? AND expires>?').get(digest(token),s.id,clock()):null;
      if(!visitor)fail('会话已过期或凭据无效，请开始新会话',401);
      const id=visitor.conversationId,c=g.get('conversation',id);if(!c)fail('会话不存在',404);
      if(req.method==='GET'&&action==='messages'){
        const after=Number(u.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)fail('消息游标无效');
        const messages=g.visitorMessages(id,after);
        return sendJson(res,200,{messages,status:c.status,optedOut:c.optedOut,replying:jobs.has(id),hasMore:messages.length===100});
      }
      if(req.method!=='POST')fail('接口不存在',404);
      const b=await readBody(req);
      if(action==='ack') {const sequence=Number(b.sequence);if(!Number.isSafeInteger(sequence)||sequence<1)fail('消息游标无效');g.ackVisitor(id,sequence);return sendJson(res,200,{ok:true});}
      if(action==='messages') {
        const content=text(b.content,2001),requestId=String(b.requestId||'');
        if(!content||content.length>2000)fail('消息应为 1–2000 字');
        if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))fail('消息标识无效');
        const mid=digest('web:'+id+':'+requestId),old=g.visitorMessage(id,mid);
        if(old){if(old.content!==content)fail('消息标识已被其他内容使用',409);return sendJson(res,200,{ok:true,id:mid});}
        if(c.optedOut)fail('本会话已停止联系，请开始新会话',409);
        limit('send:'+visitor.tokenHash,20,60);consume(s);
        g.receive(c,content,{id:mid});queue(s,id);
        return sendJson(res,201,{ok:true,id:mid});
      }
      if(action==='handoff') {g.put('conversation',{...c,status:'human',handoffReason:'网页访客申请人工服务',unread:Math.max(1,c.unread),awaitingReply:!c.optedOut},id);g.stopAutomation(id,'网页访客申请人工服务');return sendJson(res,200,{ok:true});}
      if(action==='contact') {
        if(c.optedOut)fail('本会话已停止联系',409);
        const name=text(b.name,80),phone=text(b.phone,40),wechat=text(b.wechat,80);
        if(b.consent!==true)fail('请先同意将联系方式用于本次咨询跟进');
        if(phone&&!/^1[3-9]\d{9}$/.test(phone))fail('请输入有效的 11 位手机号');
        if(wechat&&!/^[A-Za-z][\w-]{5,19}$/.test(wechat))fail('微信号应为 6–20 位，以字母开头');
        if(!phone&&!wechat)fail('请至少填写手机号或微信号');
        limit('contact:'+visitor.tokenHash,5,60);
        g.visitorContact(id,{name,phone,wechat});return sendJson(res,200,{ok:true});
      }
      fail('接口不存在',404);
    } catch(e){return sendJson(res,e.status||500,{error:e.status?e.message:'在线咨询暂时不可用，请稍后重试'});}
  }
  return {handle,settings,save,permitted,frameHeaders,tick,idle:()=>Promise.all([...jobs.values()])};
}
module.exports={createWebChat};
