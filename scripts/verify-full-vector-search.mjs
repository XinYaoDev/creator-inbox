// Actual HTTP requests, real local BGE query embeddings, full persisted corpus.
// Original questions test lookup/capacity; paraphrases are reported separately.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
process.env.GROWTH_EMBEDDING_CACHE=path.resolve('data/model-cache');
const require=createRequire(import.meta.url),timingContext=new AsyncLocalStorage();
// Measure real stage timings in this harness, without altering product responses.
const diskModule=require('../server/knowledge-disk.js'),createDisk=diskModule.createDiskIndex;
diskModule.createDiskIndex=(options)=>{const d=createDisk(options),rows=d.vectorRows,lexical=d.lexical;d.vectorRows=async function*(...args){const t=performance.now(),timing=timingContext.getStore();try{yield* rows(...args);}finally{if(timing)timing.scanMs=performance.now()-t;}};d.lexical=(...args)=>{const t=performance.now(),result=lexical(...args);const timing=timingContext.getStore();if(timing)timing.lexicalMs=performance.now()-t;return result;};return d;};
const local=require('../server/local-embeddings.js'),embed=local.embed;
local.embed=async(...args)=>{const t=performance.now(),timing=timingContext.getStore();try{return await embed(...args);}finally{if(timing)timing.embeddingMs=performance.now()-t;}};
const {createGrowth}=require('../server/growth.js'),{identifiers}=require('../server/knowledge-cache.js');
const directory=path.resolve(process.argv[2]||''),preliminary=process.argv.includes('--preliminary'),restart=process.argv.includes('--restart-check'),profile=process.argv.includes('--profile'),paraphrasesOnly=process.argv.includes('--paraphrases-only');
if(!directory.includes('large-source-acceptance-20261018/'))throw Error('Use an isolated acceptance corpus, never the customer database');
const db=new DatabaseSync(path.join(directory,'inbox.db'));db.exec('PRAGMA journal_mode=WAL; PRAGMA cache_size=-32768; PRAGMA busy_timeout=5000');
const start=performance.now(),app=createGrowth({db,modelConfig:()=>({embeddingProvider:'local',embeddingMinScore:.4}),readBody:async req=>{let body='';for await(const chunk of req){body+=chunk;if(body.length>16000)throw Error('Test request too big');}return JSON.parse(body||'{}');},sendJson:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data.mode?{...data,timings:timingContext.getStore()}:data));}});
const server=http.createServer((req,res)=>timingContext.run({},async()=>{try{await app.handle(req,res,new URL(req.url,'http://127.0.0.1'));if(!res.writableEnded){res.writeHead(404);res.end();}}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const call=async(p,body,method=body?'POST':'GET')=>{const r=await fetch(origin+'/api/growth'+p,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;};
let initial=await call('/knowledge/index');
while(initial.preparing){await new Promise(r=>setTimeout(r,100));initial=await call('/knowledge/index');if(initial.preparationError)throw Error(initial.preparationError);}
const coldReadyMs=performance.now()-start;
const integrity=db.prepare("SELECT count(*) vectors,count(DISTINCT knowledgeId) documents,min(dimensions) minDimensions,max(dimensions) maxDimensions,sum(length(bytes)) bytes,sum(length(bytes)!=dimensions*4) malformed FROM growth_vector_blobs").get();
const records=db.prepare("SELECT count(*) n FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.enabled')=1").get().n;
if(records!==130319||initial.preparing||initial.total!==300374||(!preliminary&&(initial.ready!==initial.total||initial.pending||integrity.documents!==records)))throw Error('Full corpus is not ready: '+JSON.stringify({records,initial,integrity}));
if(integrity.minDimensions!==512||integrity.maxDimensions!==512||integrity.malformed)throw Error('Invalid binary vectors');
const lag=monitorEventLoopDelay({resolution:20});lag.enable();const results=[],statusChecks=[];
const prefix=preliminary?'preliminary-':restart?'restart-':profile?'profile-':paraphrasesOnly?'paraphrases-':'';
const trace=path.join(directory,prefix+'search-trace.jsonl');
const question=k=>k.title.split(' · ').slice(1).join(' · '),context=k=>/^Context: ([\s\S]*?)\n(?:Annotated answers:|No supported answer)/m.exec(k.body)?.[1];
const get=id=>app.get('knowledge','public-'+id);
async function run(query,kind,expected,extra={}){
  const at=performance.now(),r=await call('/knowledge/search',{query,...extra});
  const hit=expected?r.list.findIndex(k=>k.id===expected.id||k.title.endsWith(' · '+question(expected))||context(app.get('knowledge',k.id))===context(expected)&&!!context(expected))+1:null;
  const fullScan=!identifiers(query).length&&!extra.agentId&&!extra.categories;
  const row={kind,query,expected:expected?.id,hit,ms:performance.now()-at,mode:r.mode,strategy:r.strategy,scanned:r.scanned,fullScan,warning:r.warning||'',pass:r.mode==='hybrid'&&r.strategy==='disk-exact'&&(!fullScan||r.scanned===initial.ready)&&(!expected||hit>0),hits:r.list.map(k=>({id:k.id,title:k.title,match:k.match,similarity:k.similarity,score:k.score}))};
  row.timings=r.timings;results.push(row);await fs.appendFile(trace,JSON.stringify(row)+'\n');
  console.log(JSON.stringify({n:results.length,kind,pass:row.pass,ms:Math.round(row.ms),scanned:r.scanned,hit,timings:r.timings}));return {row,response:r};
}
const samples=Array.from({length:preliminary?24:200},(_,i)=>get(Math.floor(i*(130319/(preliminary?24:200)))));
const paraphrases=[
 [0,'During which decade did Beyonce become famous?'],
 [10,'What is the name of the debut solo album by Beyoncé?'],
 [2000,'Who held the Chief Financial Officer position at Apple in July 2009?'],
 [10000,'Which company invented track lighting?'],
 [40000,'How much RAM came standard with most Mac models in this passage?'],
 [100000,'Which levels of study belong to tertiary education?'],
 [120000,'Which animal helped tribes expand their territories and capture game?'],
];
try{
  if(paraphrasesOnly){for(const [id,q] of paraphrases)await run(q,'paraphrase-diagnostic',get(id));}
  else if(profile){for(const id of [0,651,8470,11728,19547,651])await run(question(get(id)),'profile-stage',get(id));}
  else if(restart){await run(question(get(10000)),'restart',get(10000));}
  else{
    for(const k of samples)await run(question(k),'original-question',k);
    for(const [id,q] of paraphrases)await run(q,'paraphrase-diagnostic',get(id));
    for(let wave=0;wave<(preliminary?1:4);wave++){
      let polling=true;const poll=(async()=>{while(polling){const at=performance.now();await call('/knowledge/index');statusChecks.push(performance.now()-at);await new Promise(r=>setTimeout(r,250));}})();
      await Promise.all(samples.slice(wave*4,wave*4+4).map(k=>run(question(k),'concurrent-4',k)));polling=false;await poll;
    }
    // Real category and employee scopes are enforced before returning hits.
    const k=get(10000),category=k.category;
    await run(question(k),'category',k,{categories:[category]});
    const excluded=await call('/knowledge/search',{query:question(k),categories:['__not_present_acceptance__']});
    if(excluded.list.length)throw Error('Category isolation failed');
    const agent=await call('/agent',{name:'Full-vector isolated acceptance',enabled:false,knowledgeIds:[k.id],knowledgeCategories:[],prompt:'Use only approved knowledge.'});
    const scoped=await run(question(k),'employee-scope',k,{agentId:agent.id});if(scoped.response.list.some(x=>x.id!==k.id))throw Error('Employee scope leak');
    if(!preliminary&&!(scoped.response.scanned>0&&scoped.response.scanned<initial.ready))throw Error('Employee scope did not perform a bounded real vector scan');
    // Mutation + reload do not delete old binary rows, but old vectors must
    // never remain eligible. Restore source facts and rebuild only changed keys.
    const original={...k};await call('/knowledge/'+k.id,{enabled:false,expectedVersion:k.version},'PATCH');
    const disabled=await call('/knowledge/search',{query:question(k),agentId:agent.id});if(disabled.list.length)throw Error('Disabled knowledge leaked');
    let current=app.get('knowledge',k.id);await call('/knowledge/'+k.id,{enabled:true,body:'Updated acceptance-only explanation; old source text must not be returned.',expectedVersion:current.version},'PATCH');
    const changed=await call('/knowledge/search',{query:question(k),agentId:agent.id});if(changed.list.some(x=>x.body.includes('Lightolier')))throw Error('Old knowledge content leaked');
    current=app.get('knowledge',k.id);await call('/knowledge/'+k.id,{body:original.body,enabled:true,expectedVersion:current.version},'PATCH');
    await call('/knowledge/index');
    while(db.prepare('SELECT count(*) n FROM growth_search_dirty').get().n)await new Promise(r=>setTimeout(r,100));
    const restored=await call('/knowledge/index');if(restored.ready!==initial.ready||restored.pending!==initial.pending)throw Error('Restored unchanged fingerprint did not reuse exact vectors');
    await run(question(k),'restored-source',original,{agentId:agent.id});
  }
  const percentile=(xs,p)=>xs.length?xs.toSorted((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]:null;
  const groups=Object.fromEntries([...new Set(results.map(r=>r.kind))].map(kind=>{const rs=results.filter(r=>r.kind===kind);return [kind,{total:rs.length,passed:rs.filter(r=>r.pass).length,p50:percentile(rs.map(r=>r.ms),.5),p95:percentile(rs.map(r=>r.ms),.95),max:Math.max(...rs.map(r=>r.ms))}]}));
  const report={scope:preliminary?'PARTIAL VECTOR PREVIEW, NOT FULL ACCEPTANCE':restart?'Fresh-process restart of the fully indexed public corpus':'Full real public corpus and BGE embeddings through actual loopback HTTP. Original questions are in the indexed titles; paraphrases are a separate small diagnostic, not independent production quality certification.',records,initial,integrity,coldReadyMs,groups,total:results.length,fullScans:results.filter(r=>r.fullScan&&r.scanned===initial.ready).length,statusChecks:{count:statusChecks.length,p95:percentile(statusChecks,.95),max:statusChecks.length?Math.max(...statusChecks):null},maxRSSMiB:process.resourceUsage().maxRSS/1024,eventLoopP95Ms:lag.percentile(95)/1e6,elapsedSeconds:(performance.now()-start)/1000,completedAt:new Date().toISOString(),results};
  if(profile)report.scope='Small real full-corpus stage profiling; does not replace the full 200-question stress acceptance.';
  if(paraphrasesOnly)report.scope='Small paraphrase diagnosis over all real vectors; not full stress acceptance.';
  await fs.writeFile(path.join(directory,prefix+'search-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined,initial:undefined}));
  if(results.some(r=>!r.pass&&r.kind!=='paraphrase-diagnostic'))process.exitCode=1;
}finally{lag.disable();await new Promise(r=>server.close(r));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();}
