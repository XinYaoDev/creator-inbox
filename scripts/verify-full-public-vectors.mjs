// Real, full public corpus through the same indexing and retrieval handlers as
// the desktop app. No stub embeddings, repeated filler or customer database.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {monitorEventLoopDelay} from 'node:perf_hooks';
process.env.GROWTH_EMBEDDING_CACHE=path.resolve('data/model-cache');
const require=createRequire(import.meta.url),{createGrowth}=require('../server/growth.js');
const root=path.resolve('data/large-source-acceptance-20261018'),directory=process.argv[2]?path.resolve(process.argv[2]):await fsp.mkdtemp(path.join(root,'full-vectors-'));
await fsp.mkdir(directory,{recursive:true});
const dbPath=path.join(directory,'inbox.db'),db=new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA busy_timeout=5000');
const app=createGrowth({db,modelConfig:()=>({embeddingProvider:'local',embeddingMinScore:.4}),readBody:async r=>r.body,sendJson:(r,status,data)=>Object.assign(r,{status,data})});
const call=async(method,p,body)=>{const r={};await app.handle({method,body},r,new URL('http://local/api/growth'+p));if(r.status>=400)throw Error(JSON.stringify(r.data));return r.data;};
const save=(name,data)=>fsp.writeFile(path.join(directory,name),JSON.stringify(data,null,2));
const source=path.join(root,'SQuAD2-公开问答全量.jsonl'),hash=createHash('sha256');let records=0;
const existing=db.prepare("SELECT count(*) n FROM growth_records WHERE kind='knowledge'").get().n;
console.log(JSON.stringify({phase:'start',directory,dbPath,existing}));
db.exec('BEGIN');
for await(const line of readline.createInterface({input:fs.createReadStream(source),crlfDelay:Infinity})){
  hash.update(line+'\n');
  if(!existing)app.put('knowledge',{...JSON.parse(line),enabled:true,version:1},'public-'+records);
  if(++records%1000===0){db.exec('COMMIT; BEGIN');if(records%20000===0)console.log(JSON.stringify({phase:existing?'validate-source':'seed',records}));}
}
db.exec('COMMIT');
if(records!==130319||(existing&&existing!==records))throw Error('Full public corpus count mismatch');
const sourceSha256=hash.digest('hex');
if(sourceSha256!=='f853d683d995d68b4596d16c427064cd98587408372cbaeb02c54a1936efdda0')throw Error('Public corpus SHA mismatch');
let index=await call('GET','/knowledge/index'),lastLog=0;
while(db.prepare('SELECT count(*) n FROM growth_search_dirty').get().n){
  await new Promise(r=>setTimeout(r,1000));if(Date.now()-lastLog>10000){lastLog=Date.now();console.log(JSON.stringify({phase:'prepare',remaining:db.prepare('SELECT count(*) n FROM growth_search_dirty').get().n}));}
}
index=await call('GET','/knowledge/index');
const previousJob=index.job,begin=Date.now(),initialReady=index.ready,lag=monitorEventLoopDelay({resolution:20});lag.enable();
await save('source.json',{records,sourceSha256,previousJob,initialReady,startedAt:new Date(begin).toISOString(),directory});
console.log(JSON.stringify({phase:'build',index}));
if(index.pending)await call('POST','/knowledge/index-jobs',{action:'resume'});
const stopAfter=Number(process.env.VECTOR_ACCEPTANCE_STOP_AFTER||0);
while(index.pending||['running','pausing'].includes(index.job?.status)){
  await new Promise(r=>setTimeout(r,10000));index=await call('GET','/knowledge/index');
  const report={phase:'build',records,total:index.total,ready:index.ready,pending:index.pending,indexedThisRun:index.ready-initialReady,elapsedSeconds:Math.round((Date.now()-begin)/1000),perSecond:(index.ready-initialReady)/((Date.now()-begin)/1000),rssMiB:process.memoryUsage().rss/1024**2,maxRssMiB:process.resourceUsage().maxRSS/1024,eventLoopP95Ms:lag.percentile(95)/1e6,status:index.job?.status};
  console.log(JSON.stringify(report));await save('progress.json',report);
  if(['failed','paused','interrupted'].includes(index.job?.status))throw Error('Index job stopped: '+JSON.stringify(index.job));
  if(stopAfter&&index.ready-initialReady>=stopAfter){await save('interruption.json',{...report,method:'Intentional process exit after committed batches, no graceful pause; resume must report interrupted and retain vectors.'});process.exit(75);}
}
const built={records,sourceSha256,index,initialReady,indexedThisRun:index.ready-initialReady,elapsedSeconds:(Date.now()-begin)/1000,completedAt:new Date().toISOString(),maxRssMiB:process.resourceUsage().maxRSS/1024,eventLoopP95Ms:lag.percentile(95)/1e6,vectorDocuments:db.prepare('SELECT count(DISTINCT knowledgeId) n FROM growth_vector_blobs').get().n,binaryBytes:db.prepare('SELECT sum(length(bytes)) n FROM growth_vector_blobs').get().n};
await save('build-report.json',built);console.log(JSON.stringify({phase:'completed',...built}));
lag.disable();db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
