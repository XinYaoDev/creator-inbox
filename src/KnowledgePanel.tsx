import {useEffect,useRef,useState} from 'react'
import DocumentKnowledgePanel from './DocumentKnowledgePanel'
import WebKnowledgePanel from './WebKnowledgePanel'
import VectorIndexPanel from './VectorIndexPanel'
import LargeKnowledgeImport from './LargeKnowledgeImport'
import KnowledgeSourcesPanel from './KnowledgeSourcesPanel'
import KnowledgeHistoryDrawer from './KnowledgeHistoryDrawer'
import KnowledgePasteImport from './KnowledgePasteImport'
type Item={id:string;[key:string]:any}
type View='library'|'import'|'sources'|'verify'
type ImportMode='large'|'document'|'web'|'paste'
const views=[['library','知识列表'],['import','采集与导入'],['sources','来源持续同步'],['verify','检索验证']] as const
const importModes=[['large','大文件导入','分块续传 · 最高 512 MiB'],['document','PDF / 图片 OCR','文字提取 · 本地识别'],['web','单次网页采集','公开网页 · 支持动态加载'],['paste','粘贴 / 小文件','文本、表格与常见问答']] as const
function KnowledgeSource({meta}:{meta:any}){
  if(!meta)return null
  if(meta.kind==='file')return <span>文件：{meta.filename} · 第 {meta.row} 条{meta.sha256&&<span title={meta.sha256}> · 已校验</span>}</span>
  return <span>{meta.kind==='web'?<a href={meta.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">来源网页 · 第 {meta.part||1} 部分 ↗</a>:<>{meta.kind==='ocr'?'本地 OCR':'PDF 文字层'} · {meta.filename} · 第 {meta.page} 页{Number.isFinite(meta.confidence)?` · 置信度 ${Math.round(meta.confidence)}%（需校对）`:''}</>}</span>
}
type Props={items:Item[];index:any;busy:boolean;request:(path:string,body?:unknown,method?:string)=>Promise<any>;action:(fn:()=>Promise<unknown>,success?:string)=>Promise<void>;onEdit:(k:Item)=>void}
export default function KnowledgePanel({items,index,busy,request,action,onEdit}:Props){
  const root=useRef<HTMLDivElement>(null),scrollPositions=useRef<Partial<Record<View,number>>>({})
  const [view,setView]=useState<View>('library'),[visited,setVisited]=useState<Record<string,boolean>>({library:true,large:true}),[importMode,setImportMode]=useState<ImportMode>('large')
  const [query,setQuery]=useState(''),[category,setCategory]=useState('all'),[status,setStatus]=useState('active'),[question,setQuestion]=useState(''),[results,setResults]=useState<any>(null)
  const [history,setHistory]=useState<Item|null>(null)
  const [page,setPage]=useState(1),[listing,setListing]=useState<{list:Item[];total:number;page:number;categories?:string[]}>({list:[],total:0,page:1}),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState('')
  const [selected,setSelected]=useState<Record<string,number>>({}),[batch,setBatch]=useState('')
  const visible=listing.list,selectedCount=Object.keys(selected).length,totalPages=Math.max(1,Math.ceil(listing.total/50))
  const navigate=(next:View)=>{
    const scroller=root.current?.closest('.g-content')
    if(scroller)scrollPositions.current[view]=scroller.scrollTop
    setView(next);setVisited(v=>({...v,[next]:true}))
    requestAnimationFrame(()=>{if(scroller)scroller.scrollTop=scrollPositions.current[next]||0})
  }
  const resetFilters=()=>{setQuery('');setCategory('all');setStatus('active')}
  const changePage=(next:number)=>{setPage(next);setSelected({});setBatch('');root.current?.closest('.g-content')?.scrollTo({top:0})}
  useEffect(()=>{setPage(1);setSelected({});setBatch('')},[query,category,status])
  useEffect(()=>{
    let active=true;setLoading(true)
    const timer=setTimeout(()=>{request('/knowledge/list?'+new URLSearchParams({q:query,category,status,page:String(page),limit:'50'})).then(data=>{if(active){setListing(data);setLoadError('');if(data.page!==page)setPage(data.page)}}).catch(e=>{if(active)setLoadError(e.message)}).finally(()=>{if(active)setLoading(false)})},180)
    return()=>{active=false;clearTimeout(timer)}
  },[request,query,category,status,page,items])
  const doBatch=()=>action(async()=>{await request('/knowledge/batch',{action:batch,items:Object.entries(selected).map(([id,expectedVersion])=>({id,expectedVersion}))});setSelected({});setBatch('')},'所选知识已更新；已有索引自动检查失效，新增内容需建立索引')
  const pagination=(position:string)=><nav className="g-knowledge-pagination" aria-label={'知识分页（'+position+'）'}><span>{loading?'正在加载…':`${listing.page} / ${totalPages} 页`}</span><button aria-label={'上一页（'+position+'）'} disabled={loading||page<=1} onClick={()=>changePage(page-1)}>上一页</button><button aria-label={'下一页（'+position+'）'} disabled={loading||page>=totalPages} onClick={()=>changePage(page+1)}>下一页</button></nav>
  return <div className="g-knowledge-workspace" ref={root}>
    <nav className="g-knowledge-nav" aria-label="知识库功能">{views.map(([key,label])=><button key={key} aria-current={view===key?'page':undefined} onClick={()=>navigate(key)}>{label}</button>)}</nav>
    <div hidden={view!=='library'}>
      <section className="g-knowledge-filterbar" aria-label="查找知识">
        <div className="g-knowledge-search"><input type="search" aria-label="搜索知识标题或内容" placeholder="搜索标题或正文，覆盖完整知识库…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清除知识搜索" onClick={()=>setQuery('')}>清除</button>}</div>
        <select aria-label="知识分类" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">全部分类</option>{(listing.categories||[...new Set(items.map(k=>k.category))]).map(c=><option key={c}>{c}</option>)}</select>
        <select aria-label="知识状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="active">未归档</option><option value="enabled">已启用</option><option value="disabled">待启用 / 已停用</option><option value="archived">已归档（可恢复）</option></select>
        {(query||category!=='all'||status!=='active')&&<button className="text" onClick={resetFilters}>重置筛选</button>}
      </section>
      <section className="g-panel g-knowledge-list-panel" aria-label="业务知识列表">
        <div className="g-knowledge-list-heading"><div><strong>{listing.total.toLocaleString()} <span>条匹配知识</span></strong><p>每页 50 条 · 只有已启用、未归档的知识用于回答</p></div>{pagination('顶部')}</div>
        <section className={'g-knowledge-bulk'+(selectedCount?' has-selection':'')} aria-label="批量知识操作"><label><input type="checkbox" aria-label="选择本页知识" disabled={loading||!visible.length} checked={!!visible.length&&visible.every(k=>selected[k.id]!==undefined)} onChange={e=>{setSelected(e.target.checked?Object.fromEntries(visible.map(k=>[k.id,k.version||1])):{});setBatch('')}}/>选择本页</label>
          {selectedCount?<><span>已选 {selectedCount} 条</span>{[['enable','批量启用'],['disable','批量停用'],['archive','批量归档'],['restore','批量恢复']].filter(([op])=>status==='archived'?op==='restore':op!=='restore').map(([op,label])=><button key={op} disabled={busy||loading} onClick={()=>setBatch(op)}>{label}</button>)}<button className="text" onClick={()=>{setSelected({});setBatch('')}}>取消选择</button></>:<span>点击标题查看完整内容与版本记录</span>}
        </section>
        {batch&&<div className="g-context-note" role="group" aria-label="确认批量知识操作"><p>{batch==='enable'?'请确认已审核所选内容：启用后 AI 可检索这些知识。':batch==='archive'?'归档后停止用于回答，内容和版本历史保留。':batch==='restore'?'恢复后默认停用，请审核再启用。':'停用后不再用于新的知识回答。'} 仅处理选中的 {selectedCount} 条，不包含其他页面。</p><div className="g-actions"><button className="primary" disabled={busy||loading} onClick={doBatch}>确认处理所选知识</button><button disabled={busy||loading} onClick={()=>setBatch('')}>取消</button></div></div>}
        {loadError&&<p className="g-context-note" role="alert">{loadError}</p>}
        <div aria-busy={loading} className="g-knowledge-rows">{visible.map(k=><article className="g-knowledge-item" key={k.id}>
          <input type="checkbox" aria-label={'选择知识：'+k.title} disabled={loading||busy} checked={selected[k.id]!==undefined} onChange={e=>{setSelected(previous=>{const next={...previous};if(e.target.checked)next[k.id]=k.version||1;else delete next[k.id];return next});setBatch('')}}/>
          <div className="g-knowledge-item-main"><div className="g-knowledge-item-title"><button className="text" aria-label={'查看知识与版本：'+k.title} disabled={loading} onClick={()=>setHistory(k)}>{k.title}</button><span className={'g-badge '+(k.enabled?'green':'neutral')}>{k.archived?'已归档':k.enabled?'已启用':'已停用'}</span></div><p className="g-knowledge-excerpt">{k.body.slice(0,220)}</p><div className="g-knowledge-item-meta"><span>{k.category}</span><span>v{k.version||1}</span><KnowledgeSource meta={k.sourceMeta}/>{!k.sourceMeta&&<span>{k.source||'手动录入'}</span>}</div></div>
          <div className="g-knowledge-item-actions">{!k.archived&&<><button disabled={busy||loading} onClick={()=>action(async()=>onEdit(await request('/knowledge/'+k.id)))}>编辑</button><button disabled={busy||loading} onClick={()=>action(()=>request('/knowledge/'+k.id,{enabled:!k.enabled,expectedVersion:k.version||1},'PATCH'),'知识状态已更新')}>{k.enabled?'停用':'启用'}</button></>}
            <button disabled={loading} onClick={()=>setHistory(k)}>版本记录</button><button className="text" disabled={busy||loading} onClick={()=>action(()=>request('/knowledge/'+k.id,{archived:!k.archived,enabled:false,expectedVersion:k.version||1},'PATCH'),k.archived?'已恢复，请确认后启用':'已归档，可在归档列表恢复')}>{k.archived?'恢复到知识库':'归档'}</button>
          </div>
        </article>)}</div>
        {!loading&&!visible.length&&<div className="g-empty"><h3>当前筛选下没有知识</h3><p>可以调整筛选，或采集、导入业务资料。</p><div className="g-actions"><button onClick={resetFilters}>清除筛选</button><button onClick={()=>navigate('import')}>采集与导入</button></div></div>}
        <footer className="g-knowledge-list-footer"><span>版本记录就地打开，不改变列表位置</span>{pagination('底部')}</footer>
      </section>
    </div>
    <div hidden={view!=='import'}>
      <div className="g-knowledge-section-heading"><h3>把业务资料整理进来</h3><p>采集 / 识别 → 校对 → 导入 → 审核启用。切换此处功能不会丢失未提交内容。</p></div>
      <nav className="g-knowledge-import-modes" aria-label="选择知识导入方式">{importModes.map(([mode,label,hint])=><button key={mode} aria-current={importMode===mode?'page':undefined} onClick={()=>{setImportMode(mode);setVisited(v=>({...v,[mode]:true}))}}><strong>{label}</strong><small>{hint}</small></button>)}</nav>
      {visited.import&&<>
        <div hidden={importMode!=='large'}>{visited.large&&<LargeKnowledgeImport request={request} action={action}/>}</div>
        <div hidden={importMode!=='document'}>{visited.document&&<DocumentKnowledgePanel request={request} action={action} busy={busy}/>}</div>
        <div hidden={importMode!=='web'}>{visited.web&&<WebKnowledgePanel request={request} action={action} busy={busy}/>}</div>
        <div hidden={importMode!=='paste'}>{visited.paste&&<KnowledgePasteImport request={request} action={action} busy={busy} onImported={()=>{setStatus('disabled');navigate('library')}}/>}</div>
      </>}
    </div>
    <div hidden={view!=='sources'}>{visited.sources&&<KnowledgeSourcesPanel request={request} action={action} busy={busy}/>}</div>
    <div hidden={view!=='verify'} className="g-knowledge-verify">
      <section className="g-panel g-retrieval"><span className="g-badge green">检索验证</span><h3>这个问题，能找到答案吗？</h3><p>只检索当前空间已启用、未归档的知识。实际接待时还会遵守员工的知识范围。这里不生成 AI 答复，也不发送平台消息。</p>
        <form onSubmit={e=>{e.preventDefault();void action(async()=>setResults(await request('/knowledge/search',{query:question})))}}><textarea aria-label="知识检索问题" rows={4} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="例如：周末几点可以入住？" required/><button className="primary" disabled={busy}>测试检索 →</button></form>
        {results&&<p className="g-hint">实际检索：{results.mode==='hybrid'?(results.provider==='local'?'本地向量 + 关键词':'API 向量 + 关键词'):'关键词'}{results.model?' · '+results.model:''}{Number.isFinite(results.scanned)?` · 扫描 ${results.scanned.toLocaleString()} 个向量`:''}</p>}
        {results?.warning&&<p className="g-context-note">{results.warning}</p>}{!!results?.expandedTerms?.length&&<p className="g-hint">口语概念扩展：{results.expandedTerms.join('、')}（仅辅助检索，不添加业务事实）</p>}
        {results?.list.map((k:Item)=><div className="g-hit" key={k.id}><strong>{k.title} · v{k.version||1}</strong><span className="g-badge">{k.match==='hybrid'?'语义 + 关键词':k.match==='semantic'?'语义匹配':'关键词匹配'}{k.similarity!==undefined?' · 相似度 '+k.similarity.toFixed(3):''}</span><p>{k.body}</p>{k.chunkIndex!==undefined&&<small>片段 {k.chunkIndex+1} · 相似度不是答案正确率</small>}<button onClick={()=>setHistory(k)}>查看知识与版本</button></div>)}{results?.list.length===0&&<p className="g-context-note">没有足够相关的知识，请补充资料或换一种问法。</p>}
      </section>
      <aside className="g-panel g-knowledge-index"><h3>检索索引</h3><p className="g-hint">知识有变更后，在这里检查进度并续建。</p><VectorIndexPanel index={index} busy={busy} request={request} action={action}/></aside>
    </div>
    {history&&<KnowledgeHistoryDrawer key={history.id} knowledge={history} busy={busy} request={request} action={action} onClose={()=>setHistory(null)} onRestored={()=>{setHistory(null);setStatus('disabled');navigate('library')}}/>}
  </div>
}
