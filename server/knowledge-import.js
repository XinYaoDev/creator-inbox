'use strict';
// Uploads and checkpoints live in the workspace's SQLite namespace. Neither a
// browser-supplied pathname nor a whole-file string enters the import pipeline.
const {createHash,randomUUID}=require('node:crypto');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const digest=b=>createHash('sha256').update(b).digest('hex');
const yieldLoop=()=>new Promise(r=>setImmediate(r));
const CHUNK=1024*1024,MAX_BYTES=512*CHUNK,MAX_ROWS=200000,MAX_RECORD=180000;

async function* records(parts,format,filename,category){
  let text='',number=0;
  if(format==='txt'||format==='md'){
    for await(const part of parts){text+=part;while(text.length>=12000){yield {number:++number,value:{title:filename+' · '+number,body:text.slice(0,12000),category}};text=text.slice(12000);}}
    if(text.trim())yield {number:++number,value:{title:filename+' · '+number,body:text,category}};return;
  }
  if(format==='jsonl'||format==='ndjson'){
    for await(const part of parts){text+=part;let p;while((p=text.indexOf('\n'))>=0){const line=text.slice(0,p).trim();text=text.slice(p+1);if(line){number++;try{yield {number,value:JSON.parse(line)};}catch{yield {number,error:'JSON 行解析失败'};}}}if(text.length>MAX_RECORD)fail('单行超过 180000 字符，请拆分');}
    if(text.trim()){try{yield {number:++number,value:JSON.parse(text)};}catch{yield {number,error:'JSON 行解析失败'};}}return;
  }
  if(format==='json'){
    let phase='start',depth=0,quoted=false,escaped=false;
    for await(const part of parts)for(const c of part){
      if(phase==='done'){if(!/\s/.test(c))fail('JSON 数组后有多余内容');continue;}
      if(phase==='start'){if(/\s/.test(c))continue;if(c!=='[')fail('JSON 必须为条目数组');phase='value';continue;}
      if(phase==='separator'){if(/\s/.test(c))continue;if(c===']'){phase='done';continue;}if(c!==',')fail('JSON 条目之间缺少逗号');phase='next';continue;}
      if(!text){if(/\s/.test(c))continue;if(c===']'&&phase==='value'){phase='done';continue;}if(c!=='{')fail('JSON 数组只支持对象条目');phase='object';}
      text+=c;if(text.length>MAX_RECORD)fail('单个 JSON 对象过长，请拆分');
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
      if(depth===0&&!quoted){number++;try{yield {number,value:JSON.parse(text)};}catch{yield {number,error:'JSON 对象解析失败'};}text='';phase='separator';}
    }
    if(phase!=='done')fail('JSON 数组未完整结束；尚未写入知识库');return;
  }
  let row=[],cell='',state='plain',header=null,skipLF=false,size=0;
  const finish=()=>{
    row.push(cell);cell='';state='plain';size=0;const values=row;row=[];
    if(values.every(v=>!v.trim()))return null;
    if(!header){header=values.map(v=>v.trim().toLowerCase());if(!header.some(v=>['title','标题','问题'].includes(v))||!header.some(v=>['body','内容','答案'].includes(v)))fail('CSV 必须有 title / body 或 标题 / 内容 表头');return null;}
    number++;if(values.length!==header.length)return {number,error:'CSV 列数与表头不一致'};
    const pick=names=>values[header.findIndex(h=>names.includes(h))];
    return {number,value:{title:pick(['title','标题','问题']),body:pick(['body','内容','答案']),category:pick(['category','分类'])||category}};
  };
  for await(const part of parts)for(const c of part){
    if(skipLF){skipLF=false;if(c==='\n')continue;}
    if(++size>MAX_RECORD)fail('CSV 单行过长，请拆分');
    if(state==='quoted'){if(c==='"')state='closed';else cell+=c;continue;}
    if(state==='closed'&&c==='"'){cell+='"';state='quoted';continue;}
    if(c===','||c==='\n'||c==='\r'){if(c===','){row.push(cell);cell='';state='plain';}else{const record=finish();if(record)yield record;skipLF=c==='\r';}continue;}
    if(c==='"'){if(cell||state==='closed')fail('CSV 引号格式错误');state='quoted';}
    else if(state==='closed'){if(!/\s/.test(c))fail('CSV 引号后存在多余字符');}
    else cell+=c;
  }
  if(state==='quoted')fail('CSV 引号未闭合；尚未写入知识库');const last=finish();if(last)yield last;
}

