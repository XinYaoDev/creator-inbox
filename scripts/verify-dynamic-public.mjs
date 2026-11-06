// Live public-site verification, distinct from the renderer's adversarial fixtures.
import fsp from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';import {DatabaseSync} from 'node:sqlite';
const require=createRequire(import.meta.url),{createGrowth}=require('../server/growth.js');
const directory=await fsp.mkdtemp(path.resolve('data/large-source-acceptance-20261018/dynamic-public-')),db=new DatabaseSync(path.join(directory,'inbox.db'));
const app=createGrowth({db,readBody:async r=>r.body,sendJson:(r,status,data)=>Object.assign(r,{status,data})});
const call=async(method,p,body)=>{const r={};await app.handle({method,body},r,new URL('http://local/api/growth'+p));if(r.status>=400)throw Error(JSON.stringify(r.data));return r.data;};
const results=[];
for(const item of [{url:'https://quotes.toscrape.com/js/',renderMode:'static',expectRendered:false},{url:'https://quotes.toscrape.com/js/',renderMode:'auto',expectRendered:true},{url:'https://quotes.toscrape.com/js-delayed/?delay=10000',renderMode:'auto',expectRendered:true,minMs:10000},{url:'https://docsify.js.org/#/quickstart',renderMode:'auto',expectRendered:true}]){
  const start=Date.now(),job=await call('POST','/knowledge/web',{...item,maxPages:1,maxDepth:0});let result;
  do{await new Promise(r=>setTimeout(r,1000));result=await call('GET','/knowledge/web/'+job.id);}while(['queued','running'].includes(result.status));
  const body=result.items?.map(i=>i.body).join('\n')||'';
  const contentMatches=item.url.includes('docsify')?/docsify init/.test(body)&&result.pages[0]?.url.endsWith('#/quickstart'):/Albert Einstein/.test(body);
  const pass=item.expectRendered?result.status==='completed'&&result.pages[0]?.rendered===true&&body.length>200&&contentMatches&&(!item.minMs||result.pages[0].renderWaitMs>=item.minMs):result.status==='failed'&&!body&&!result.pages.some(p=>p.rendered);
  const r={...item,pass,elapsedMs:Date.now()-start,status:result.status,pages:result.pages,robotsChecks:result.robotsChecks,characters:body.length,hasAuthor:/Albert Einstein/.test(body),hasDocsifyInit:/docsify init/.test(body),jobId:job.id};
  results.push(r);await fsp.writeFile(path.join(directory,'report.json'),JSON.stringify({directory,results},null,2));console.log(JSON.stringify(r));
  if(pass&&item.expectRendered){const saved=await call('POST','/knowledge/web/'+job.id+'/import',{items:result.items,update:false});console.log(JSON.stringify({phase:'import',...saved,items:undefined}));}
}
const report={directory,results,knowledge:db.prepare("SELECT count(*) total,sum(json_extract(data,'$.enabled')) enabled FROM growth_records WHERE kind='knowledge'").get(),scope:'Live external public JavaScript pages plus one static negative comparison. No site login, form submission, external messages or model calls.'};await fsp.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,passed:results.filter(r=>r.pass).length,total:results.length}));db.close();if(results.some(r=>!r.pass))process.exitCode=1;
