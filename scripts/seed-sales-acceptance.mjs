// Synthetic fixtures only. This script refuses to seed the user's main service.
import assert from 'node:assert/strict'
const base='http://127.0.0.1:18879/api/growth'
async function call(path,body,method='POST'){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d}
const existing=await (await fetch(base+'/state')).json();assert.ok(existing.knowledge.length===0&&existing.stats.total===0,'Dedicated acceptance database must be empty')
const docs=[
 ['材料工具','青禾陶艺工坊提供陶土、围裙、颜料和制作工具，全部包含在体验费用内，学员无需自备器材。'],
 ['作品领取与寄送','成品需要烧制，约十四天后完成。顾客可到店领取，也可选择快递到家；邮寄服务每件二十元，不包含在课程费用内。'],
 ['基础与进阶体验','基础手捏体验每位129元，时长两小时，适合零基础。费用包括材料、工具、老师指导及一件作品的烧制。进阶拉坯体验每位199元，时长两小时。没有团购折扣。'],
 ['营业与到店','每日九点至十八点营业。周末课程需提前一天预约，具体余位由人工核实。'],
 ['停车说明','门店没有专用停车场，可乘地铁到达。'],
 ['退款与改期','开课二十四小时前可申请改期，由工作人员核实。退款需人工处理。'],
]
for(const [title,body] of docs)await call('/knowledge',{title,body,category:'合成陶艺验收',enabled:true})
await call('/model',{provider:'hermes-codex',model:'gpt-6.1-sol',embeddingProvider:'local',embeddingMinScore:.4},'PATCH')
await call('/agent/default',{name:'青禾体验顾问 · 合成验收',enabled:true,welcomeEnabled:false,channels:['web','sandbox'],brand:'青禾陶艺工坊。全部资料和访客都是合成测试，不是真实商户。依据业务知识帮助顾客选择体验，不承诺未核实的余位。',maxLength:400,salesEnabled:true,salesRequired:['need','quantity','timing','budget'],collectEnabled:true,salesGoal:'了解体验需求、人数、时间和预算；解释方案与顾虑；顾客同意后转人工核实具体安排。不要把询价当成预约。'},'PATCH')
const channel=await call('/web-channel',{enabled:true,autoReply:true,workflowReply:false,agentId:'default',title:'青禾陶艺 · 真实多轮验收',intro:'这是合成资料的本地验收，使用真实 GPT 和本地向量检索。',origins:[],dailyLimit:200},'PATCH')
console.log(JSON.stringify({siteId:channel.id,visitor:'http://127.0.0.1:18879/chat/'+channel.id,knowledge:docs.length}))
