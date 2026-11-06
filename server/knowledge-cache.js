'use strict';
const concepts=require('../shared/knowledge-concepts.json').map(c=>({...c,expression:new RegExp(c.pattern,'iu')}));
const {createDiskIndex}=require('./knowledge-disk');
function expansion(query){return [...new Set(concepts.filter(c=>c.expression.test(query)).flatMap(c=>c.terms))];}

// Exact search, deliberately not advertised as ANN. SQLite generations make caches
// safe across instances and edits while eliminating per-query JSON/SQL/chunk work.
function terms(value){
  const lower=String(value).normalize('NFKC').toLowerCase(),s=lower.replace(/\s+/g,''),out=new Set(lower.match(/[a-z0-9_-]{2,}/g)||[]);
  for(let i=0;i<s.length-1;i++){const term=s.slice(i,i+2);if(/[\p{L}\p{N}]{2}/u.test(term)&&!/[的与及和或]/u.test(term))out.add(term);}
  return out;
}
function identifiers(query){return [...new Set(String(query).match(/\b(?:[a-zA-Z]+[-_][a-zA-Z0-9_-]*\d{2,}|[A-Z]{1,8}\d{2,})\b/g)||[])].map(s=>s.toLowerCase());}
function matchesIdentifier(k,codes){
  const value=k.title+'\n'+k.body,lower=value.toLowerCase();
  if(!codes.length||codes.some(code=>new RegExp('(^|[^a-z0-9_-])'+code+'(?=$|[^a-z0-9_-])').test(lower)))return true;
  // A compact product model may share a general warranty or policy document.
  // Keep generic policy documents, but never substitute another explicit model.
  return codes.every(code=>!code.includes('-')&&!code.includes('_'))&&!identifiers(value).length;
}
function createCache({db,all,chunks,chunkKey,fingerprint}){
  db.exec(`CREATE TABLE IF NOT EXISTS growth_knowledge_epoch(id INTEGER PRIMARY KEY,docs INTEGER NOT NULL,vectors INTEGER NOT NULL);
    INSERT OR IGNORE INTO growth_knowledge_epoch VALUES(1,0,0);
    CREATE INDEX IF NOT EXISTS growth_revision_lookup ON growth_records(kind,json_extract(data,'$.knowledgeId'),json_extract(data,'$.version'));
    CREATE TRIGGER IF NOT EXISTS growth_knowledge_insert AFTER INSERT ON growth_records WHEN NEW.kind IN ('knowledge','knowledgeVector') BEGIN UPDATE growth_knowledge_epoch SET docs=docs+(NEW.kind='knowledge'),vectors=vectors+(NEW.kind='knowledgeVector') WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS growth_knowledge_update AFTER UPDATE ON growth_records WHEN NEW.kind IN ('knowledge','knowledgeVector') BEGIN UPDATE growth_knowledge_epoch SET docs=docs+(NEW.kind='knowledge'),vectors=vectors+(NEW.kind='knowledgeVector') WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS growth_knowledge_delete AFTER DELETE ON growth_records WHEN OLD.kind IN ('knowledge','knowledgeVector') BEGIN UPDATE growth_knowledge_epoch SET docs=docs+(OLD.kind='knowledge'),vectors=vectors+(OLD.kind='knowledgeVector') WHERE id=1; END;`);
  const epoch=()=>db.prepare('SELECT docs,vectors FROM growth_knowledge_epoch WHERE id=1').get();
  const disk=createDiskIndex({db,terms,expansion,identifiers,matchesIdentifier,chunks,chunkKey,fingerprint});
  let countEpoch=-1,activeCount=0;
  const large=()=>{const n=epoch().docs;if(countEpoch!==n){activeCount=db.prepare("SELECT count(*) n FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.enabled')=1 AND coalesce(json_extract(data,'$.archived'),0)=0").get().n;countEpoch=n;}if(activeCount>5000&&docVersion!==-1){documents=[];byId.clear();postings.clear();vectors.clear();plan=[];planSignature='';docVersion=-1;vectorVersion=-1;vectorDocVersion=-1;}return activeCount>5000;};
  let docVersion=-1,vectorVersion=-1,vectorDocVersion=-1,documents=[],byId=new Map(),postings=new Map(),vectors=new Map(),planSignature='',plan=[];
  function docs(){
    const revision=epoch().docs;
    if(revision!==docVersion){
      documents=db.prepare("SELECT id,data,created,updated FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.enabled')=1 AND coalesce(json_extract(data,'$.archived'),0)=0").all().map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated}));byId=new Map(documents.map(k=>[k.id,k]));postings=new Map();planSignature='';
      for(const k of documents.filter(k=>k.enabled&&!k.archived)){
        const weighted=new Map();for(const t of terms(k.body))weighted.set(t,1);for(const t of terms(k.title))weighted.set(t,(weighted.get(t)||0)+3);
        for(const [t,weight] of weighted){if(!postings.has(t))postings.set(t,new Map());postings.get(t).set(k.id,weight);}
      }
      docVersion=revision;
    }
    return documents;
  }
  const allowed=(k,ids,categories)=>k.enabled&&!k.archived&&(!ids.length||ids.includes(k.id))&&(!categories.length||categories.includes(k.category));
  function lexical(query,ids=[],categories=[]){
    if(large())return disk.lexical(query,ids,categories);
    docs();const scores=new Map(),raw=new Map(),codes=identifiers(query);
    for(const t of terms(query+' '+expansion(query).join(' '))){
      const hits=postings.get(t);if(!hits)continue;const idf=Math.log(1+documents.length/hits.size);
      for(const [id,weight] of hits){raw.set(id,(raw.get(id)||0)+weight);scores.set(id,(scores.get(id)||0)+weight*idf);}
    }
    return [...scores].filter(([id])=>raw.get(id)>=2&&allowed(byId.get(id),ids,categories)&&matchesIdentifier(byId.get(id),codes)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,4).map(([id,score])=>({...byId.get(id),score}));
  }
  function plans(config,signature){
    docs();if(planSignature!==signature){
      plan=documents.filter(k=>k.enabled&&!k.archived).flatMap(k=>{const fp=fingerprint(k);return chunks(k,config.embeddingProvider==='local').map(c=>({...c,key:chunkKey(k,c,config,fp),fingerprint:fp}));});planSignature=signature;
    }
    return plan;
  }
  function normalized(vector){const norm=Math.hypot(...vector);return Float32Array.from(vector,n=>norm?n/norm:0);}
  function vectorMap(){
    const current=epoch(),revision=current.vectors;
    if(revision!==vectorVersion||current.docs!==vectorDocVersion){vectors=new Map(db.prepare("SELECT v.id,v.data FROM growth_records v JOIN growth_records k ON k.kind='knowledge' AND k.id=json_extract(v.data,'$.knowledgeId') WHERE v.kind='knowledgeVector' AND json_extract(k.data,'$.enabled')=1 AND coalesce(json_extract(k.data,'$.archived'),0)=0").all().map(v=>[v.id,normalized(JSON.parse(v.data).vector)]));for(const v of db.prepare("SELECT b.key,b.bytes FROM growth_vector_blobs b JOIN growth_records k ON k.kind='knowledge' AND k.id=b.knowledgeId WHERE json_extract(k.data,'$.enabled')=1 AND coalesce(json_extract(k.data,'$.archived'),0)=0").all())vectors.set(v.key,new Float32Array(v.bytes.buffer,v.bytes.byteOffset,v.bytes.byteLength/4));vectorVersion=revision;vectorDocVersion=current.docs;}
    return vectors;
  }
  function committed(entries){const current=epoch(),revision=current.vectors;if(revision!==vectorVersion+entries.length||current.docs!==vectorDocVersion){vectorVersion=-1;vectorMap();return;}for(const [key,vector] of entries)vectors.set(key,normalized(vector));vectorVersion=revision;}
  function metadata(){return db.prepare("SELECT id,json_remove(data,'$.body') data,created,updated FROM growth_records WHERE kind='knowledge' ORDER BY updated DESC,id LIMIT 1000").all().map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated}));}
  return {epoch,docs,lexical,plans,vectorMap,committed,metadata,allowed,large,disk};
}
module.exports={createCache,terms,identifiers,matchesIdentifier,expansion};
