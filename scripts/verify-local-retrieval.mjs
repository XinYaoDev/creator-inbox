import {createRequire} from 'node:module'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url),{DatabaseSync}=require('node:sqlite'),{createGrowth}=require('../server/growth.js')
const db=new DatabaseSync(':memory:')
const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,modelConfig:()=>({embeddingProvider:'local',embeddingMinScore:.4})})
async function call(method,path,body){const r={};await app.handle({method,body},r,new URL('http://localhost/api/growth'+path));assert.ok(r.status<400,JSON.stringify(r.data));return r.data}
const docs=[
 ['材料工具','青禾陶艺工坊提供陶土、围裙、颜料和制作工具，全部包含在体验费用内，学员无需自备器材。'],
 ['作品领取与寄送','成品需要烧制，约十四天后完成。顾客可到店领取，也可选择快递到家；邮寄服务每件二十元，不包含在课程费用内。'],
 ['基础与进阶体验','基础手捏体验每位129元，时长两小时，适合零基础。费用包括材料、工具、老师指导及一件作品的烧制。进阶拉坯体验每位199元，时长两小时。没有团购折扣。'],
 ['营业与到店','每日九点至十八点营业。周末课程需提前一天预约，具体余位由人工核实。'],
 ['停车说明','门店没有专用停车场，可乘地铁到达。'],
 ['退款与改期','开课二十四小时前可申请改期，由工作人员核实。退款需人工处理。'],
 ['特殊包装','这是包装资料。'.repeat(100)+'赠送时可选牛皮纸礼盒，价格为每盒十五元，需提前告知。'],
]
const ids=[];for(const [title,body] of docs)ids.push((await call('POST','/knowledge',{title,body,enabled:true})).id)
while(app.stats().knowledgeIndex.pending)await call('POST','/knowledge/index',{})
for(const [query,expected] of [['空着手过去就行吧，不用带装备？',0],['烧好以后能送到我家吗？',1],['没碰过泥巴的小白选哪个？',2],['送人可以配牛皮纸礼盒吗？多少钱？',6],['汽车发动机火花塞怎么更换？',-1]]){
 const result=await call('POST','/knowledge/search',{query});console.log(JSON.stringify({query,mode:result.mode,provider:result.provider,hits:result.list.map(k=>({title:k.title,match:k.match,similarity:k.similarity}))}));
 assert.equal(result.mode,'hybrid');if(expected>=0)assert.equal(result.list[0]?.id,ids[expected]);else assert.equal(result.list.length,0)
}
const before=app.stats().knowledgeIndex.ready
await call('PATCH','/knowledge/'+ids[0],{body:'青禾工坊已取消现场提供工具，请自备围裙和制作工具。',expectedVersion:1})
assert.equal(app.stats().knowledgeIndex.ready,before-1)
await call('POST','/knowledge/index',{})
assert.equal((await call('POST','/knowledge/search',{query:'需要自己带工具吗？'})).list[0].version,2)
await call('PATCH','/knowledge/'+ids[0],{enabled:false,expectedVersion:2})
assert.ok(!(await call('POST','/knowledge/search',{query:'需要自己带工具吗？'})).list.some(k=>k.id===ids[0]))
console.log('真实本地向量：同义表达、负样本、版本失效、重建、停用验证通过。')
db.close()
