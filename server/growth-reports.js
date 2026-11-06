'use strict';
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const date=t=>formatter.format(new Date(t*1000));
const stageNames={new:'新线索',qualified:'跟进中',scheduled:'已预约',won:'已成交',lost:'已流失'};
function dayStart(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))fail('日期格式应为 YYYY-MM-DD');const ts=Date.parse(value+'T00:00:00+08:00')/1000;if(!Number.isFinite(ts)||date(ts)!==value)fail('日期无效');return ts;}
function createReports({db,all,get,clock,channels,stages}){
  function report(params){
    const today=date(clock()),from=params.get('from')||date(clock()-6*86400),to=params.get('to')||today;
    const start=dayStart(from),end=dayStart(to)+86400;
    if(end<=start||end-start>366*86400)fail('日期区间需为 1–366 天');
    const channel=params.get('channel')||'all',owner=params.get('owner')||'all',includeSandbox=params.get('includeSandbox')==='1';
    if(channel!=='all'&&!channels[channel])fail('渠道无效');
    if(owner!=='all'&&owner!=='unassigned'&&!get('member',owner))fail('负责人不存在');
    const allConversations=all('conversation').filter(c=>(includeSandbox||c.sourceKind!=='sandbox')&&(channel==='all'||c.channel===channel)&&(owner==='all'||(owner==='unassigned'?!c.owner:c.owner===owner)));
    const ids=new Set(allConversations.map(c=>c.id)),byId=new Map(allConversations.map(c=>[c.id,c])),inPeriod=ts=>ts>=start&&ts<end;
    const conversations=allConversations.filter(c=>inPeriod(c.created)),leads=all('lead').filter(l=>ids.has(l.conversationId));
    const messages=db.prepare('SELECT rowid AS sequence,* FROM growth_messages WHERE ts<? ORDER BY ts,rowid').all(end).filter(m=>ids.has(m.conversationId));
    const incoming=messages.filter(m=>m.role==='customer'&&inPeriod(m.ts)),successful=m=>['human','ai','workflow'].includes(m.role)&&['sent','local','imported','queued','delivered'].includes(m.delivery);
    const outgoing=messages.filter(m=>successful(m)&&inPeriod(m.ts)&&!m.requestId?.startsWith('welcome:'));
    const pending=new Map(),replyDelays=[],responded=new Set();
    // Measure the first reply to a burst; a welcome message is not an answer.
    for(const m of messages){
      if(m.role==='customer'){if(!pending.has(m.conversationId))pending.set(m.conversationId,m.ts);}
      else if(successful(m)&&!m.requestId?.startsWith('welcome:')&&pending.has(m.conversationId)){
        const received=pending.get(m.conversationId);if(inPeriod(m.ts)){replyDelays.push(Math.max(0,m.ts-received));responded.add(m.conversationId);}pending.delete(m.conversationId);
      }
    }
    const sorted=[...replyDelays].sort((a,b)=>a-b),percentile=p=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null;
    const median=sorted.length?(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2:null;
    const stageEvents=all('leadStageEvent').filter(e=>ids.has(e.conversationId)&&inPeriod(e.at));
    const reached=stages.map(id=>({id,count:new Set(stageEvents.filter(e=>e.to===id).map(e=>e.conversationId)).size}));
    const trend=[];for(let ts=start;ts<end;ts+=86400)trend.push({date:date(ts),conversations:0,incoming:0,outgoing:0});
    const byDay=new Map(trend.map(d=>[d.date,d]));
    for(const c of conversations)byDay.get(date(c.created)).conversations++;
    for(const m of incoming)byDay.get(date(m.ts)).incoming++;
    for(const m of outgoing)byDay.get(date(m.ts)).outgoing++;
    const channelRows=Object.entries(channels).map(([id,name])=>({id,name,conversations:conversations.filter(c=>c.channel===id).length,incoming:incoming.filter(m=>byId.get(m.conversationId)?.channel===id).length,outgoing:outgoing.filter(m=>byId.get(m.conversationId)?.channel===id).length})).filter(c=>includeSandbox||c.id!=='sandbox');
    return {filters:{from,to,channel,owner,includeSandbox},timezone:'Asia/Shanghai',generatedAt:clock(),trackingSince:get('meta','report-tracking')?.since||clock(),
      metrics:{workflowReplies:outgoing.filter(m=>m.role==='workflow').length,newConversations:conversations.length,activeConversations:new Set([...incoming,...outgoing].map(m=>m.conversationId)).size,incoming:incoming.length,outgoing:outgoing.length,aiReplies:outgoing.filter(m=>m.role==='ai').length,humanReplies:outgoing.filter(m=>m.role==='human').length,failedSends:messages.filter(m=>['failed','unknown'].includes(m.delivery)&&inPeriod(m.ts)).length,respondedConversations:responded.size,replySamples:replyDelays.length,averageReplySeconds:sorted.length?Math.round(sorted.reduce((a,b)=>a+b,0)/sorted.length):null,medianReplySeconds:median,p95ReplySeconds:percentile(.95),capturedNewLeads:leads.filter(l=>inPeriod(l.created)&&(l.phone||l.wechat)).length},
      current:{conversations:allConversations.length,unanswered:allConversations.filter(c=>c.status!=='resolved'&&c.awaitingReply&&!c.optedOut).length,stages:stages.map(id=>({id,count:leads.filter(l=>l.stage===id).length}))},trend,channels:channelRows,stageReached:reached};
  }
  function csv(data){
    const m=data.metrics,rows=[['统计范围',data.filters.from+' 至 '+data.filters.to],['时区',data.timezone],['渠道',data.filters.channel==='all'?'全部渠道':channels[data.filters.channel]],['当前负责人',data.filters.owner==='all'?'全部成员':data.filters.owner==='unassigned'?'未分配':get('member',data.filters.owner)?.name||data.filters.owner],['包含测试会话',data.filters.includeSandbox?'是':'否'],['新增会话',m.newConversations],['活跃会话',m.activeConversations],['收到消息',m.incoming],['成功回复',m.outgoing],['AI 回复',m.aiReplies],['人工回复',m.humanReplies],['失败或未知发送',m.failedSends],['平均首响秒数',m.averageReplySeconds??'无样本'],['中位首响秒数',m.medianReplySeconds??'无样本'],['P95 首响秒数',m.p95ReplySeconds??'无样本'],['有效回复样本',m.replySamples],['回复过的会话',m.respondedConversations],['期内建立且当前已留资的档案',m.capturedNewLeads],[],['日期','新增会话','收到消息','成功回复'],...data.trend.map(d=>[d.date,d.conversations,d.incoming,d.outgoing]),[],['渠道','新增会话','收到消息','成功回复'],...data.channels.map(c=>[c.name,c.conversations,c.incoming,c.outgoing]),[],['期间到达的阶段','去重顾客数'],...data.stageReached.map(s=>[stageNames[s.id],s.count]),[],['当前阶段快照（不受日期范围限制）','顾客数'],...data.current.stages.map(s=>[stageNames[s.id],s.count]),['当前待回复会话',data.current.unanswered],[],['统计说明','首响按回复时间计入区间，排除欢迎语、备注、失败及未知发送；负责人按当前分配，不代表历史绩效；阶段事件开始记录前不回填。']];
    rows.splice(rows.findIndex(r=>r[0]==='人工回复')+1,0,['工作流回复',m.workflowReplies]);
    const esc=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';return '\uFEFF'+rows.map(r=>r.map(esc).join(',')).join('\r\n');
  }
  return {report,csv};
}
module.exports={createReports,dayStart};
