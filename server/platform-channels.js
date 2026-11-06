'use strict';
const {randomUUID}=require('node:crypto');
const {vault,digest,parseXml,verifyWechat,fail}=require('./channel-crypto.js');
const {createWechatApi}=require('./channel-wechat.js');

const CATALOG=[
  {id:'wecom_kf',channel:'wecom',name:'微信客服',implemented:true,description:'通过企业微信管理的微信客服；不是员工个人微信聊天。',url:'https://work.weixin.qq.com/',requirements:'企业管理员、自建应用 Secret、微信客服 API 管理权限、可信 IP、HTTPS 回调'},
  {id:'wechat_official',channel:'wechat_official',name:'微信公众号',implemented:true,description:'认证公众号的客服消息，安全模式接收。',url:'https://mp.weixin.qq.com/',requirements:'认证公众号及客服接口权限、AppID / AppSecret、原始 ID、IP 白名单、HTTPS 回调'},
  {id:'xiaohongshu',name:'小红书专业号 / KOS',implemented:false,description:'官方私信需获批 IM 应用或服务商资格，普通登录不能替代。来鼓方案还需在聚光中授权三方客服。',url:'https://docs.laigu.com/guide/setup/xiaohongshu/',requirements:'专业号管理权限、正式 IM 应用或服务商合作资质及对应接口文档'},
  {id:'douyin',name:'抖音企业号',implemented:false,description:'已有旧版评论采集；官方私信、原生卡片、授权撤销仍待接入，需确认获批的应用能力。',url:'https://developer.open-douyin.com/',requirements:'企业号、开放平台应用、获批的私信 scope 和回调域名'},
  {id:'wecom_contact',name:'企业微信客户联系',implemented:false,description:'客户资料、联系我、群发与会话存档分别需要权限；不能当作任意私聊发送接口。',url:'https://work.weixin.qq.com/',requirements:'企业管理员、客户联系应用；读取聊天需要会话存档权限与客户同意'},
  {id:'channels',name:'视频号',implemented:false,description:'保留旧版登录采集与人工回复；官方消息服务尚未完成，旧适配器不等于正式授权 API。',url:'https://channels.weixin.qq.com/',requirements:'视频号管理员及对应开放能力'},
  {id:'kuaishou',name:'快手',implemented:false,description:'待核实官方消息开放资格与协议，未接入。',url:'https://open.kuaishou.com/',requirements:'开放平台应用及获批消息权限'}
];
const clean=(v,max=200)=>String(v??'').trim().slice(0,max);
function createPlatformChannels({db,keyPath,growthFor,sendJson,readBody,clock=()=>Math.floor(Date.now()/1000),fetcher,listener}){
  const secretStore=vault(keyPath),api=createWechatApi({fetcher,clock}),workers=new Map(),sendLocks=new Map(),callbackLimits=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS channel_connections(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,provider TEXT NOT NULL,identity TEXT UNIQUE,data TEXT NOT NULL,secrets TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS channel_workspace ON channel_connections(workspace);
    CREATE TABLE IF NOT EXISTS channel_events(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,created INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS channel_events_due ON channel_events(connectionId,state,nextAt);
    CREATE TABLE IF NOT EXISTS channel_outbox(id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,messageId TEXT NOT NULL,windowId TEXT NOT NULL,contentHash TEXT NOT NULL,state TEXT NOT NULL,platformId TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS channel_audit(id INTEGER PRIMARY KEY,connectionId TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);`);
  db.prepare("UPDATE channel_outbox SET state='unknown',error='发送期间服务重启，请先到原平台核实' WHERE state='sending'").run();
  const row=id=>db.prepare('SELECT * FROM channel_connections WHERE id=?').get(id);
  const get=id=>{const r=row(id);return r?{...JSON.parse(r.data),id:r.id,workspace:r.workspace,provider:r.provider}:null;};
  const owned=(workspace,id)=>{const c=get(id);if(!c||c.workspace!==workspace)fail('渠道账号不存在',404);return c;};
  const secrets=c=>secretStore.open(row(c.id).secrets,c.workspace+':'+c.id);
  const update=(id,patch)=>{const c=get(id);db.prepare('UPDATE channel_connections SET data=? WHERE id=?').run(JSON.stringify({...c,...patch}),id);return get(id);};
  const audit=(id,action,detail)=>db.prepare('INSERT INTO channel_audit(connectionId,action,detail,created) VALUES(?,?,?,?)').run(id,action,clean(detail,1000),clock());
  function view(c){
    const {cursor,...data}=c;
    return {...data,callbackPath:'/api/channel-callback/'+c.id,callbackUrl:c.publicBase?c.publicBase+'/api/channel-callback/'+c.id:'',
      credentialsConfigured:true,pending:Number(db.prepare("SELECT count(*) AS n FROM channel_events WHERE connectionId=? AND state IN ('pending','retry')").get(c.id).n),
      dead:Number(db.prepare("SELECT count(*) AS n FROM channel_events WHERE connectionId=? AND state='dead'").get(c.id).n),
      status:!c.verifiedAt?'待验证凭据':!c.callbackVerifiedAt?'待验证回调':!c.enabled?'待启用':!c.lastInboundAt?'等待首条进线':!c.lastSentAt?'待验证发送':'已收发 · 待业务验收'};
  }
  function save(workspace,b,id){
    const old=id?owned(workspace,id):null,provider=old?.provider||b.provider;
    if(!CATALOG.find(p=>p.id===provider)?.implemented)fail('该渠道尚未取得正式接口接入条件，不能创建假连接',409);
    if(old&&Number(b.expectedRevision)!==old.revision)fail('渠道设置已更新，请重新读取',409);
    const c={...old,id:old?.id||randomUUID(),workspace,provider,name:clean(b.name??old?.name,80),appId:clean(b.appId??old?.appId,128),originalId:clean(b.originalId??old?.originalId,128),kfId:clean(b.kfId??old?.kfId,128),publicBase:clean(b.publicBase??old?.publicBase,300).replace(/\/$/,''),agentId:clean(b.agentId??old?.agentId)||'default',enabled:b.enabled===undefined?old?.enabled||false:b.enabled===true,autoReply:b.autoReply===undefined?old?.autoReply||false:b.autoReply===true,revision:(old?.revision||0)+1,created:old?.created||clock(),updated:clock()};
    if(!c.name||!c.appId||!/^[A-Za-z0-9_-]+$/.test(c.appId))fail('请填写账号名称及正确的企业 ID / AppID');
    if(provider==='wechat_official'&&!/^gh_[A-Za-z0-9]+$/.test(c.originalId))fail('请填写公众号原始 ID（gh_ 开头）');
    if(c.publicBase){let u;try{u=new URL(c.publicBase);}catch{fail('回调域名无效');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||/^(localhost|127\.|\[|0\.)/.test(u.hostname))fail('回调地址需为公网 HTTPS 域名，不包含路径');}
    if(old&&[c.appId!==old.appId,c.originalId!==old.originalId,old.kfId&&c.kfId!==old.kfId].some(Boolean))fail('账号身份不能变更，请新建渠道，避免混入旧顾客消息',409);
    const s=old?secrets(old):{};
    for(const k of ['secret','callbackToken','encodingAesKey'])if(b[k])s[k]=String(b[k]).trim();
    if(!s.secret||s.secret.length<12||s.secret.length>4096||/\s/.test(s.secret))fail('请填写平台 Secret');
    if(!/^[a-zA-Z0-9]{3,32}$/.test(s.callbackToken||''))fail('回调 Token 需为 3–32 位字母或数字');
    if(!/^[a-zA-Z0-9+/]{43}$/.test(s.encodingAesKey||''))fail('EncodingAESKey 需为平台提供的 43 位密钥');
    const credentialsChanged=!old||c.kfId!==old.kfId||Boolean(b.secret),callbackChanged=!old||Boolean(b.callbackToken||b.encodingAesKey)||c.publicBase!==old.publicBase;
    if(credentialsChanged){c.verifiedAt=0;c.accounts=[];c.lastError='';}
    if(callbackChanged)c.callbackVerifiedAt=0;
    if(credentialsChanged||callbackChanged){c.enabled=false;c.autoReply=false;}
    if(c.enabled&&(!c.verifiedAt||!c.callbackVerifiedAt))fail('请先通过凭据和回调检查，再启用接收',409);
    if(c.enabled&&provider==='wecom_kf'&&!c.accounts?.some(a=>a.id===c.kfId&&a.manageable))fail('请选择拥有 API 管理权限的微信客服账号',409);
    if(c.autoReply){const a=growthFor(workspace).get('agent',c.agentId);if(!c.enabled||!a?.enabled||!a.channels.includes(CATALOG.find(p=>p.id===provider).channel))fail('请先启用渠道和对应 AI 员工，并勾选该渠道',409);}
    const identity=[provider,c.appId,c.kfId||''].join(':');
    const conflict=db.prepare('SELECT id FROM channel_connections WHERE identity=? AND id<>?').get(identity,c.id);if(conflict)fail('该平台账号已绑定，不能重复接收或跨空间串线',409);
    db.prepare('INSERT INTO channel_connections VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,data=excluded.data,secrets=excluded.secrets').run(c.id,workspace,provider,identity,JSON.stringify(c),secretStore.seal(s,workspace+':'+c.id));
    audit(c.id,'保存配置','管理员保存；接收 '+(c.enabled?'启用':'关闭')+'，自动回复 '+(c.autoReply?'启用':'关闭'));
    return view(c);
  }
  async function verify(workspace,id){
    const c=owned(workspace,id);
    try{const result=await api.verify(c,secrets(c));if(get(id).revision!==c.revision)fail('验证期间配置已变化，请重新验证',409);const next=update(id,{verifiedAt:clock(),accounts:result.accounts,lastError:''});audit(id,'凭据验证',result.message);return {connection:view(next),...result};}
    catch(e){if(get(id).revision===c.revision)update(id,{verifiedAt:0,enabled:false,autoReply:false,lastError:e.message});audit(id,'验证失败',e.message);throw e;}
  }
  function enqueue(c,id,payload){
    if(db.prepare('SELECT 1 FROM channel_events WHERE id=?').get(id))return;
    if(Number(db.prepare("SELECT count(*) AS n FROM channel_events WHERE connectionId=? AND state<>'done'").get(c.id).n)>=10000)fail('待处理回调已达上限，请先排查积压',503);
    db.prepare('INSERT OR IGNORE INTO channel_events(id,connectionId,payload,state,nextAt,created) VALUES(?,?,?,?,?,?)').run(id,c.id,secretStore.seal(payload,c.workspace+':event:'+id),'pending',clock(),clock());
  }
  async function callback(req,res,u){
    const reply=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text);};
    try{
      const id=u.pathname.match(/^\/api\/channel-callback\/([a-f0-9-]{36})$/)?.[1],c=id&&get(id);if(!c)fail('not found',404);
      const minute=Math.floor(clock()/60),rate=callbackLimits.get(id)||{minute,count:0};if(rate.minute!==minute){rate.minute=minute;rate.count=0;}if(++rate.count>600)fail('callback rate limit',429);if(callbackLimits.size>1000)callbackLimits.clear();callbackLimits.set(id,rate);
      const s=secrets(c);
      if(req.method==='GET'){
        const echo=u.searchParams.get('echostr')||'';if(!echo||echo.length>8192)fail('invalid challenge');
        const text=verifyWechat(u.searchParams,s,c.appId,c.provider==='wecom_kf'?echo:null,clock())??echo;
        update(id,{callbackVerifiedAt:clock()});audit(id,'回调已验证','平台签名验证通过');return reply(200,text);
      }
      if(req.method!=='POST')fail('method not allowed',405);
      const chunks=[];let bytes=0;for await(const chunk of req){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>1024*1024)fail('callback too large',413);chunks.push(buffer);}const body=Buffer.concat(chunks).toString('utf8');
      if(get(id)?.revision!==c.revision)fail('渠道配置已变化，请重新发送回调',503);
      const outer=parseXml(body);if(!outer.Encrypt)fail('只接收安全模式加密回调',403);
      const xml=parseXml(verifyWechat(u.searchParams,s,c.appId,outer.Encrypt,clock()));
      if(xml.ToUserName!==(c.provider==='wecom_kf'?c.appId:c.originalId))fail('回调收件账号不匹配',403);
      if(!c.enabled)fail('渠道已暂停，平台应稍后重试',503);
      if(c.provider==='wecom_kf'&&(xml.Event!=='kf_msg_or_event'||xml.OpenKfId!==c.kfId))return reply(200,'success');
      const eid=digest(c.id+':'+(xml.MsgId||[xml.Event,xml.FromUserName,xml.CreateTime,xml.Token,xml.EventKey].join(':')));
      enqueue(c,eid,xml);update(id,{lastCallbackAt:clock(),callbackVerifiedAt:clock()});reply(200,'success');
      void pump(id).catch(()=>{});
    }catch(e){reply(e.status||500,e.status&&e.status<500?e.message:'callback unavailable');}
  }
  const conversationId=(c,user)=>'channel:'+digest(c.id+':'+user).slice(0,32);
  function ingest(c,m){
    const g=growthFor(c.workspace),e=m.event||{},user=m.external_userid||e.external_userid;
    if(m.open_kfid&&m.open_kfid!==c.kfId||e.open_kfid&&e.open_kfid!==c.kfId)return;
    if(!user)return;
    const cid=conversationId(c,user),mid='platform:'+digest(c.id+':'+m.msgid),ts=Math.min(clock(),Number(m.send_time)||clock());
    if(g.visitorMessage(cid,mid))return;
    let conv=g.get('conversation',cid);
    if(m.msgtype==='event'){
      if(e.event_type==='msg_send_fail'){
        const out=db.prepare('SELECT * FROM channel_outbox WHERE connectionId=? AND platformId=?').get(c.id,e.fail_msgid);
        if(out){db.prepare("UPDATE channel_outbox SET state='failed',error=?,updated=? WHERE id=?").run('平台异步发送失败：'+Number(e.fail_type),clock(),out.id);g.externalDelivery(out.messageId,'failed','平台异步发送失败：'+Number(e.fail_type));}return;
      }
      if(!conv)return;
      if(e.event_type==='session_status_change')g.externalHandoff(cid,Number(e.change_type)===3?'resolved':'human','平台客服已操作会话');
      if(['user_recall_msg','servicer_recall_msg'].includes(e.event_type))g.externalRecall('platform:'+digest(c.id+':'+e.recall_msgid),cid);
      return;
    }
    if(![3,5].includes(m.origin))return;
    if(!conv){conv=g.newConversation({id:cid,name:'平台顾客 '+user.slice(-6),channel:CATALOG.find(p=>p.id===c.provider).channel,sourceKind:'platform',sourceId:c.id});conv=g.put('conversation',{...conv,connectionId:c.id,externalUserId:user,agentId:c.agentId,status:c.autoReply?'ai':'open'},cid);}
    const content=m.msgtype==='text'?String(m.text?.content||''):'[平台'+({image:'图片',voice:'语音',video:'视频',file:'文件',link:'链接',location:'位置',miniprogram:'小程序'}[m.msgtype]||m.msgtype)+'消息，请到原平台查看]';
    if(m.origin===5){g.externalOutgoing(cid,mid,content,ts);return;}
    const stale=ts<(conv.platformWindow?.at||0),unsupported=m.msgtype!=='text';
    if(!stale)conv=g.put('conversation',{...conv,platformWindow:{id:mid,at:ts,limit:5,expires:ts+48*3600}},cid);
    conv=g.receive(conv,content,{id:mid,ts,imported:stale});
    if(unsupported)g.externalHandoff(cid,'human','非文本平台消息，请在原平台查看后接待');
    if(stale)g.externalHandoff(cid,'human','收到延迟消息，请核对上下文后接待');
    update(c.id,{lastInboundAt:clock()});
  }
  function ingestOfficial(c,xml,eid){
    const g=growthFor(c.workspace),cid=conversationId(c,xml.FromUserName||''),prior=g.get('conversation',cid);
    if(xml.MsgType==='event'){
      if(xml.Event==='unsubscribe'&&prior){g.put('conversation',{...prior,optedOut:true},cid);g.externalHandoff(cid,'human','顾客已取消关注，停止发送');}
      return;
    }
    if(!xml.MsgId||!xml.FromUserName)fail('平台消息缺少唯一 ID 或发送者');
    ingest(c,{msgid:xml.MsgId,external_userid:xml.FromUserName,send_time:Number(xml.CreateTime),origin:3,msgtype:xml.MsgType,text:{content:xml.Content}});
  }
  async function pump(id){
    if(workers.has(id))return workers.get(id);
    const task=(async()=>{
      for(let batch=0;batch<20;batch++){
        const c=get(id);if(!c?.enabled)return;
        const ev=db.prepare("SELECT * FROM channel_events WHERE connectionId=? AND state IN ('pending','retry') AND nextAt<=? ORDER BY created,rowid LIMIT 1").get(id,clock());if(!ev)break;
        try{
          const xml=secretStore.open(ev.payload,c.workspace+':event:'+ev.id);
          if(c.provider==='wecom_kf'){
            let complete=false;
            for(let page=0;page<20;page++){
              const fresh=get(id);if(!fresh.enabled||fresh.revision!==c.revision)return;
              const data=await api.sync(fresh,secrets(fresh),fresh.cursor,clock()-Number(xml.CreateTime)<540?xml.Token:undefined);
              if(get(id).revision!==c.revision||!get(id).enabled)return;
              if(!Array.isArray(data.msg_list)||typeof data.next_cursor!=='string'||![0,1].includes(data.has_more))fail('平台同步响应格式不正确',502);
              if(data.has_more&&data.next_cursor===fresh.cursor)fail('平台分页游标未前进',502);
              db.exec('SAVEPOINT channel_page');
              try{for(const m of data.msg_list){if(!m.msgid)fail('平台消息缺少 ID');ingest(c,m);}update(id,{cursor:data.next_cursor,lastSyncAt:clock(),lastError:''});db.exec('RELEASE channel_page');}
              catch(e){db.exec('ROLLBACK TO channel_page');db.exec('RELEASE channel_page');throw e;}
              if(!data.has_more){complete=true;break;}
            }
            if(!complete){db.prepare('UPDATE channel_events SET nextAt=? WHERE id=?').run(clock()+2,ev.id);break;}
          }else{db.exec('SAVEPOINT channel_page');try{ingestOfficial(c,xml,ev.id);db.exec('RELEASE channel_page');}catch(e){db.exec('ROLLBACK TO channel_page');db.exec('RELEASE channel_page');throw e;}}
          db.prepare("UPDATE channel_events SET state='done',error='' WHERE id=?").run(ev.id);
        }catch(e){const attempts=ev.attempts+1;db.prepare('UPDATE channel_events SET state=?,attempts=?,nextAt=?,error=? WHERE id=?').run(attempts>=8?'dead':'retry',attempts,clock()+Math.min(600,5*2**attempts),clean(e.message,1000),ev.id);update(id,{lastError:clean(e.message,1000)});audit(id,'接收处理失败',e.message);break;}
      }
      const c=get(id);if(!c?.enabled||!c.autoReply)return;
      const g=growthFor(c.workspace);
      for(const conv of g.all('conversation').filter(v=>v.connectionId===id&&v.status==='ai'&&v.awaitingReply&&clock()-(v.platformWindow?.at||0)<300).slice(0,20)){
        try{await g.autoReply(conv.id);}catch(e){g.externalHandoff(conv.id,'human','平台回复未完成，请核实发送记录');audit(id,'自动接待失败',e.message);}
      }
    })();workers.set(id,task);try{return await task;}finally{workers.delete(id);}
  }
  function permitted(workspace,conv,automatic=false){const c=conv?.sourceKind==='platform'&&get(conv.connectionId);return !!c&&c.workspace===workspace&&c.enabled&&!!c.verifiedAt&&(!automatic||c.autoReply&&c.agentId===conv.agentId);}
  async function send(workspace,conv,text,requestId,messageId,role){
    const key=conv.id,prev=sendLocks.get(key)||Promise.resolve();
    const task=prev.catch(()=>{}).then(async()=>{
      const c=owned(workspace,conv.connectionId),g=growthFor(workspace),fresh=g.get('conversation',conv.id),s=secrets(c),agentSnapshot=JSON.stringify(g.get('agent',fresh?.agentId));
      if(!permitted(workspace,fresh,role==='ai')||fresh.optedOut||role==='ai'&&fresh.status!=='ai')fail('渠道已停用、自动接待已关闭或顾客已转人工',409);
      if(Buffer.byteLength(text)>2048)fail('平台文本不能超过 2048 字节，请缩短后发送');
      const w=fresh.platformWindow;if(!w||w.expires<=clock())fail('平台回复窗口已过期，请等待顾客再次发送消息',409);
      const id=digest(c.id+':'+requestId),existing=db.prepare('SELECT * FROM channel_outbox WHERE id=?').get(id);
      if(existing){if(existing.conversationId!==conv.id||existing.contentHash!==digest(text))fail('发送标识重复',409);if(existing.state==='accepted')return existing;throw Object.assign(new Error('此前发送未确认成功，请核实原平台；不会重复发送'),{status:409,deliveryUnknown:existing.state==='unknown'||existing.state==='sending'});}
      if(db.prepare("SELECT 1 FROM channel_outbox WHERE conversationId=? AND state='unknown' LIMIT 1").get(conv.id))fail('此会话存在结果未知的发送，请先在渠道记录中核实，防止重复联系',409);
      const count=db.prepare("SELECT count(*) AS n FROM channel_outbox WHERE conversationId=? AND windowId=? AND state IN ('sending','accepted','unknown')").get(conv.id,w.id).n;
      if(count>=w.limit)fail('本轮回复已达平台条数限制，请等待顾客新消息',409);
      const platformId=digest(id).slice(0,32);
      db.prepare('INSERT INTO channel_outbox(id,connectionId,conversationId,requestId,messageId,windowId,contentHash,state,platformId,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,c.id,conv.id,requestId,messageId,w.id,digest(text),'sending',platformId,clock(),clock());
      try{
        const result=await api.send(c,s,fresh.externalUserId,text,platformId,role,()=>{
          const current=g.get('conversation',conv.id);
          if(get(c.id)?.revision!==c.revision||!permitted(workspace,current,role==='ai')||current.optedOut||current.platformWindow?.expires<=clock()||role==='ai'&&(current.status!=='ai'||current.lastIncomingId!==fresh.lastIncomingId||JSON.stringify(g.get('agent',current.agentId))!==agentSnapshot))fail('发送前接待状态或配置已变化，已取消外发',409);
        });
        db.prepare("UPDATE channel_outbox SET state='accepted',platformId=?,updated=? WHERE id=? AND state='sending'").run(result.msgid||platformId,clock(),id);
        if(db.prepare('SELECT state FROM channel_outbox WHERE id=?').get(id).state==='failed')fail('平台已回报发送失败，请核查记录',502);
        update(c.id,{lastSentAt:clock(),lastError:''});audit(c.id,'平台接受发送','仅表示平台已接受；不代表顾客已读');return {platformId:result.msgid||platformId};
      }catch(e){db.prepare('UPDATE channel_outbox SET state=?,error=?,updated=? WHERE id=?').run(e.deliveryUnknown?'unknown':'failed',clean(e.message,1000),clock(),id);update(c.id,{lastError:clean(e.message,1000)});audit(c.id,e.deliveryUnknown?'发送结果未知':'发送失败',e.message);throw e;}
    });sendLocks.set(key,task);try{return await task;}finally{if(sendLocks.get(key)===task)sendLocks.delete(key);}
  }
  async function handle(req,res,u){
    try{
      if(req.access?.role!=='admin')fail('渠道接入配置仅管理员可用',403);
      const workspace=req.access.workspaceId||'default',path=u.pathname.slice('/api/growth/channels'.length),m=path.match(/^\/([^/]+)(?:\/(verify|retry|sync|activity|reconcile))?$/);
      if(path===''&&req.method==='GET')return sendJson(res,200,{catalog:CATALOG,list:db.prepare('SELECT id FROM channel_connections WHERE workspace=?').all(workspace).map(r=>view(get(r.id))),callbackListener:listener?.status()||{enabled:false},canManageListener:workspace==='default',note:'桌面服务不会自动开放公网。仅回调入口需要 HTTPS 反向代理。'});
      if(path==='/runtime'&&req.method==='PATCH'){if(workspace!=='default')fail('仅默认空间管理员可设置本机公共回调入口',403);if(!listener)fail('当前运行环境没有回调监听器',503);return sendJson(res,200,await listener.configure(await readBody(req)));}
      if(path===''&&req.method==='POST')return sendJson(res,201,save(workspace,await readBody(req)));
      if(!m)fail('渠道接口不存在',404);
      const [,id,action]=m,c=owned(workspace,id);
      if(!action&&req.method==='PATCH')return sendJson(res,200,save(workspace,await readBody(req),id));
      if(action==='verify'&&req.method==='POST')return sendJson(res,200,await verify(workspace,id));
      if(action==='activity'&&req.method==='GET')return sendJson(res,200,{events:db.prepare('SELECT id,state,attempts,created,error FROM channel_events WHERE connectionId=? ORDER BY created DESC LIMIT 50').all(id),outbox:db.prepare('SELECT id,conversationId,state,created,error FROM channel_outbox WHERE connectionId=? ORDER BY created DESC LIMIT 50').all(id),audit:db.prepare('SELECT action,detail,created FROM channel_audit WHERE connectionId=? ORDER BY id DESC LIMIT 50').all(id)});
      if(action==='reconcile'&&req.method==='POST'){
        const b=await readBody(req),out=db.prepare('SELECT * FROM channel_outbox WHERE id=? AND connectionId=?').get(clean(b.outboxId),id);
        if(!out||out.state!=='unknown')fail('只能核实结果未知的发送',409);
        if(!['accepted','failed'].includes(b.result)||b.confirmed!==true||!clean(b.note,500))fail('请先在原平台核实，并填写核实依据');
        db.prepare('UPDATE channel_outbox SET state=?,error=?,updated=? WHERE id=?').run(b.result,'人工核实：'+clean(b.note,500),clock(),out.id);
        growthFor(workspace).externalDelivery(out.messageId,b.result==='accepted'?'sent':'failed','管理员在原平台核实：'+clean(b.note,500));audit(id,'人工核实发送',clean(req.access.name,100)+' · '+b.result+' · '+clean(b.note,500));return sendJson(res,200,{ok:true});
      }
      if(action==='retry'&&req.method==='POST'){if(!c.enabled)fail('请先启用接收',409);db.prepare("UPDATE channel_events SET state='retry',attempts=0,nextAt=? WHERE connectionId=? AND state IN ('dead','retry')").run(clock(),id);void pump(id);return sendJson(res,202,{ok:true,message:'只重试接收任务，不会重发结果未知的消息'});}
      if(action==='sync'&&req.method==='POST'){
        if(c.provider!=='wecom_kf'||!c.enabled)fail('仅已启用的微信客服可主动续拉',409);
        if(c.manualSyncAt&&clock()-c.manualSyncAt<60)fail('请至少间隔 60 秒再同步',429);
        update(id,{manualSyncAt:clock()});enqueue(c,randomUUID(),{CreateTime:0});void pump(id);return sendJson(res,202,{ok:true,message:'已安排增量同步'});
      }
      fail('渠道接口不存在',404);
    }catch(e){return sendJson(res,e.status||500,{error:e.message});}
  }
  function tick(){for(const r of db.prepare('SELECT id FROM channel_connections').all())if(get(r.id)?.enabled)void pump(r.id).catch(()=>{});}
  return {handle,callback,tick,get,save,verify,permitted,send,pump,ingest,view};
}
module.exports={createPlatformChannels,CATALOG};
