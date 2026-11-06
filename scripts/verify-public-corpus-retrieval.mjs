// Run against the real public corpus in a fresh, isolated database; never a customer DB.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url),{createGrowth}=require('../server/growth.js');
const root=path.resolve('data/large-source-acceptance-20261018'),reuse=process.argv[2],directory=reuse?path.resolve(reuse):await fsp.mkdtemp(path.join(root,'retrieval-'));
const dbPath=path.join(directory,'public-corpus.db'),db=new DatabaseSync(dbPath);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768');
const app=createGrowth({db,sendJson:(r,status,data)=>Object.assign(r,{status,data}),readBody:async r=>r.body,modelConfig:()=>({embeddingProvider:'disabled'})});
const call=async(method,p,body)=>{const r={};await app.handle({method,body},r,new URL('http://local/api/growth'+p));if(r.status>=400)throw Error(JSON.stringify(r.data));return r.data};
let count=0;const samples=[],start=performance.now();
db.exec('BEGIN');
for await(const line of readline.createInterface({input:fs.createReadStream(path.join(root,'SQuAD2-公开问答全量.jsonl')),crlfDelay:Infinity})){
  const k=JSON.parse(line),id='public-'+count;
  if(!reuse)app.put('knowledge',{...k,enabled:true,version:1},id);
  if(count%263===0)samples.push({id,query:k.title.split(' · ').slice(1).join(' · '),code:k.title.split(' · ')[0]});
  if(++count%1000===0){db.exec('COMMIT; BEGIN');if(count%20000===0)console.log(JSON.stringify({phase:reuse?'sample-existing':'seed',count}));}
}
db.exec('COMMIT');const seedMs=performance.now()-start,indexStart=performance.now();let index=await call('GET','/knowledge/index');
while(index.preparing){await new Promise(r=>setTimeout(r,500));index=await call('GET','/knowledge/index');if(index.preparationError)throw Error(index.preparationError);if(index.preparing%5000<100)console.log(JSON.stringify({phase:'index',remaining:index.preparing}));}
const indexMs=performance.now()-indexStart,latencies=[],misses=[];let exactHits=0,naturalHits=0;
for(const sample of samples){
  const begin=performance.now(),result=await call('POST','/knowledge/search',{query:sample.query});latencies.push(performance.now()-begin);
  if(result.list.some(k=>k.id===sample.id))naturalHits++;else if(misses.length<20)misses.push({query:sample.query,expected:sample.id,actual:result.list.map(k=>k.title)});
  const exact=await call('POST','/knowledge/search',{query:sample.code});if(exact.list.some(k=>k.id===sample.id))exactHits++;
  if(latencies.length%50===0)console.log(JSON.stringify({phase:'queries',completed:latencies.length,naturalHits,exactHits}));
}
const sorted=latencies.toSorted((a,b)=>a-b),memory=process.memoryUsage();
const result={directory,dbPath,reusedIndex:!!reuse,records:count,queries:samples.length,naturalTop4:naturalHits,exactIdentifierTop4:exactHits,seedMs,indexMs,queryMs:{p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:Math.max(...sorted)},memory:{rssMiB:memory.rss/1024**2,heapMiB:memory.heapUsed/1024**2,maxRssMiB:process.resourceUsage().maxRSS/1024},index,misses,scope:'Real SQuAD public data; queries sampled from existing document titles. Lexical disk index only, not all-corpus vector quality or unseen semantic paraphrases. When reusedIndex=true seedMs is sampling time and indexMs is reopened-index readiness, not cold construction.'};
await fsp.writeFile(path.join(directory,reuse?'report-optimized.json':'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));db.close();
