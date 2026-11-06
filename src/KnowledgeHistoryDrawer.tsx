import {useEffect,useRef,useState} from 'react'
type Item={id:string;[key:string]:any}
type Props={knowledge:Item;busy:boolean;request:(path:string,body?:unknown,method?:string)=>Promise<any>;action:(fn:()=>Promise<unknown>,success?:string)=>Promise<void>;onClose:()=>void;onRestored:()=>void}
export default function KnowledgeHistoryDrawer({knowledge,busy,request,action,onClose,onRestored}:Props){
  const dialog=useRef<HTMLDialogElement>(null)
  const [current,setCurrent]=useState(knowledge),[revisions,setRevisions]=useState<Item[]>([])
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0),[confirm,setConfirm]=useState(''),[revisionId,setRevisionId]=useState('')
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,element=dialog.current
    element?.showModal()
    return()=>{element?.close();if(previous?.isConnected)previous.focus({preventScroll:true})}
  },[])
  useEffect(()=>{
    let active=true;setLoading(true);setError('');setConfirm('')
    Promise.all([request('/knowledge/'+knowledge.id),request('/knowledge/'+knowledge.id+'/versions')]).then(([item,history])=>{if(active){setCurrent(item);setRevisions(history.list);setRevisionId(history.list[0]?.id||'')}}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[knowledge.id,request,reload])
  const restore=(revision:Item)=>action(async()=>{
    try{setError('');await request('/knowledge/'+knowledge.id+'/restore',{revisionId:revision.id,expectedVersion:current.version||1});onRestored()}
    catch(e){setError((e as Error).message);throw e}
  },'已恢复为新版本，审核后可启用')
  return <dialog ref={dialog} className="g-knowledge-drawer" aria-labelledby="knowledge-history-title" onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
    <header className="g-knowledge-drawer-head"><div><span className="g-eyebrow">知识详情</span><h2 id="knowledge-history-title">版本记录</h2></div><button autoFocus disabled={busy} aria-label="关闭版本记录" onClick={onClose}>关闭 <span aria-hidden="true">×</span></button></header>
    {!!revisions.length&&<div className="g-history-picker"><label htmlFor="knowledge-revision">查看版本</label><select id="knowledge-revision" aria-label="选择知识版本" value={revisionId} disabled={busy||loading} onChange={e=>{setRevisionId(e.target.value);setConfirm('');dialog.current?.querySelector('.g-knowledge-drawer-body')?.scrollTo({top:0})}}>{revisions.map(r=><option key={r.id} value={r.id}>v{r.version}{current.version===r.version?'（当前）':''} · {new Date(r.created*1000).toLocaleString('zh-CN')} · {r.actor||'本地操作'}</option>)}</select><span>{revisions.length} 个版本</span></div>}
    <div className="g-knowledge-drawer-body" aria-busy={loading}>
      <h3 className="g-history-title">{current.title}</h3><p className="g-history-meta">{current.category} · 当前 v{current.version||1} · {current.archived?'已归档':current.enabled?'已启用':'待启用 / 已停用'}</p>
      <p className="g-context-note">恢复会创建新版本，原有历史不会被覆盖。恢复后默认停用，审核后再启用。</p>
      {loading&&<p role="status">正在读取版本记录…</p>}
      {error&&<div className="g-history-error" role="alert"><p>{error}</p><button disabled={busy||loading} onClick={()=>setReload(n=>n+1)}>重新读取最新版本</button></div>}
      {!loading&&!error&&!revisions.length&&<p>暂无历史版本。</p>}
      {!loading&&revisions.filter(r=>r.id===revisionId).map(r=><article className="g-history-revision" key={r.id}>
        <header className="g-history-version-head"><span className="g-history-version">v{r.version}</span><span><strong>{r.snapshot.title}</strong><small>{new Date(r.created*1000).toLocaleString('zh-CN')} · {r.actor||'本地操作'}</small></span>{current.version===r.version&&<span className="g-badge green">当前版本</span>}</header>
        <div className="g-history-revision-content"><p className="g-history-meta">分类：{r.snapshot.category||'未分类'} · {r.snapshot.archived?'已归档':r.snapshot.enabled?'已启用':'已停用'}</p>
          {current.version!==r.version&&(confirm===r.id?<div className="g-context-note" role="group" aria-label="确认恢复知识版本"><p>将 v{r.version} 的内容恢复为新版本并停用这条知识。确认继续？</p><div className="g-actions"><button className="primary" disabled={busy} onClick={()=>restore(r)}>确认恢复 v{r.version}</button><button disabled={busy} onClick={()=>setConfirm('')}>取消</button></div></div>:<button disabled={busy||!!error} onClick={()=>setConfirm(r.id)}>恢复此版本</button>)}
          <div className="g-history-body">{r.snapshot.body}</div>
        </div>
      </article>)}
    </div>
  </dialog>
}
