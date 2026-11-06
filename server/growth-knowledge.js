'use strict';
const {createHash}=require('node:crypto');
const localEmbeddings=require('./local-embeddings.js');
const {createCache,identifiers,matchesIdentifier,expansion}=require('./knowledge-cache.js');
const yieldEventLoop=()=>new Promise(resolve=>setImmediate(resolve));
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,max=30000)=>String(v??'').trim().slice(0,max);
function sourceMeta(value){
  if(!value||!['web','ocr','pdf','file'].includes(value.kind))return undefined;
  const meta={kind:value.kind};
  if(value.kind==='web'){let u;try{u=new URL(value.url);}catch{fail('知识来源 URL 无效');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('知识来源 URL 无效');meta.url=u.href.slice(0,2000);meta.part=Math.max(1,Math.min(200,Number(value.part)||1));}
  if(value.filename)meta.filename=text(value.filename,200);
  if(value.kind==='file'){meta.importId=text(value.importId,100);meta.row=Math.max(1,Math.floor(Number(value.row)||1));if(/^[a-f0-9]{64}$/.test(value.sha256||''))meta.sha256=value.sha256;}
  if(value.page)meta.page=Math.max(1,Math.min(80,Number(value.page)||1));
  if(Number.isFinite(value.confidence))meta.confidence=Math.max(0,Math.min(100,value.confidence));
  if(Number.isFinite(value.fetchedAt))meta.fetchedAt=value.fetchedAt;
  return meta;
}

function csvRows(source) {
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  source=source.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(quoted){if(c==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)fail('CSV 引号格式错误');quoted=true;}
    else if(c===','||c==='\n'){row.push(cell);cell='';closed=false;if(c==='\n'){if(row.some(x=>x.trim()))rows.push(row);row=[];}}
    else {if(closed&&!/\s/.test(c))fail('CSV 引号后存在多余字符');if(!closed)cell+=c;}
  }
  if(quoted)fail('CSV 引号未闭合');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  return rows;
}
function parseImport({format,content,filename='导入文档',category='导入资料'}) {
  if(typeof content!=='string'||!content.trim())fail('导入内容不能为空');
  if(Buffer.byteLength(content,'utf8')>700000)fail('单次导入最多 700 KB UTF-8 文本');
  let items;
  if(format==='json'){
    try{items=JSON.parse(content);}catch{fail('JSON 解析失败，请使用条目数组');}
    if(!Array.isArray(items))fail('JSON 必须为 [{title,body,category}] 数组');
  } else if(format==='csv'){
    const [header,...rows]=csvRows(content);if(!header)fail('CSV 没有表头');
    const aliases={title:['title','标题','问题'],body:['body','内容','答案'],category:['category','分类']};
    const idx=Object.fromEntries(Object.entries(aliases).map(([k,names])=>[k,header.findIndex(v=>names.includes(v.trim().toLowerCase()))]));
    if(idx.title<0||idx.body<0)fail('CSV 必须有 title / body 或 标题 / 内容 列');
    items=rows.map((r,i)=>{if(r.length!==header.length)fail('CSV 第 '+(i+2)+' 行列数不一致');return {title:r[idx.title],body:r[idx.body],category:idx.category<0?category:r[idx.category]};});
  } else if(['txt','md'].includes(format)){
    // Plain text is never executed or treated as remote instructions.
    const title=text(filename.replace(/\.(txt|md)$/i,''),170)||'导入文档';
    items=[];
    for(let i=0;i<content.length;i+=12000)items.push({title:title+(content.length>12000?' · 第 '+(i/12000+1)+' 部分':''),body:content.slice(i,i+12000),category});
  } else fail('支持 TXT、Markdown、CSV 和 JSON 文本；PDF / 图片请先提取文字');
  if(!items.length||items.length>200)fail('单次导入需要 1–200 条知识');
  return items.map((k,i)=>{
    if(!k||typeof k!=='object'||Array.isArray(k)||!String(k.title||'').trim()||!String(k.body||'').trim())fail('第 '+(i+1)+' 条缺少标题或内容');
    if(String(k.body).length>30000)fail('第 '+(i+1)+' 条超过 30000 字，请拆分');
    return {title:text(k.title,200),body:text(k.body),category:text(k.category||category,100),enabled:false,...(sourceMeta(k.sourceMeta)?{sourceMeta:sourceMeta(k.sourceMeta)}:{})};
  });
}
const fingerprint=k=>hash(k.title+'\n'+k.body);
function chunks(k,local=false){
  const parts=[],add=body=>{if(body.trim())parts.push({knowledgeId:k.id,index:parts.length,body:body.trim(),title:k.title});};
  if(!local){for(let start=0;start<k.body.length;start+=1600)add(k.body.slice(start,start+1800));return parts;}
  // English characters are not Chinese tokens. Keep ordinary English sentences
  // together instead of multiplying one paragraph into dozens of tiny windows.
  // Mixed/Chinese text retains the calibrated short windows below.
  if((k.body.match(/[\p{Script=Han}]/gu)||[]).length<k.body.length*.08){
    let pending='';
    for(const sentence of k.body.split(/(?<=[.!?])\s+|\n+/u)){
      if(pending.length+sentence.length>640){add(pending);pending='';}
      if(sentence.length>640){for(let start=0;start<sentence.length;start+=560)add(sentence.slice(start,start+640));}
      else pending+=(pending?' ':'')+sentence;
    }
    add(pending);return parts;
  }
  // Short sentence windows keep exceptions, specifications and policy details
  // from being buried in a vector dominated by the first topic of a paragraph.
  let pending='';
  for(const sentence of k.body.split(/(?<=[。！？；\n])/u)){
    if(pending.length+sentence.length>160){add(pending);pending='';}
    if(sentence.length>160){for(let start=0;start<sentence.length;start+=140)add(sentence.slice(start,start+160));}
    else pending+=sentence;
    if(pending.length>=80){add(pending);pending='';}
  }
  add(pending);return parts;
}
function cosine(a,b){if(a.length!==b.length)return -1;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?dot/Math.sqrt(aa*bb):-1;}

