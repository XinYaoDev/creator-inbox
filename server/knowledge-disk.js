'use strict';
// Large collections keep lexical postings, chunk plans and vectors on disk.
// Vector search is exact and paged, not an approximate/ANN claim.
const yieldLoop=()=>new Promise(r=>setImmediate(r));
const encoded=term=>'t'+Buffer.from(term).toString('hex');
function createDiskIndex({db,terms,expansion,identifiers,matchesIdentifier,chunks,chunkKey,fingerprint}){
  db.exec(`CREATE TABLE IF NOT EXISTS growth_search_dirty(id TEXT PRIMARY KEY,docrow INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS growth_search_meta(docrow INTEGER PRIMARY KEY,id TEXT UNIQUE,data TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS growth_search_fts USING fts5(title,body);
    CREATE TABLE IF NOT EXISTS growth_search_plans(key TEXT PRIMARY KEY,knowledgeId TEXT NOT NULL,docrow INTEGER NOT NULL,signature TEXT NOT NULL,fingerprint TEXT NOT NULL,idx INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS growth_search_plan_doc ON growth_search_plans(knowledgeId);
    CREATE TABLE IF NOT EXISTS growth_search_config(id INTEGER PRIMARY KEY,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS growth_vector_blobs(key TEXT PRIMARY KEY,knowledgeId TEXT NOT NULL,dimensions INTEGER NOT NULL,bytes BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS growth_vector_blob_doc ON growth_vector_blobs(knowledgeId);
    CREATE TRIGGER IF NOT EXISTS growth_blob_insert AFTER INSERT ON growth_vector_blobs BEGIN UPDATE growth_knowledge_epoch SET vectors=vectors+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS growth_blob_update AFTER UPDATE ON growth_vector_blobs BEGIN UPDATE growth_knowledge_epoch SET vectors=vectors+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS growth_blob_delete AFTER DELETE ON growth_vector_blobs BEGIN UPDATE growth_knowledge_epoch SET vectors=vectors+1 WHERE id=1; END;
    CREATE INDEX IF NOT EXISTS growth_active_knowledge ON growth_records(updated,id) WHERE kind='knowledge' AND json_extract(data,'$.enabled')=1 AND coalesce(json_extract(data,'$.archived'),0)=0;
    CREATE TRIGGER IF NOT EXISTS growth_search_insert AFTER INSERT ON growth_records WHEN NEW.kind='knowledge' AND json_extract(NEW.data,'$.enabled')=1 BEGIN INSERT INTO growth_search_dirty VALUES(NEW.id,NEW.rowid) ON CONFLICT(id) DO UPDATE SET docrow=excluded.docrow; END;
    CREATE TRIGGER IF NOT EXISTS growth_search_update AFTER UPDATE ON growth_records WHEN NEW.kind='knowledge' AND (json_extract(NEW.data,'$.enabled')=1 OR json_extract(OLD.data,'$.enabled')=1) BEGIN INSERT INTO growth_search_dirty VALUES(NEW.id,NEW.rowid) ON CONFLICT(id) DO UPDATE SET docrow=excluded.docrow; END;
    CREATE TRIGGER IF NOT EXISTS growth_search_delete AFTER DELETE ON growth_records WHEN OLD.kind='knowledge' BEGIN INSERT INTO growth_search_dirty VALUES(OLD.id,OLD.rowid) ON CONFLICT(id) DO UPDATE SET docrow=excluded.docrow; END;`);
  let config={embeddingProvider:'disabled'},signature='',running=false,error='',generation=0,countKey='',counts=null,nextCursor='',cursorEpoch='';
  const pending=()=>db.prepare('SELECT count(*) n FROM growth_search_dirty').get().n;
  function ensure(c,sig){
    config=c;signature=sig;
    const previous=db.prepare('SELECT signature FROM growth_search_config WHERE id=1').get();
    if(previous?.signature!==sig){
      db.exec('SAVEPOINT growth_search_reset');
      try{db.prepare('INSERT INTO growth_search_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature').run(sig);db.exec('DELETE FROM growth_search_plans');db.exec("INSERT OR REPLACE INTO growth_search_dirty SELECT id,rowid FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.enabled')=1 AND coalesce(json_extract(data,'$.archived'),0)=0");db.exec('RELEASE growth_search_reset');}catch(e){db.exec('ROLLBACK TO growth_search_reset');db.exec('RELEASE growth_search_reset');throw e;}
    }
    if(!running&&pending())void pump();
  }
  function step(limit=50){
    const rows=db.prepare('SELECT id,docrow FROM growth_search_dirty ORDER BY docrow LIMIT ?').all(limit);
    if(!rows.length)return 0;
    db.exec('SAVEPOINT growth_search_batch');
    try{
      for(const {id,docrow} of rows){
        const record=db.prepare("SELECT id,data,created,updated FROM growth_records WHERE kind='knowledge' AND id=?").get(id);
        db.prepare('DELETE FROM growth_search_fts WHERE rowid=?').run(docrow);db.prepare('DELETE FROM growth_search_meta WHERE docrow=?').run(docrow);db.prepare('DELETE FROM growth_search_plans WHERE knowledgeId=?').run(id);
        if(record){const k={...JSON.parse(record.data),id,created:record.created,updated:record.updated};if(k.enabled&&!k.archived){
          db.prepare('INSERT INTO growth_search_meta VALUES(?,?,?)').run(docrow,id,record.data);
          db.prepare('INSERT INTO growth_search_fts(rowid,title,body) VALUES(?,?,?)').run(docrow,[...terms(k.title)].map(encoded).join(' '),[...terms(k.body)].map(encoded).join(' '));
          const fp=fingerprint(k);for(const chunk of chunks(k,config.embeddingProvider==='local'))db.prepare('INSERT INTO growth_search_plans VALUES(?,?,?,?,?,?,?,?)').run(chunkKey(k,chunk,config,fp),id,docrow,signature,fp,chunk.index,chunk.title,chunk.body);
        }}
        db.prepare('DELETE FROM growth_search_dirty WHERE id=?').run(id);
      }
      db.exec('RELEASE growth_search_batch');generation++;return rows.length;
    }catch(e){db.exec('ROLLBACK TO growth_search_batch');db.exec('RELEASE growth_search_batch');throw e;}
  }
  async function pump(){running=true;error='';try{while(pending()){await yieldLoop();step();}}catch(e){error=String(e.message).slice(0,200);}finally{running=false;}}
  const scope=(ids,categories,args)=>{let where=" AND json_extract(r.data,'$.enabled')=1 AND coalesce(json_extract(r.data,'$.archived'),0)=0 AND m.data=r.data";if(ids.length){where+=' AND r.id IN ('+ids.map(()=>'?').join(',')+')';args.push(...ids)}if(categories.length){where+=" AND json_extract(r.data,'$.category') IN ("+categories.map(()=>'?').join(',')+')';args.push(...categories)}return where;};
  function lexical(query,ids=[],categories=[]){
    const codes=identifiers(query),text=String(query+' '+expansion(query).join(' ')).normalize('NFKC').toLowerCase();
    const stop=new Set('a an the is are was were be been being do does did of in on at to for from by with and or that this these those what which who whom whose when where why how many much can could would should have has had it its as into about during after before'.split(' '));
    const words=(text.match(/[a-z0-9_-]{2,}/g)||[]).filter(w=>!stop.has(w)),han=(text.match(/[\p{Script=Han}]{2,}/gu)||[]).flatMap(s=>[...terms(s)]);
    const ts=[...new Set(codes.length?codes:[...words,...han])].slice(0,32);if(!ts.length)return [];
    const args=[ts.map(encoded).join(' OR ')],where=scope(ids,categories,args);
    // CROSS JOIN fixes the join order: begin with FTS matches, never probe the
    // virtual table once per record. Scope filters still apply before LIMIT.
    const rows=db.prepare("SELECT r.id,r.data,r.created,r.updated,growth_search_fts.rank AS rank FROM growth_search_fts CROSS JOIN growth_search_meta m CROSS JOIN growth_records r WHERE growth_search_fts MATCH ? AND growth_search_fts.rank MATCH 'bm25(4,1)' AND m.docrow=growth_search_fts.rowid AND r.kind='knowledge' AND r.id=m.id"+where+' ORDER BY growth_search_fts.rank LIMIT 200').all(...args);
    return rows.map(r=>({...JSON.parse(r.data),id:r.id,created:r.created,updated:r.updated,score:-r.rank})).filter(k=>{const body=terms(k.body),title=terms(k.title);return ts.reduce((sum,t)=>sum+Number(body.has(t))+3*Number(title.has(t)),0)>=(ts.length===1?1:2)&&matchesIdentifier(k,codes)}).slice(0,4);
  }
  // Force the bounded plan-key range to be the driving table. Otherwise SQLite
  // may scan every document and sort all plans for every 32/256-row batch.
  const usable=" FROM growth_search_plans p CROSS JOIN growth_search_meta m ON m.docrow=p.docrow CROSS JOIN growth_records r ON r.kind='knowledge' AND r.id=p.knowledgeId";
  function status(){
    const epoch=db.prepare('SELECT docs,vectors FROM growth_knowledge_epoch WHERE id=1').get(),key=epoch.docs+'|'+epoch.vectors+'|'+generation+'|'+signature;
    if(countKey===key&&counts)return {...counts,preparing:pending(),preparationRunning:running,preparationError:error};
    const args=[],where=scope([],[],args),total=db.prepare('SELECT count(*) n'+usable+' WHERE 1=1'+where).get().n;
    const ready=db.prepare("SELECT count(*) n"+usable+" LEFT JOIN growth_vector_blobs b ON b.key=p.key LEFT JOIN growth_records v ON v.kind='knowledgeVector' AND v.id=p.key WHERE (b.key IS NOT NULL OR v.id IS NOT NULL)"+where).get().n;
    countKey=key;counts={total,ready,pending:total-ready,strategy:'disk-exact'};return {...counts,preparing:pending(),preparationRunning:running,preparationError:error};
  }
  function next(){
    const epoch=db.prepare('SELECT docs FROM growth_knowledge_epoch WHERE id=1').get().docs+'|'+generation+'|'+signature;if(cursorEpoch!==epoch){nextCursor='';cursorEpoch=epoch;}
    const read=()=>{const args=[nextCursor],where=scope([],[],args);return db.prepare('SELECT p.key,p.knowledgeId,p.fingerprint,p.idx AS "index",p.title,p.body'+usable+" LEFT JOIN growth_vector_blobs b ON b.key=p.key LEFT JOIN growth_records v ON v.kind='knowledgeVector' AND v.id=p.key WHERE p.key>? AND b.key IS NULL AND v.id IS NULL"+where+' ORDER BY p.key LIMIT 32').all(...args);};
    let rows=read();if(!rows.length&&nextCursor){nextCursor='';rows=read();}return rows;
  }
  function saveVector(c,vector){const norm=Math.hypot(...vector),values=Float32Array.from(vector,n=>n/norm);return db.prepare('INSERT INTO growth_vector_blobs VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING').run(c.key,c.knowledgeId,values.length,Buffer.from(values.buffer)).changes>0;}
  function committed(keys){
    if(!keys.length)return;nextCursor=keys.toSorted().at(-1);
    const epoch=db.prepare('SELECT docs,vectors FROM growth_knowledge_epoch WHERE id=1').get();
    if(counts&&countKey===epoch.docs+'|'+(epoch.vectors-keys.length)+'|'+generation+'|'+signature){counts.ready+=keys.length;counts.pending-=keys.length;countKey=epoch.docs+'|'+epoch.vectors+'|'+generation+'|'+signature;}
  }
  async function* vectorRows(ids=[],categories=[],codes=[]){
    // The caller requires a fully prepared directory, captures the document
    // epoch before scanning, and rejects the entire result if it changes. Plans
    // only contain enabled/non-archived documents. Do not reparse/rejoin every
    // full business record for every vector; this tripled large-query I/O.
    const includeData=!!codes.length,strictCodes=codes.length&&codes.every(code=>code.includes('-')||code.includes('_'));
    let after='';for(;;){
      const args=[after];let where='';
      if(strictCodes){where+=' AND p.docrow IN (SELECT rowid FROM growth_search_fts WHERE growth_search_fts MATCH ?)';args.push(codes.map(encoded).join(' OR '));}
      if(ids.length){where+=' AND p.knowledgeId IN ('+ids.map(()=>'?').join(',')+')';args.push(...ids);}
      if(categories.length){where+=" AND json_extract(m.data,'$.category') IN ("+categories.map(()=>'?').join(',')+')';args.push(...categories);}
      const meta=includeData||categories.length?' CROSS JOIN growth_search_meta m ON m.docrow=p.docrow':'';
      const rows=db.prepare('SELECT p.key,p.idx,p.body,p.knowledgeId,'+(includeData?'m.data,':'')+'b.bytes,v.data AS vector FROM growth_search_plans p'+meta+" LEFT JOIN growth_vector_blobs b ON b.key=p.key LEFT JOIN growth_records v ON v.kind='knowledgeVector' AND v.id=p.key WHERE p.key>? AND (b.key IS NOT NULL OR v.id IS NOT NULL)"+where+' ORDER BY p.key LIMIT 256').all(...args);
      if(!rows.length)break;after=rows.at(-1).key;for(const row of rows)yield row;await yieldLoop();
    }
  }
  return {ensure,status,next,lexical,vectorRows,saveVector,committed};
}
module.exports={createDiskIndex};