function createKnowledgeImport({db,get,put,all,knowledge,clock,event}){
  db.exec(`CREATE TABLE IF NOT EXISTS growth_import_chunks(job TEXT NOT NULL,offset INTEGER NOT NULL,hash TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(job,offset));
    CREATE TABLE IF NOT EXISTS growth_import_rows(job TEXT NOT NULL,row INTEGER NOT NULL,data TEXT NOT NULL,hash TEXT,state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',knowledgeId TEXT,PRIMARY KEY(job,row));
    CREATE INDEX IF NOT EXISTS growth_import_rows_status ON growth_import_rows(job,state,row);
    CREATE INDEX IF NOT EXISTS growth_import_rows_hash ON growth_import_rows(job,hash);
    CREATE INDEX IF NOT EXISTS growth_knowledge_title ON growth_records(kind,json_extract(data,'$.title'));`);
  const running=new Map();
  for(const j of all('knowledgeImport'))if(['parsing','committing','pausing'].includes(j.status))put('knowledgeImport',{...j,status:'interrupted',message:'服务已重启。上传和已导入记录保留，可继续处理。'},j.id);
  const detail=id=>get('knowledgeImport',id)||fail('导入任务不存在',404);
  const patch=(id,data)=>put('knowledgeImport',{...detail(id),...data},id);
  const list=()=>all('knowledgeImport').slice(0,30);
  function start(input){
    const format=String(input.filename||'').split('.').pop().toLowerCase();
    if(!['csv','json','jsonl','ndjson','txt','md'].includes(format))fail('支持 UTF-8 CSV、JSON 数组、JSONL、TXT 和 Markdown');
    if(!Number.isSafeInteger(input.size)||input.size<1||input.size>MAX_BYTES)fail('文件大小需在 1 字节到 512 MiB 之间');
    const live=all('knowledgeImport').filter(j=>!['completed','cancelled'].includes(j.status));
    if(live.length>=5||live.reduce((n,j)=>n+j.size,0)+input.size>2*1024**3)fail('最多保留 5 个未完成任务、总计 2 GiB，请先完成或取消已有任务',409);
    return put('knowledgeImport',{filename:String(input.filename).slice(0,200),category:String(input.category||'导入资料').slice(0,100),format,size:input.size,offset:0,status:'uploading',rows:0,valid:0,errors:0,duplicates:0,added:0,processed:0,phase:'parse',message:'按块上传，可暂停；重新选择同一文件可续传。'});
  }
  async function upload(id,offset,hash,req){
    const j=detail(id);if(j.status!=='uploading')fail('当前任务不接受上传',409);
    if(running.has(id))fail('该文件正在接收另一块数据',409);
    if(!Number.isSafeInteger(offset)||offset<0||offset%CHUNK!==0||offset>j.offset)fail('上传位置不一致，请重新读取任务进度',409);
    if(!/^[a-f0-9]{64}$/.test(hash||''))fail('缺少分块 SHA-256 校验');
    running.set(id,'upload');
    const timer=setTimeout(()=>req.destroy(Error('分块上传超时')),30000);timer.unref?.();
    try{
      let size=0;const buffers=[];for await(const b of req){size+=b.length;if(size>CHUNK)fail('每块最多 1 MiB',413);buffers.push(b);}
      const data=Buffer.concat(buffers);if(size!==Math.min(CHUNK,j.size-offset)||digest(data)!==hash)fail('分块长度或校验不一致，请重试');
      const previous=db.prepare('SELECT hash FROM growth_import_chunks WHERE job=? AND offset=?').get(id,offset);
      if(previous){if(previous.hash!==hash)fail('已上传部分与所选文件不同，请使用原文件或新建任务',409);return detail(id);}
      db.exec('SAVEPOINT import_upload');try{db.prepare('INSERT INTO growth_import_chunks VALUES(?,?,?,?)').run(id,offset,hash,data);patch(id,{offset:offset+size});db.exec('RELEASE import_upload');}catch(e){db.exec('ROLLBACK TO import_upload');db.exec('RELEASE import_upload');throw e;}
      return detail(id);
    }finally{clearTimeout(timer);running.delete(id);}
  }
  const duplicate=k=>db.prepare("SELECT id FROM growth_records WHERE kind='knowledge' AND json_extract(data,'$.title')=? AND json_extract(data,'$.body')=? LIMIT 1").get(k.title,k.body);
  async function parse(id){
    const j=detail(id),hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,rows=0,valid=0,errors=0,duplicates=0;
    db.prepare('DELETE FROM growth_import_rows WHERE job=?').run(id);
    async function* parts(){
      for(let offset=0;offset<j.size;offset+=CHUNK){
        const b=db.prepare('SELECT data,hash FROM growth_import_chunks WHERE job=? AND offset=?').get(id,offset);if(!b||digest(b.data)!==b.hash)fail('上传数据校验失败，请重新上传');
        hash.update(b.data);bytes+=b.data.length;yield decoder.decode(b.data,{stream:true});await yieldLoop();
        if(detail(id).status==='pausing')throw Object.assign(Error('已暂停解析，上传完整保留；继续时重新解析。'),{paused:true});
      }yield decoder.decode();
    }
    let batch=[];
    function flush(){
      db.exec('SAVEPOINT import_parse');try{for(const r of batch)db.prepare('INSERT INTO growth_import_rows(job,row,data,hash,state,reason) VALUES(?,?,?,?,?,?)').run(id,r.number,JSON.stringify(r.value||{}),r.hash||null,r.state,r.error||'');patch(id,{rows,valid,errors,duplicates,bytes, message:'正在校验文件；尚未写入知识库。'});db.exec('RELEASE import_parse');batch=[];}catch(e){db.exec('ROLLBACK TO import_parse');db.exec('RELEASE import_parse');throw e;}
    }
    for await(const r of records(parts(),j.format,j.filename,j.category)){
      rows++;if(rows>MAX_ROWS)fail('单次最多 200000 条知识，请分开导入');
      if(!r.error){const v=r.value;if(!v||typeof v.title!=='string'||!v.title.trim()||typeof v.body!=='string'||!v.body.trim())r.error='缺少文本标题或正文';else if(v.title.length>200||v.body.length>30000||String(v.category||j.category).length>100)r.error='标题 / 正文 / 分类超出 200 / 30000 / 100 字限制';else{r.value={title:v.title.trim(),body:v.body.trim(),category:String(v.category||j.category).trim()||'导入资料',enabled:false};r.hash=digest(r.value.title+'\n'+r.value.body);}}
      if(r.error){r.state='error';r.value={};errors++;}
      else if(batch.some(x=>x.hash===r.hash)||db.prepare('SELECT 1 FROM growth_import_rows WHERE job=? AND hash=? LIMIT 1').get(id,r.hash)||duplicate(r.value)){r.state='duplicate';r.error='相同标题和正文已存在';duplicates++;}
      else{r.state='ready';valid++;}batch.push(r);
      if(batch.length>=100){flush();await yieldLoop();if(detail(id).status==='pausing')throw Object.assign(Error('已暂停解析，上传完整保留；继续时重新解析。'),{paused:true});}
    }
    flush();if(!rows)fail('文件没有可识别的条目');patch(id,{status:'review',sha256:hash.digest('hex'),bytes:j.size,message:'校验完成。请分页检查；确认后只导入有效、不重复的条目，默认停用。'});
  }
  async function commit(id){
    for(;;){
      await yieldLoop();const j=detail(id);if(j.status==='pausing'){patch(id,{status:'paused',message:'已暂停入库，已完成批次保留；继续不会重复导入。'});break;}
      const rows=db.prepare("SELECT row,data FROM growth_import_rows WHERE job=? AND state='ready' ORDER BY row LIMIT 100").all(id);
      if(!rows.length){db.exec('SAVEPOINT import_finish');try{patch(id,{status:'completed',finishedAt:clock(),message:'导入完成。新知识均为停用状态，请审核后启用。'});db.prepare('DELETE FROM growth_import_chunks WHERE job=?').run(id);db.exec('RELEASE import_finish');}catch(e){db.exec('ROLLBACK TO import_finish');db.exec('RELEASE import_finish');throw e;}event('','大文件知识导入',j.filename+' / '+j.added+' 条');break;}
      let added=0,skipped=0;
      db.exec('SAVEPOINT import_commit');try{
        for(const row of rows){const k=JSON.parse(row.data),old=duplicate(k);if(old){skipped++;db.prepare("UPDATE growth_import_rows SET state='duplicate',reason='入库前发现相同知识' WHERE job=? AND row=?").run(id,row.row);continue;}
          const saved=knowledge.save({...k,source:j.filename,sourceMeta:{kind:'file',filename:j.filename,importId:id,row:row.row,sha256:j.sha256}});added++;
          db.prepare("UPDATE growth_import_rows SET state='imported',knowledgeId=? WHERE job=? AND row=?").run(saved.id,id,row.row);
        }
        patch(id,{added:j.added+added,duplicates:j.duplicates+skipped,processed:j.processed+rows.length,message:'正在分批写入，关闭页面不影响后台任务。'});db.exec('RELEASE import_commit');
      }catch(e){db.exec('ROLLBACK TO import_commit');db.exec('RELEASE import_commit');throw e;}
    }
  }
  function launch(id,phase){
    if(running.has(id))return detail(id);
    if([...running.values()].some(v=>v!=='upload'))fail('当前空间已有文件在解析或入库，请完成或暂停后再试',409);
    running.set(id,phase);patch(id,{phase,status:phase==='parse'?'parsing':'committing',error:''});
    void (phase==='parse'?parse(id):commit(id)).catch(e=>patch(id,{status:e.paused?'paused':'failed',error:e.paused?'':String(e.message).slice(0,500),message:e.paused?e.message:'处理已停止；已上传数据和已完成批次保留。'})).finally(()=>running.delete(id));return detail(id);
  }
  function control(id,action){
    const j=detail(id);
    if(action==='pause'){if(['parsing','committing'].includes(j.status))return patch(id,{status:'pausing',message:'将在当前批次结束后暂停。'});return j;}
    if(action==='cancel'){if(running.has(id))fail('请先暂停，等待当前批次完成',409);if(j.status==='completed')fail('已完成的任务无需取消');db.exec('SAVEPOINT import_cancel');try{db.prepare('DELETE FROM growth_import_chunks WHERE job=?').run(id);db.prepare("DELETE FROM growth_import_rows WHERE job=? AND state!='imported'").run(id);patch(id,{status:'cancelled',message:'已取消并释放上传缓存；已经入库的知识保留。'});db.exec('RELEASE import_cancel');}catch(e){db.exec('ROLLBACK TO import_cancel');db.exec('RELEASE import_cancel');throw e;}return detail(id);}
    if(action==='parse'&&j.status==='uploading'){if(j.offset!==j.size)fail('文件尚未上传完整');return launch(id,'parse');}
    if(action==='commit'&&j.status==='review')return launch(id,'commit');
    if(action==='resume'&&['paused','interrupted','failed'].includes(j.status))return launch(id,j.phase);
    fail('当前任务状态不支持此操作',409);
  }
  function page(id,{page=1,status='all'}={}){
    if(!['all','ready','error','duplicate','imported'].includes(status))fail('无效的条目状态');
    detail(id);const where=status==='all'?'job=?':'job=? AND state=?',args=status==='all'?[id]:[id,status];
    const total=db.prepare('SELECT count(*) n FROM growth_import_rows WHERE '+where).get(...args).n,p=Math.max(1,Math.min(Math.ceil(total/50)||1,Math.floor(Number(page))||1));
    const list=db.prepare('SELECT row,data,state,reason,knowledgeId FROM growth_import_rows WHERE '+where+' ORDER BY row LIMIT 50 OFFSET ?').all(...args,(p-1)*50).map(({data,...r})=>({...r,...JSON.parse(data)}));return {list,total,page:p};
  }
  const hashes=id=>{detail(id);return db.prepare('SELECT offset,hash FROM growth_import_chunks WHERE job=? ORDER BY offset').all(id);};
  return {start,detail,list,upload,control,page,hashes,limits:{chunk:CHUNK,bytes:MAX_BYTES,rows:MAX_ROWS}};
}
module.exports={createKnowledgeImport,records};
