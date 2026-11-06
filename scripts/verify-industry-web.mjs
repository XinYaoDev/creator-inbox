// Read-only verification of the real browser-created conversation. No model calls,
// injected messages, clock manipulation, or business mutations are performed here.
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const base='http://127.0.0.1:18879/api/growth'
async function read(path){const r=await fetch(base+path);assert.ok(r.ok,`${path}: ${r.status}`);return r.json()}
const id='10286744-37e9-4e87-ab80-979e251c92a6'
const detail=await read('/conversations/'+id),state=await read('/state')
const c=detail.conversation,s=c.salesState,ai=detail.messages.filter(m=>m.role==='ai')
const tasks=state.tasks.filter(t=>t.conversationId===id)
const checks={
  realWebChannel:c.channel==='web'&&c.name==='排除项完整回归访客',
  twoRealModelReplies:ai.length===2&&ai.every(m=>m.source==='model'&&m.model==='gpt-6.1-sol'),
  visitorAcknowledged:ai.every(m=>m.delivery==='delivered'),
  preservedCoreScope:s.facts.serviceScope?.value==='地面和厨卫表面日常保洁',
  explicitExclusion:s.constraints.some(x=>x.field==='serviceScope'&&x.value==='不增加油烟机拆洗'),
  groundedExclusion:s.constraints.every(x=>detail.messages.some(m=>m.id===x.messageId&&m.role==='customer'&&m.content.includes(x.evidence))),
  summaryContainsBoth:detail.salesSummary.includes('服务范围：地面和厨卫表面日常保洁')&&detail.salesSummary.includes('补充限制 · 服务范围：不增加油烟机拆洗'),
  humanHandoff:c.status==='human'&&s.phase==='handoff',
  notConverted:detail.lead.stage==='new',
  oneFollowup:tasks.length===1&&tasks[0].status==='pending',
  retainedTurns:detail.salesTimeline.length===2,
}
// Preserve a record of failures instead of silently rewriting their persisted memory.
const before=await read('/conversations/635a5407-1569-43b3-9703-a6866cc5cdb3')
const interim=await read('/conversations/a989ac5c-d8be-4e1b-9607-0e6b564262cb')
const report={at:new Date().toISOString(),checks,detail,tasks,earlierObservations:[
  {id:before.conversation.id,issue:'排除项曾覆盖核心服务范围',salesState:before.conversation.salesState},
  {id:interim.conversation.id,issue:'核心范围保留，但模型未单独输出排除项；后续扩展结构化提取协议',salesState:interim.conversation.salesState},
]}
writeFileSync(new URL('../data/growth-industry-scale-20261018/web-regression-report.json',import.meta.url),JSON.stringify(report,null,2))
console.log(JSON.stringify({conversationId:id,checks},null,2))
assert.ok(Object.values(checks).every(Boolean),'Real browser flow verification failed')
