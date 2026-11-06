'use strict';

const { createHash } = require('node:crypto');
const TYPES = ['condition','tag','assign','task','note','reply','wait','handoff','end'];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Deliberately closed action vocabulary: no arbitrary code, URL fetch, or unchecked outbound sends.
function validateWorkflow(input, { memberExists }) {
  const name=String(input.name||'').trim().slice(0,100);
  if(!name)fail('任务名称不能为空');
  if(!Array.isArray(input.nodes)||input.nodes.length<1||input.nodes.length>30)fail('流程需要 1–30 个节点');
  const ids=new Set();
  const nodes=input.nodes.map(n=>{
    const id=String(n.id||'');if(!/^[\w-]{1,80}$/.test(id)||ids.has(id))fail('节点标识无效或重复');ids.add(id);
    if(!TYPES.includes(n.type))fail('不支持的节点类型');
    const value=String(n.value||'').trim().slice(0,1000);
    if(['tag','assign','task','note','reply','handoff'].includes(n.type)&&!value)fail('动作内容不能为空');
    if(n.type==='assign'&&!memberExists(value))fail('分配的负责人不存在');
    const field=n.field||'text',operator=n.operator||'contains';
    if(n.type==='condition'&&(!['text','intent','phone','wechat','channel','tag'].includes(field)||!['contains','equals','exists'].includes(operator)))fail('条件格式无效');
    if(n.type==='condition'&&operator!=='exists'&&!value)fail('条件比较值不能为空');
    const position=n.position;
    if(position&&(!Number.isFinite(position.x)||!Number.isFinite(position.y)||Math.abs(position.x)>20000||Math.abs(position.y)>20000))fail('节点位置无效');
    return {id,type:n.type,value,field,operator,minutes:Math.max(1,Math.min(43200,Number(n.minutes)||5)),next:['end','handoff'].includes(n.type)?'':String(n.next||''),otherwise:n.type==='condition'?String(n.otherwise||''):'',...(position?{position:{x:position.x,y:position.y}}:{})};
  });
  for(const n of nodes)for(const target of [n.next,n.type==='condition'?n.otherwise:''])if(target&&!ids.has(target))fail('分支指向不存在的节点');
  const visited=new Set(),visiting=new Set();
  function visit(id){if(!id)return;if(visiting.has(id))fail('流程不能包含循环');if(visited.has(id))return;visiting.add(id);const n=nodes.find(n=>n.id===id);visit(n.next);if(n.type==='condition')visit(n.otherwise);visiting.delete(id);visited.add(id);}
  for(const n of nodes)visit(n.id);
  const reachable=new Set();
  function reach(id){if(!id||reachable.has(id))return;reachable.add(id);const n=nodes.find(n=>n.id===id);if(['handoff','end'].includes(n.type))return;reach(n.next);if(n.type==='condition')reach(n.otherwise);}
  reach(nodes[0].id);if(reachable.size!==nodes.length)fail('有节点无法从入口到达，请连接分支或移除孤立节点');
  if(!['incoming','high_intent','manual'].includes(input.trigger||'incoming'))fail('触发事件无效');
  if(!['all','wechat','douyin','xiaohongshu','wecom','wechat_official','web','sandbox'].includes(input.channel||'all'))fail('触发渠道无效');
  if(nodes.some(n=>n.type==='reply')&&!['web','sandbox'].includes(input.channel))fail('含发送回复的任务，渠道必须明确选择网页咨询或测试会话');
  return {name,enabled:!!input.enabled,trigger:input.trigger||'incoming',channel:String(input.channel||'all'),cancelOnReply:input.cancelOnReply!==false,nodes};
}

