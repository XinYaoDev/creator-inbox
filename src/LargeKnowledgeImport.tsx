import {useEffect,useRef,useState} from 'react'
import {api} from './api'
const names:Record<string,string>={uploading:'等待上传 / 可续传',parsing:'校验与解析',review:'等待确认入库',committing:'正在分批入库',pausing:'正在暂停',paused:'已暂停',interrupted:'服务重启后待继续',failed:'处理失败',completed:'已完成',cancelled:'已取消'}
const size=(n:number)=>(n/1024/1024).toFixed(1)+' MiB'
export default function LargeKnowledgeImport({request,action}:any){
  const [jobs,setJobs]=useState<any[]>([]),[job,setJob]=useState<any>(null),[category,setCategory]=useState('大文件资料'),[error,setError]=useState(''),[uploading,setUploading]=useState(false),[progress,setProgress]=useState(0),[note,setNote]=useState(''),[page,setPage]=useState(1),[filter,setFilter]=useState('all'),[rows,setRows]=useState<any>({list:[],total:0,page:1}),[confirm,setConfirm]=useState('');
  const stopped=useRef(false),selectedFile=useRef<HTMLInputElement>(null),refreshed=useRef(new Set<string>());
  const load=async()=>{const r=await request('/knowledge/imports');setJobs(r.list);return r;};
  useEffect(()=>{stopped.current=false;void load().catch((e:Error)=>setError(e.message));return()=>{stopped.current=true};},[]);
  useEffect(()=>{
    if(!job)return;let active=true,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const next=await request('/knowledge/imports/'+job.id);if(!active)return;setJob(next);if(['parsing','committing','pausing'].includes(next.status))timer=setTimeout(poll,1200);else{await load();if(next.status==='completed'&&!refreshed.current.has(next.id)){refreshed.current.add(next.id);await action(async()=>{});}}}catch(e){if(active)setError((e as Error).message);}};
    void poll();return()=>{active=false;clearTimeout(timer)};
  },[job?.id,job?.status,request]);
  useEffect(()=>{if(!job||['uploading','parsing'].includes(job.status))return;let active=true;request('/knowledge/imports/'+job.id+'/rows?'+new URLSearchParams({page:String(page),status:filter})).then((r:any)=>{if(active)setRows(r)}).catch((e:Error)=>setError(e.message));return()=>{active=false}},[job?.id,job?.status,page,filter,request]);
  async function upload(file:File){
    stopped.current=false;setUploading(true);setError('');setNote('准备上传…');
    try{
      if(file.size>512*1024**2)throw Error('单文件最多 512 MiB，请按章节或业务分类拆分');
      let current=job?.status==='uploading'?job:await request('/knowledge/imports',{filename:file.name,size:file.size,category});
      if(current.filename!==file.name||current.size!==file.size)throw Error('请重新选择原文件；要上传其他文件，请先点击“新建任务”');
      setJob(current);setPage(1);setFilter('all');const chunks=(await request('/knowledge/imports/'+current.id+'/hashes')).list,known=new Map(chunks.map((c:any)=>[c.offset,c.hash]));
      for(let offset=0;offset<file.size;offset+=1024**2){
        if(stopped.current)break;
        const data=await file.slice(offset,offset+1024**2).arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
        if(offset<current.offset){setNote('正在逐块验证原文件，确认后续传');if(known.get(offset)!==hash)throw Error('所选文件与已上传内容不一致，未继续写入。请使用原文件或新建任务。');}
        else{
          setNote('按块上传并校验；点击暂停会保留进度');
          const r=await api('/api/growth/knowledge/imports/'+current.id+'/chunk?offset='+offset,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Chunk-SHA256':hash},body:data});const result=await r.json();if(!r.ok)throw Error(result.error||'上传失败，可重新选择文件续传');current=result;setJob(current);
        }setProgress(offset+data.byteLength);
      }
      if(!stopped.current&&current.offset===file.size){setJob(await request('/knowledge/imports/'+current.id+'/control',{action:'parse'}));setNote('完整上传已保留，后台开始解析。');}
      else setNote('上传已暂停。重新选择同一文件即可继续，不必重新上传已确认的分块。');
      await load();
    }catch(e){setError((e as Error).message)}finally{setUploading(false);if(selectedFile.current)selectedFile.current.value='';}
  }
  const control=(command:string)=>action(async()=>{setError('');setJob(await request('/knowledge/imports/'+job.id+'/control',{action:command}));setConfirm('');await load();});
  const percent=job?(job.status==='uploading'?Math.min(100,Math.round((uploading?progress:job.offset)/job.size*100)):job.status==='committing'?Math.round(job.processed/Math.max(1,job.valid)*100):Math.round((job.bytes||0)/job.size*100)):0;
  return <section className="g-panel g-source-panel"><div className="g-source-heading"><span className="g-badge green">大文件 · 可恢复任务</span><h3>分批导入，不打断工作</h3><p>UTF-8 CSV、JSON 数组、JSONL、TXT、Markdown；单文件最多 512 MiB、200000 条。每块校验，后台解析，分页审核后入库。每条正文最多 30000 字；TXT / Markdown 自动按段拆分。PDF / 图片仍使用独立提取入口。</p><p className="g-hint">上传时请保持本页打开；上传完成后可离开页面。退出整个客户端会暂停任务，重新打开后点“继续”。新条目默认停用，不会直接用于 AI 回答。</p></div>
    <div className="g-form-grid"><label className="g-field">默认分类<input disabled={uploading||!!job} value={category} onChange={e=>setCategory(e.target.value)} maxLength={100}/></label><label className="g-field">{job?.status==='uploading'?'重新选择同一文件续传':'选择大文件'}<input ref={selectedFile} type="file" aria-label="选择大文件导入" disabled={uploading||!!job&&job.status!=='uploading'} accept=".csv,.json,.jsonl,.ndjson,.txt,.md" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file)}}/></label></div>
    <div className="g-actions"><button disabled={uploading} onClick={()=>{setJob(null);setRows({list:[],total:0,page:1});setError('');setNote('');setConfirm('')}}>新建任务</button>{uploading&&<button onClick={()=>{stopped.current=true;setNote('当前块完成后暂停…')}}>暂停上传</button>}</div>
    {error&&<p className="g-error" role="alert">{error}</p>}{note&&<p role="status">{note}</p>}
    {job&&<><div className="g-source-status" role="status"><strong>{names[job.status]}</strong><span>{job.filename} · {size(job.size)}</span></div><progress className="g-import-progress" max={100} value={percent} aria-label="导入进度"/><p className="g-hint">上传 {size(job.offset)} / {size(job.size)} · 解析 {job.rows.toLocaleString()} 条 · 有效 {job.valid.toLocaleString()} · 重复 {job.duplicates.toLocaleString()} · 错误 {job.errors.toLocaleString()} · 已入库 {job.added.toLocaleString()}</p><p>{job.message}</p>{job.error&&<p className="g-error" role="alert">{job.error}</p>}
      <div className="g-actions">{['parsing','committing'].includes(job.status)&&<button onClick={()=>control('pause')}>暂停处理</button>}{['paused','interrupted','failed'].includes(job.status)&&<button className="primary" onClick={()=>control('resume')}>继续处理</button>}{job.status==='uploading'&&job.offset===job.size&&!uploading&&<button onClick={()=>control('parse')}>重新开始校验</button>}{job.status==='review'&&<button className="primary" onClick={()=>setConfirm('commit')}>确认有效条目入库</button>}{!uploading&&!['parsing','committing','pausing','completed','cancelled'].includes(job.status)&&<button onClick={()=>setConfirm('cancel')}>取消此任务</button>}</div>
      {confirm&&<div className="g-context-note"><p>{confirm==='commit'?`将导入 ${job.valid} 条有效知识，跳过重复及错误行；默认停用。请确认已检查下方分页预览。`:'取消会释放未入库的上传缓存。已经入库的知识和原始文件保留，不会回退业务数据。'}</p><button onClick={()=>control(confirm)}>确认{confirm==='commit'?'入库':'取消任务'}</button><button onClick={()=>setConfirm('')}>返回检查</button></div>}
      {!['uploading','parsing'].includes(job.status)&&<><div className="g-toolbar"><label>查看条目 <select value={filter} onChange={e=>{setFilter(e.target.value);setPage(1)}}><option value="all">全部</option><option value="ready">有效待入库</option><option value="error">格式错误</option><option value="duplicate">重复跳过</option><option value="imported">已经入库</option></select></label><span>匹配 {rows.total.toLocaleString()} 条 · 每页 50 条</span></div><div className="g-table-wrap"><table className="g-table"><thead><tr><th>条目号</th><th>标题 / 内容预览</th><th>结果</th></tr></thead><tbody>{rows.list.map((r:any)=><tr key={r.row}><td>{r.row}</td><td><strong>{r.title||'无法解析的条目'}</strong><p>{r.body?.slice(0,160)}</p></td><td>{{ready:'待入库',error:'格式错误',duplicate:'重复',imported:'已入库'}[r.state as string]}<p>{r.reason}</p></td></tr>)}</tbody></table></div><nav className="g-pagination" aria-label="导入预览分页"><button disabled={rows.page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {rows.page} / {Math.max(1,Math.ceil(rows.total/50))} 页</span><button disabled={rows.page*50>=rows.total} onClick={()=>setPage(p=>p+1)}>下一页</button></nav></>}
      {job.sha256&&<details><summary>文件完整性 SHA-256</summary><code className="g-import-digest">{job.sha256}</code></details>}
    </>}
    <details className="g-source-history"><summary>最近导入任务（{jobs.length}）</summary>{jobs.map(j=><div key={j.id}><button disabled={uploading} onClick={()=>{setJob(j);setPage(1);setFilter('all');setConfirm('');setError('');setNote('')}}>{names[j.status]} · {j.filename} · {j.added} 条已入库</button><small>{new Date(j.created*1000).toLocaleString('zh-CN')}</small></div>)}</details>
  </section>
}
