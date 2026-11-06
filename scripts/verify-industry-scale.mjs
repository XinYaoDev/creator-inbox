import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync} from 'node:fs'
import {corpus,industries,holdoutQueries,negativeHoldout} from './industry-fixtures.mjs'
const base='http://127.0.0.1:18879/api/growth',out=new URL('../data/growth-industry-scale-20261018/',import.meta.url)
mkdirSync(out,{recursive:true})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function call(path,body,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)}),data=await r.json();assert.ok(r.ok,`${path}: ${JSON.stringify(data)}`);return data
}
const {docs,cases}=corpus(),mode=process.argv[2]||'seed'
if(mode==='retrieval')cases.push(...holdoutQueries,...negativeHoldout)
if(mode==='seed'){
 const state=await call('/state');assert.equal(state.knowledge.length,0,'Only seed a fresh isolated acceptance database');assert.equal(state.stats.total,0)
 await call('/model',{provider:'hermes-codex',model:'gpt-6.1-sol',embeddingProvider:'local',embeddingMinScore:.4},'PATCH')
 for(let start=0;start<docs.length;start+=200){
  const imported=await call('/knowledge/import',{format:'json',filename:'合成行业规模验收.json',content:JSON.stringify(docs.slice(start,start+200))});assert.equal(imported.added,Math.min(200,docs.length-start));
  for(let i=0;i<imported.items.length;i+=100)await call('/knowledge/batch',{action:'enable',items:imported.items.slice(i,i+100).map(k=>({id:k.id,expectedVersion:k.version}))});
  console.log(JSON.stringify({imported:Math.min(start+200,docs.length),total:docs.length}));
 }
 await call('/knowledge/index-jobs',{action:'start'});console.log('Background index started; this client now exits.');
}
if(mode==='retrieval'){
 const initial=await call('/knowledge/index');assert.equal(initial.pending,0,'Wait until background indexing completes');
 const results=[];let heartbeatMax=0;const times=[];
 for(const entry of cases){const start=performance.now(),found=await call('/knowledge/search',{query:entry.query,categories:entry.category?[entry.category]:[]}),ms=performance.now()-start;times.push(ms);
  const rank=entry.expectedTitle?found.list.findIndex(k=>k.title===entry.expectedTitle)+1:0;
  results.push({...entry,ms,mode:found.mode,rank,pass:entry.type.startsWith('negative')?found.list.length===0:rank>0,hits:found.list.map(k=>({title:k.title,match:k.match,similarity:k.similarity}))});
  const tick=performance.now();await call('/knowledge/index');heartbeatMax=Math.max(heartbeatMax,performance.now()-tick);
  console.log(JSON.stringify({n:results.length,type:entry.type,pass:results.at(-1).pass,rank,ms:Math.round(ms)}));
 }
 const warm=[];for(const entry of cases.slice(0,24)){const body={query:entry.query,categories:[entry.category]};await call('/knowledge/search',body);const t=performance.now();await call('/knowledge/search',body);warm.push(performance.now()-t)}
 const concurrent=[],statusConcurrent=[];await Promise.all([...[0,1,2,3].map(async worker=>{for(let i=0;i<10;i++){const entry=cases[worker*12+i],t=performance.now();await call('/knowledge/search',{query:entry.query,categories:[entry.category]});concurrent.push(performance.now()-t)}}),(async()=>{for(let i=0;i<20;i++){const t=performance.now();await call('/knowledge/index');statusConcurrent.push(performance.now()-t);await sleep(5)}})()]);
 const metrics={};for(const type of ['semantic','identifier','negative','holdout','negative_holdout']){const list=results.filter(r=>r.type===type);metrics[type]={count:list.length,passed:list.filter(r=>r.pass).length,recallAt4:type.startsWith('negative')?undefined:list.filter(r=>r.rank>0).length/list.length,mrr:type.startsWith('negative')?undefined:list.reduce((n,r)=>n+(r.rank?1/r.rank:0),0)/list.length}}
 const percentile=(v,p)=>[...v].sort((a,b)=>a-b)[Math.floor((v.length-1)*p)];
 const report={at:new Date().toISOString(),corpus:docs.length,index:initial,metrics,latency:{uncachedQueryP50:percentile(times,.5),uncachedQueryP95:percentile(times,.95),warmP50:percentile(warm,.5),warmP95:percentile(warm,.95),statusMaxMs:heartbeatMax,concurrentClients:4,concurrentRequests:concurrent.length,concurrentP95:percentile(concurrent,.95),concurrentStatusP95:percentile(statusConcurrent,.95)},results};
 writeFileSync(new URL('retrieval-report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify({metrics,latency:report.latency}));
 if(results.some(r=>!r.pass))process.exitCode=1;
}
if(mode==='sales'){
 const results=[];
 for(const industry of industries){
  const agent=await call('/agent',{name:industry.brand+' · 行业验收',brand:industry.brand+'，这是合成商户测试，不是真实业务。',role:'提供准确、尊重顾客的接待服务。',instructions:'只根据所选知识回答，未知实际执行交人工；普通咨询继续接待。',style:'自然简洁中文。',enabled:true,welcomeEnabled:false,channels:['sandbox','web'],knowledgeCategories:[industry.category],maxLength:500,collectEnabled:true,salesEnabled:true,salesScenario:industry.id,salesMaxTurns:20});
  const prompts=[industry.initial,industry.details,industry.correction,'价格方面我有些担心，感觉预算压力比较大。','我暂时先不考虑了，先别继续问。','我想继续了解，价格顾虑已经解决了。预算不想说，也不想留电话或微信。','我同意把需求交给人工同事核实具体安排。'];
  let conversation;const turns=[];
  for(const [i,content] of prompts.entries()){
   if(i&&conversation.status!=='ai'){turns.push({content,skipped:'前一轮已转人工，未强行交回AI'});break;}
   const t=performance.now();conversation=await call(i?'/conversations/'+conversation.id+'/incoming':'/sandbox',i?{content}:{name:industry.brand+' 合成访客',agentId:agent.id,content});
   const detail=await call('/conversations/'+conversation.id);turns.push({content,ms:performance.now()-t,status:conversation.status,sales:conversation.salesState,reply:detail.messages.filter(m=>m.role==='ai').at(-1),summary:detail.salesSummary});
   console.log(JSON.stringify({industry:industry.id,turn:i+1,status:conversation.status,phase:conversation.salesState?.phase,reply:turns.at(-1).reply?.content}));
  }
  const final=await call('/conversations/'+conversation.id),checks={allTurns:turns.filter(t=>t.reply).length===7,correction:final.conversation.salesState?.facts[industry.field]?.value.includes(industry.expected)||false,paused:turns[4]?.sales?.paused===true,noContact:final.conversation.salesState?.noContact===true,handoff:final.conversation.status==='human',notConverted:final.lead?.stage==='new',realModel:turns.filter(t=>t.reply).every(t=>t.reply.source==='model'&&t.reply.model==='gpt-6.1-sol')};
  const unknown=await call('/sandbox',{name:industry.brand+' 未知执行验收',agentId:agent.id,content:industry.uncertain}),unknownDetail=await call('/conversations/'+unknown.id);
  checks.unknownExecutionHandoff=unknown.status==='human';checks.noFalseConversion=unknownDetail.lead?.stage==='new';checks.noUnsupportedRetraction=!turns.some(t=>/此前.{0,40}(缺乏|缺少|没有).{0,16}(依据|资料|支持)/.test(t.reply?.content||''));
  results.push({industry:industry.id,agentId:agent.id,conversationId:conversation.id,checks,turns,unknown:{conversationId:unknown.id,content:industry.uncertain,reply:unknownDetail.messages.filter(m=>m.role==='ai').at(-1)}});writeFileSync(new URL('sales-report.json',out),JSON.stringify({at:new Date().toISOString(),results},null,2));
  await sleep(100);
 }
 console.log(JSON.stringify(results.map(r=>({industry:r.industry,checks:r.checks}))));
 if(results.some(r=>Object.values(r.checks).some(v=>!v)))process.exitCode=1;
}