function createWorkflows({db,all,get,put,event,clock,task,addMessage,reply}) {
  function cancel(conversationId,reason){
    for(const r of all('workflowRun').filter(r=>r.conversationId===conversationId&&['running','waiting'].includes(r.status))) {
      put('workflowRun',{...r,status:'cancelled',reason},r.id);event(conversationId,'任务取消',r.name+'：'+reason);
    }
  }
  function advance(id){
    let run=get('workflowRun',id);
    if(!run||!['running','waiting'].includes(run.status))return run;
    const workflow=get('workflow',run.workflowId),c=get('conversation',run.conversationId);
    if(!c||c.optedOut||c.status==='resolved'||!workflow?.enabled)return put('workflowRun',{...run,status:'cancelled',reason:'会话完成、停止联系或流程已停用'},id);
    if(run.status==='waiting'&&run.dueAt>clock())return run;
    if(run.status==='waiting'&&run.cancelOnReply&&c.lastIncomingId!==run.observedIncomingId)return put('workflowRun',{...run,status:'cancelled',reason:'等待期间收到新消息'},id);
    for(let i=0;i<31;i++) {
      const node=run.nodes.find(n=>n.id===run.cursor);
      if(!node){run=put('workflowRun',{...run,status:'completed',finishedAt:clock()},id);event(c.id,'任务完成',run.name);return run;}
      db.exec('SAVEPOINT growth_workflow');
      try {
        const current=get('conversation',c.id),lead=get('lead',c.id);let next=node.next,status='running',dueAt=0;
        if(node.type==='condition') {
          const values={text:run.text,intent:lead?.intent||current.intent,phone:lead?.phone,wechat:lead?.wechat,channel:current.channel,tag:current.tags.join(',')};
          const actual=String(values[node.field]||'');
          const match=node.operator==='exists'?!!actual:node.operator==='equals'?actual===node.value:actual.includes(node.value);
          next=match?node.next:node.otherwise;
        }
        if(node.type==='tag')put('conversation',{...current,tags:[...new Set([...current.tags,node.value])]},c.id);
        if(node.type==='assign'){
          const member=get('member',node.value);if(!member||member.active===false)fail('负责人不存在或已停用，请更新流程');
          put('conversation',{...current,owner:node.value},c.id);
        }
        if(lead&&['tag','assign'].includes(node.type)){const fresh=get('conversation',c.id);put('lead',{...lead,tags:fresh.tags,owner:fresh.owner},c.id);}
        if(node.type==='task')task(current,node.value,'',clock()+node.minutes*60,'workflow:'+id+':'+node.id);
        if(node.type==='note')addMessage(c.id,'note',node.value,{id:'workflow:'+id+':'+node.id,delivery:'internal'});
        if(node.type==='reply'){
          if(!reply)fail('工作流发送尚未配置');
          reply(current,node.value,'workflow:'+id+':'+node.id);
        }
        if(node.type==='handoff'){put('conversation',{...current,status:'human',handoffReason:node.value},c.id);next='';}
        if(node.type==='end')next='';
        if(node.type==='wait'){status='waiting';dueAt=clock()+node.minutes*60;}
        run=put('workflowRun',{...run,cursor:next,status,dueAt,steps:[...run.steps,{nodeId:node.id,type:node.type,at:clock(),next}]},id);
        event(c.id,'任务节点',run.name+' / '+node.type+' / '+node.id);
        db.exec('RELEASE growth_workflow');
        if(status==='waiting')return run;
      }catch(error){db.exec('ROLLBACK TO growth_workflow');db.exec('RELEASE growth_workflow');run=put('workflowRun',{...get('workflowRun',id),status:'failed',reason:String(error.message)},id);event(c.id,'任务失败',run.reason);return run;}
    }
    return put('workflowRun',{...run,status:'failed',reason:'超过节点执行上限'},id);
  }
  function start(workflow,c,text,messageId){
    if(!workflow.enabled||c.optedOut||c.status==='resolved')return null;
    if(workflow.channel!=='all'&&workflow.channel!==c.channel)fail('该会话不属于流程指定的渠道');
    const id=createHash('sha256').update(workflow.id+':'+c.id+':'+messageId).digest('hex').slice(0,32);
    if(get('workflowRun',id))return get('workflowRun',id);
    put('workflowRun',{workflowId:workflow.id,workflowVersion:workflow.version||1,name:workflow.name,conversationId:c.id,messageId,observedIncomingId:c.lastIncomingId,text,nodes:workflow.nodes,cancelOnReply:workflow.cancelOnReply,cursor:workflow.nodes[0].id,status:'running',steps:[]},id);
    return advance(id);
  }
  function trigger(c,text,kind,messageId){
    for(const w of all('workflow').filter(w=>w.enabled&&w.trigger===kind&&(w.channel==='all'||w.channel===c.channel)))start(w,c,text,messageId);
  }
  function tick(){for(const r of all('workflowRun').filter(r=>['waiting','running'].includes(r.status)))advance(r.id);}
  function cancelRun(id){const run=get('workflowRun',id);if(!run)throw Object.assign(Error('执行记录不存在'),{status:404});if(['waiting','running'].includes(run.status)){put('workflowRun',{...run,status:'cancelled',reason:'管理员主动停止'},id);event(run.conversationId,'任务取消',run.name+'：管理员主动停止');}return get('workflowRun',id);}
  return {start,trigger,tick,advance,cancel,cancelRun};
}
module.exports={validateWorkflow,createWorkflows};