// Preserve strong literal evidence when a language-specific embedding model
// gives unrelated foreign-language passages deceptively similar scores. This
// boosts actual matching titles, not the top keyword hit merely by its rank.
function literalTitleScore(query,title){
  const normalize=s=>String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const q=normalize(query),t=normalize(title);
  if(q.length>=8&&(t===q||t.endsWith(' '+q)))return .99;
  if(/[\p{Script=Han}]/u.test(q))return 0;
  const stop=new Set('a an the is are was were be been being do does did of in on at to for from by with and or that this these those what which who whom whose when where why how many much can could would should have has had it its as into about during after before please tell me'.split(' '));
  const words=[...new Set(q.split(' ').filter(w=>w.length>1&&!stop.has(w)))],titleWords=new Set(t.split(' '));
  if(words.length<2)return 0;
  const matched=words.filter(w=>titleWords.has(w)).length,coverage=matched/words.length;
  return coverage>=.75||matched>=3&&coverage>=.6?.45+.45*coverage:0;
}

// Lexical BM25 and cosine are not comparable confidence scales. In a large
// corpus a valid keyword candidate must not disappear simply because unrelated
// vectors all score above the old fixed keyword ceiling. Fuse independent ranks
// after relevance/scope filtering; retain literal-title evidence and the actual
// cosine separately. These ordering scores are not answer probabilities.
function fuseDiskRanks(query,semantic,lexical){
  const merged=new Map();
  semantic.forEach((k,i)=>merged.set(k.id,{...k,score:30/(61+i)}));
  lexical.forEach((k,i)=>{
    const hit=merged.get(k.id),rank=30/(61+i),literal=literalTitleScore(query,k.title);
    if(hit){hit.score=Math.max(hit.score+rank,literal);hit.match='hybrid';}
    else merged.set(k.id,{...k,score:Math.max(rank,literal),match:'keyword'});
  });
  return [...merged.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,4);
}

function createKnowledge({db,all,get,put,validate,event,actor,clock,retrieve,embeddingCall,config}) {
  const configNow=()=>{const c=config(),provider=c.embeddingProvider||((c.embeddingsEnabled??process.env.GROWTH_EMBEDDINGS_ENABLED==='1')||embeddingCall?'api':'disabled');return {...c,embeddingProvider:provider,embeddingModel:provider==='local'?localEmbeddings.ID:c.embeddingModel||process.env.GROWTH_EMBEDDING_MODEL||'text-embedding-3-small'};};
  const canEmbed=(c=configNow())=>!!embeddingCall||c.embeddingProvider==='local'||(c.embeddingProvider==='api'&&!!c.key);
  const signature=c=>c.embeddingProvider+'|'+(c.embeddingProvider==='local'?'local':c.base)+'|'+c.embeddingModel+'|'+(c.embeddingProvider==='local'?'sentence-chunks-v4-language':'chunks-v2');
  const version=k=>k.version||1;
  const chunkKey=(k,chunk,c=configNow(),fp=fingerprint(k))=>hash(signature(c)+'|'+k.id+'|'+fp+'|'+chunk.index);
  const cache=createCache({db,all,chunks,chunkKey,fingerprint});
  db.exec("CREATE INDEX IF NOT EXISTS growth_knowledge_title ON growth_records(json_extract(data,'$.title')) WHERE kind='knowledge'");
  const alreadyExists=k=>!!db.prepare("SELECT 1 FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.title')=? AND json_extract(data,'$.body')=? LIMIT 1").get(k.title,k.body);
  function save(input,id){
    const previous=id?get('knowledge',id):null;if(id&&!previous)fail('知识不存在',404);
    if(previous&&input.expectedVersion!==undefined&&Number(input.expectedVersion)!==version(previous))fail('知识已被其他人更新，请重新打开后编辑',409);
    const validated=validate('knowledge',input,previous||{});
    if(previous?.archived&&input.archived!==false&&validated.enabled)fail('归档知识需先恢复后启用');
    const data={...validated,archived:input.archived===undefined?!!previous?.archived:!!input.archived,version:previous?version(previous)+1:1,source:previous?.source||text(input.source||'手动录入',200),sourceMeta:sourceMeta(input.sourceMeta)||previous?.sourceMeta};
    if(data.archived)data.enabled=false;
    db.exec('SAVEPOINT growth_knowledge_save');
    try{
      if(previous&&!db.prepare("SELECT 1 FROM growth_records WHERE kind='knowledgeRevision' AND json_extract(data,'$.knowledgeId')=? AND json_extract(data,'$.version')=? LIMIT 1").get(id,version(previous)))put('knowledgeRevision',{knowledgeId:id,version:version(previous),snapshot:previous,actor:'历史记录'});
      const current=put('knowledge',data,id);
      put('knowledgeRevision',{knowledgeId:current.id,version:current.version,snapshot:current,actor:actor.getStore()?.name||'系统'});
      event('',previous?'知识更新':'知识创建',current.title+' / v'+current.version);
      db.exec('RELEASE growth_knowledge_save');return current;
    }catch(e){db.exec('ROLLBACK TO growth_knowledge_save');db.exec('RELEASE growth_knowledge_save');throw e;}
  }
  function previewImport(body){
    const seen=new Set();
    const items=parseImport(body).map(k=>{const key=fingerprint(k),duplicate=seen.has(key)||alreadyExists(k);seen.add(key);return {...k,duplicate};});
    return {items,added:items.filter(k=>!k.duplicate).length,skipped:items.filter(k=>k.duplicate).length};
  }
  function commitImport(body){
    const preview=previewImport(body);let added=[];
    db.exec('SAVEPOINT growth_knowledge_import');
    try{for(const k of preview.items.filter(k=>!k.duplicate))added.push(save({...k,source:text(body.filename||'批量导入',200)}));db.exec('RELEASE growth_knowledge_import');}
    catch(e){db.exec('ROLLBACK TO growth_knowledge_import');db.exec('RELEASE growth_knowledge_import');throw e;}
    return {added:added.length,skipped:preview.skipped,items:added};
  }
  function commitWebImport(items,{update,fetchedAt}){
    // Validate the entire batch and all expected revisions before the first write.
    const validated=parseImport({format:'json',content:JSON.stringify(items)});
    const seen=new Set();
    const plans=validated.map((k,i)=>{
      const original=items[i],previous=update&&original.existingId?get('knowledge',original.existingId):null;
      if(previous&&(previous.sourceMeta?.url!==original.url||previous.sourceMeta?.part!==original.part))fail('网页来源不匹配',409);
      if(previous&&fingerprint(previous)!==fingerprint(k)&&(previous.archived||version(previous)!==original.expectedVersion))fail('网页知识已被修改或归档，请重新采集后再更新',409);
      if(seen.has(fingerprint(k))||alreadyExists(k))return null;seen.add(fingerprint(k));
      return {k:{...k,source:original.url,sourceMeta:{kind:'web',url:original.url,part:original.part,fetchedAt},enabled:false},previous};
    });
    let added=0,updated=0,skipped=0;db.exec('SAVEPOINT web_knowledge_import');
    try{for(const plan of plans){if(!plan){skipped++;continue;}save({...plan.k,...(plan.previous?{expectedVersion:version(plan.previous)}:{})},plan.previous?.id);plan.previous?updated++:added++;}db.exec('RELEASE web_knowledge_import');}
    catch(e){db.exec('ROLLBACK TO web_knowledge_import');db.exec('RELEASE web_knowledge_import');throw e;}
    return {added,updated,skipped};
  }
  function revisions(id){if(!get('knowledge',id))fail('知识不存在',404);return db.prepare("SELECT id,data,created,updated FROM growth_records WHERE kind='knowledgeRevision' AND json_extract(data,'$.knowledgeId')=? ORDER BY json_extract(data,'$.version') DESC").all(id).map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated}));}
  function restore(id,revisionId,expectedVersion){
    const revision=revisions(id).find(r=>r.id===revisionId);if(!revision)fail('知识版本不存在',404);
    return save({...revision.snapshot,archived:false,enabled:false,expectedVersion},id);
  }
  async function embed(input,c=configNow(),options={}){
    let vectors;
    if(embeddingCall)vectors=await embeddingCall(input);
    else if(c.embeddingProvider==='local')vectors=await localEmbeddings.embed(input,options);
    else {
      const r=await fetch(c.base+'/embeddings',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},body:JSON.stringify({model:c.embeddingModel,input,encoding_format:'float'}),signal:AbortSignal.timeout(45000)});
      if(!r.ok)fail('向量接口请求失败（'+r.status+'），未改变已保存的知识',502);
      const data=await r.json();
      const sorted=data.data?.slice().sort((a,b)=>a.index-b.index);
      if(!sorted||sorted.some((d,i)=>d.index!==i))fail('向量接口返回的索引无效',502);
      vectors=sorted.map(d=>d.embedding);
    }
    if(!Array.isArray(vectors)||vectors.length!==input.length||vectors.some(v=>!Array.isArray(v)||v.length<2||v.length>16384||v.some(n=>typeof n!=='number'||!Number.isFinite(n))||Math.hypot(...v)===0)||vectors.some(v=>v.length!==vectors[0].length))fail('向量接口返回无效向量',502);
    return vectors;
  }
  function indexStatus(){
    const config=configNow();let counts;
    if(cache.large()){cache.disk.ensure(config,signature(config));const d=cache.disk.status();counts={...d,pending:d.pending+d.preparing};}
    else{const plans=cache.plans(config,signature(config)),vectors=cache.vectorMap(),ready=plans.reduce((n,c)=>n+Number(vectors.has(c.key)),0);counts={total:plans.length,ready,pending:plans.length-ready,preparing:0,strategy:'memory-exact'};}
    return {...counts,enabled:canEmbed(config),provider:config.embeddingProvider,model:config.embeddingProvider==='local'?localEmbeddings.MODEL:config.embeddingModel,dimensions:config.embeddingProvider==='local'?512:null,minScore:config.embeddingMinScore??(config.embeddingProvider==='local'?0.4:0.3),building:!!indexing,job:get('knowledgeIndexJob','active'),local:config.embeddingProvider==='local'?localEmbeddings.status():null};
  }
  let indexing=null;
  function buildIndex(){
    if(indexing)return indexing;
    if(!canEmbed())fail('请先在模型设置选择本地向量检索，或配置 API 向量接口');
    indexing=(async()=>{
      const config=configNow();
      const large=cache.large();if(large)cache.disk.ensure(config,signature(config));
      const known=large?null:cache.vectorMap(),pending=large?cache.disk.next():cache.plans(config,signature(config)).filter(c=>!known.has(c.key)).slice(0,32);
      if(!pending.length)return {...indexStatus(),indexed:0};
      const vectors=await embed(pending.map(c=>c.title.slice(0,80)+'\n'+c.body),config,{download:true});let indexed=0;
      if(signature(config)!==signature(configNow())||!canEmbed())fail('检索设置已改变，本批索引未保存，请重新建立',409);
      const committed=[];db.exec('SAVEPOINT growth_vector_batch');
      try{pending.forEach((c,i)=>{const current=get('knowledge',c.knowledgeId);if(current?.enabled&&!current.archived&&fingerprint(current)===c.fingerprint){if(large){if(!cache.disk.saveVector(c,vectors[i]))return;}else put('knowledgeVector',{knowledgeId:c.knowledgeId,vector:vectors[i]},c.key);committed.push([c.key,vectors[i]]);indexed++;}});db.exec('RELEASE growth_vector_batch');}
      catch(e){db.exec('ROLLBACK TO growth_vector_batch');db.exec('RELEASE growth_vector_batch');throw e;}
      if(!large)cache.committed(committed);else cache.disk.committed(committed.map(([key])=>key));
      event('','建立语义索引',String(indexed)+' 个片段');return {...indexStatus(),indexed};
    })().finally(()=>{indexing=null;});return indexing;
  }
  const queryCache=new Map();
  async function diskSearch(query,ids,categories,config){
    cache.disk.ensure(config,signature(config));
    const status=cache.disk.status(),expandedTerms=expansion(query),lexical=()=>cache.disk.lexical(query,ids,categories),fallback=warning=>({list:lexical().map(k=>({...k,match:'keyword'})),mode:'keyword',expandedTerms,warning,strategy:'disk-exact'});
    if(status.preparing)return fallback('大规模检索目录正在分批整理，尚有 '+status.preparing+' 条；目前仅检索已就绪条目，请完成后重试');
    if(!canEmbed(config))return fallback('使用磁盘倒排检索；未启用语义模型');
    if(!status.ready)return fallback('当前尚未建立语义索引，使用磁盘倒排检索');
    const revision=cache.epoch().docs,codes=identifiers(query);
    try{
      const key=hash(signature(config)+query);let cached=queryCache.get(key);
      if(!cached||clock()-cached.at>300){cached={vector:(await embed([query.slice(0,config.embeddingProvider==='local'?420:1800)],config,{query:true}))[0],at:clock()};queryCache.set(key,cached);if(queryCache.size>100)queryCache.delete(queryCache.keys().next().value);}
      const minimum=config.embeddingMinScore??(config.embeddingProvider==='local'?0.4:0.3),best=new Map(),norm=Math.hypot(...cached.vector),q=Float32Array.from(cached.vector,n=>n/norm);let scanned=0,cutoff=minimum;
      for await(const row of cache.disk.vectorRows(ids,categories,codes)){
        if(codes.length&&!matchesIdentifier(JSON.parse(row.data),codes))continue;
        let score;
        if(row.bytes){const vector=new Float32Array(row.bytes.buffer,row.bytes.byteOffset,row.bytes.byteLength/4);if(vector.length!==q.length)throw Error('向量维度不匹配');score=0;for(let i=0;i<q.length;i++)score+=q[i]*vector[i];}
        else score=cosine(q,JSON.parse(row.vector).vector);
        scanned++;
        if(score>=cutoff&&score>(best.get(row.knowledgeId)?.similarity??-1)){
          const k=get('knowledge',row.knowledgeId);if(!k)continue;
          best.set(k.id,{...k,body:row.body,chunkIndex:row.idx,similarity:score,score,match:'semantic'});
          if(best.size>20){const ranked=[...best.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));best.delete(ranked.at(-1).id);cutoff=ranked[19].score;}
        }
      }
      if(revision!==cache.epoch().docs||signature(config)!==signature(configNow())||!canEmbed())return fallback('知识或模型配置已变化，请重新检索');
      const words=lexical(),ranked=[...best.values()].sort((a,b)=>b.similarity-a.similarity),first=ranked[0]?.similarity,second=ranked[1]?.similarity;
      if(!words.length&&first!==undefined&&(first<minimum+.01||(second!==undefined&&first<minimum+.03&&first-second<.01)))return {list:[],mode:'hybrid',strategy:'disk-exact',scanned,expandedTerms,warning:'语义候选得分偏低或接近，请补充具体业务信息'};
      return {list:fuseDiskRanks(query,ranked,words),mode:'hybrid',strategy:'disk-exact',scanned,provider:config.embeddingProvider,model:config.embeddingModel,expandedTerms,warning:status.pending?'部分片段未建立向量，仍可倒排检索':''};
    }catch{return fallback('语义检索暂不可用，已回退磁盘倒排检索');}
  }
  async function search(query,ids=[],categories=[]){
    const expandedTerms=expansion(query),fallback=warning=>({list:cache.lexical(query,ids,categories).map(k=>({...k,match:'keyword'})),mode:'keyword',warning,expandedTerms});
    const config=configNow();
    if(cache.large())return diskSearch(query,ids,categories,config);
    if(!canEmbed(config))return fallback('未启用语义检索，使用本地关键词匹配');
    const docs=new Map(cache.docs().map(k=>[k.id,k])),revision=cache.epoch().docs,known=cache.vectorMap();
    const codes=identifiers(query),candidates=cache.plans(config,signature(config)).filter(c=>cache.allowed(docs.get(c.knowledgeId),ids,categories)&&matchesIdentifier(docs.get(c.knowledgeId),codes)&&known.has(c.key));
    if(!candidates.length)return fallback('当前知识范围尚未建立语义索引，使用关键词匹配');
    try{
      const key=hash(signature(config)+query);let cached=queryCache.get(key);
      if(!cached||clock()-cached.at>300){cached={vector:(await embed([query.slice(0,config.embeddingProvider==='local'?420:1800)],config,{query:true}))[0],at:clock()};queryCache.set(key,cached);if(queryCache.size>100)queryCache.delete(queryCache.keys().next().value);}
      if(signature(config)!==signature(configNow())||!canEmbed())return fallback('检索设置已改变，请重新检索');
      const norm=Math.hypot(...cached.vector),q=Float32Array.from(cached.vector,n=>n/norm),byId=new Map();let count=0;
      for(const c of candidates){
        const vector=known.get(c.key);if(vector.length!==q.length)throw Error('向量维度不一致，请重建索引');
        let score=0;for(let i=0;i<q.length;i++)score+=q[i]*vector[i];
        if(score>=(config.embeddingMinScore??(config.embeddingProvider==='local'?0.4:0.3))&&score>(byId.get(c.knowledgeId)?.similarity??-1))byId.set(c.knowledgeId,{...docs.get(c.knowledgeId),body:c.body,chunkIndex:c.index,similarity:score,match:'semantic',score:0});
        if(++count%512===0)await yieldEventLoop();
      }
      // Never serve a snapshot invalidated while embedding or yielding for other requests.
      if(revision!==cache.epoch().docs||signature(config)!==signature(configNow())||!canEmbed())return fallback('知识或模型设置已更新，本次使用当前知识的关键词结果，请重新检索');
      const lexical=cache.lexical(query,ids,categories);
      const strengths=[...byId.values()].sort((a,b)=>b.similarity-a.similarity),best=strengths[0]?.similarity,second=strengths[1]?.similarity;
      const minimum=config.embeddingMinScore??(config.embeddingProvider==='local'?0.4:0.3);
      // Calibrated conservative abstention: a near-threshold semantic-only hit
      // needs a margin, and several indistinguishable weak hits are not evidence.
      if(!lexical.length&&best!==undefined&&(best<minimum+.01||(second!==undefined&&best<minimum+.03&&best-second<.01)))return {list:[],mode:'hybrid',provider:config.embeddingProvider,model:config.embeddingModel,expandedTerms,warning:'语义候选相关度偏低或得分接近，无法可靠区分；请补充商品、服务或问题细节。'};
      // Preserve semantic strength: rank-only fusion lets many weak keyword
      // overlaps crowd out a strong semantic answer in a large repetitive corpus.
      for(const k of byId.values())k.score=k.similarity;
      const maxLexical=lexical[0]?.score||1;
      lexical.forEach(k=>{const hit=byId.get(k.id),weight=k.score/maxLexical,literal=literalTitleScore(query,k.title);if(hit){hit.score=Math.max(hit.score+.04*weight,literal);hit.match='hybrid';}else byId.set(k.id,{...k,score:Math.max(.39+.1*weight,literal),match:'keyword'});});
      return {list:[...byId.values()].sort((a,b)=>b.score-a.score).slice(0,4),mode:'hybrid',provider:config.embeddingProvider,model:config.embeddingProvider==='local'?localEmbeddings.MODEL:config.embeddingModel,expandedTerms,warning:indexStatus().pending?'部分知识尚未建立索引；未索引条目仍可关键词匹配':''};
    }catch{return fallback('语义服务暂不可用，已回退关键词检索；知识内容未丢失');}
  }
  let jobRunning=false;
  const previousJob=get('knowledgeIndexJob','active');
  if(previousJob&&['running','pausing'].includes(previousJob.status))put('knowledgeIndexJob',{...previousJob,status:'interrupted',message:'服务曾中断，已保存完成的片段；点击继续后从缺失片段恢复。'},'active');
  async function runJob(){
    try{
      for(;;){
        await yieldEventLoop();let job=get('knowledgeIndexJob','active');
        if(job.status==='pausing'){put('knowledgeIndexJob',{...job,status:'paused',message:'已暂停，已完成片段保留。'},'active');break;}
        if(job.signature!==signature(configNow()))throw Error('模型设置已改变，请重新开始建立索引');
        const result=await buildIndex();job=get('knowledgeIndexJob','active');
        const status=job.status==='pausing'?'paused':result.pending?'running':'completed';
        put('knowledgeIndexJob',{...job,status,indexed:job.indexed+result.indexed,batches:job.batches+1,pending:result.pending,ready:result.ready,total:result.total,message:status==='completed'?'当前启用知识已全部建立索引。':status==='paused'?'已暂停，已完成片段保留。':'后台处理中，关闭页面不影响任务。'},'active');
        if(status!=='running')break;
      }
    }catch(e){const job=get('knowledgeIndexJob','active');put('knowledgeIndexJob',{...job,status:'failed',message:text(e.message,500)},'active');}
    finally{jobRunning=false;}
  }
  function controlJob(action){
    if(!['start','resume','pause'].includes(action))fail('无效索引任务操作');
    const previous=get('knowledgeIndexJob','active');
    if(action==='pause'){
      if(!jobRunning)return indexStatus();
      put('knowledgeIndexJob',{...previous,status:'pausing',message:'当前批次完成后暂停。'},'active');return indexStatus();
    }
    if(jobRunning)return indexStatus();
    if(!canEmbed())fail('请先配置向量模型');
    const current=indexStatus();
    put('knowledgeIndexJob',{status:'running',signature:signature(configNow()),startedAt:clock(),indexed:0,batches:0,pending:current.pending,ready:current.ready,total:current.total,message:'后台处理中，关闭页面不影响任务。'},'active');
    jobRunning=true;void runJob();return indexStatus();
  }
  function listPage({q='',category='',status='active',page=1,limit=50}={}){
    const size=Math.max(1,Math.min(100,Math.floor(Number(limit)||50))),number=Math.max(1,Math.floor(Number(page)||1));
    const query=text(q,200).toLowerCase();
    let where="kind='knowledge' AND coalesce(json_extract(data,'$.archived'),0)="+(status==='archived'?1:0),args=[];
    if(status==='enabled'||status==='disabled'){where+=" AND coalesce(json_extract(data,'$.enabled'),0)=?";args.push(status==='enabled'?1:0);}
    if(category&&category!=='all'){where+=" AND json_extract(data,'$.category')=?";args.push(category);}
    if(query){where+=" AND instr(lower(json_extract(data,'$.title')||char(10)||json_extract(data,'$.body')),?)>0";args.push(query);}
    const total=db.prepare('SELECT count(*) n FROM growth_records WHERE '+where).get(...args).n,actual=Math.min(number,Math.max(1,Math.ceil(total/size)));
    const list=db.prepare('SELECT id,data,created,updated FROM growth_records WHERE '+where+' ORDER BY updated DESC,id LIMIT ? OFFSET ?').all(...args,size,(actual-1)*size).map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated}));
    const categories=db.prepare("SELECT DISTINCT json_extract(data,'$.category') category FROM growth_records WHERE kind='knowledge' ORDER BY category LIMIT 1000").all().map(r=>r.category);
    return {list,total,page:actual,limit:size,categories};
  }
  function findWeb(url){return db.prepare("SELECT id,data,created,updated FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.sourceMeta.kind')='web' AND json_extract(data,'$.sourceMeta.url')=? AND coalesce(json_extract(data,'$.archived'),0)=0 ORDER BY updated DESC").all(url).map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated}));}
  function batchUpdate(body){
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)fail('每批需选择 1–100 条知识');
    if(!['enable','disable','archive','restore'].includes(body.action))fail('无效批量操作');
    if(body.items.some(k=>!k||typeof k.id!=='string'||!k.id||!Number.isSafeInteger(k.expectedVersion)||k.expectedVersion<1))fail('批量操作必须包含知识 ID 和当前版本');
    if(new Set(body.items.map(k=>k.id)).size!==body.items.length)fail('批量知识不能重复');
    for(const item of body.items){const current=get('knowledge',item.id);if(!current)fail('知识不存在',404);if(item.expectedVersion!==version(current))fail('选中知识已更新，请刷新后重新选择',409);if(body.action==='enable'&&current.archived)fail('归档知识请先恢复');}
    const changes={enable:{enabled:true},disable:{enabled:false},archive:{enabled:false,archived:true},restore:{enabled:false,archived:false}}[body.action];
    db.exec('SAVEPOINT growth_knowledge_batch');
    try{for(const item of body.items)save({...changes,expectedVersion:item.expectedVersion},item.id);db.exec('RELEASE growth_knowledge_batch');}
    catch(e){db.exec('ROLLBACK TO growth_knowledge_batch');db.exec('RELEASE growth_knowledge_batch');throw e;}
    return {updated:body.items.length};
  }
  return {save,previewImport,commitImport,commitWebImport,revisions,restore,buildIndex,indexStatus,search,controlJob,listPage,batchUpdate,findWeb,metadata:cache.metadata,lexical:(...args)=>{if(cache.large()){const c=configNow();cache.disk.ensure(c,signature(c))}return cache.lexical(...args)}};
}
module.exports={createKnowledge,parseImport,csvRows,cosine,chunks,literalTitleScore,fuseDiskRanks};
