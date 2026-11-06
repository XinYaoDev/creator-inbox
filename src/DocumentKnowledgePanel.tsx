import {useEffect,useRef,useState} from 'react'
import type {ExtractedPage,ExtractOptions} from './ocrKnowledge'
export default function DocumentKnowledgePanel({request,action,busy}:any){
  const [file,setFile]=useState<File|null>(null),[category,setCategory]=useState('文档资料'),[mode,setMode]=useState<ExtractOptions['mode']>('auto'),[language,setLanguage]=useState('chi_sim+eng'),[start,setStart]=useState(1),[end,setEnd]=useState(20)
  const [running,setRunning]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState(''),[items,setItems]=useState<(ExtractedPage&{selected:boolean})[]>([]),[preview,setPreview]=useState<any>(null)
  const controller=useRef<AbortController>(),mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort()}},[])
  useEffect(()=>{if(!running)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[running])
  const payload=()=>({filename:file?.name||'本地文档',format:'json',content:JSON.stringify(items.filter(i=>i.selected).map(({selected,...i})=>i)),category})
  const update=(index:number,patch:Partial<typeof items[number]>)=>{setItems(items.map((v,i)=>i===index?{...v,...patch}:v));setPreview(null)}
  const extract=async()=>{
    if(!file||running)return
    controller.current=new AbortController();setRunning(true);setError('');setPreview(null);setItems([])
    const signal=controller.current.signal,options={mode,language,start,end,signal},report=(s:string)=>{if(mounted.current)setProgress(s)}
    try{
      const result=file.name.toLowerCase().endsWith('.pdf')?await (await import('./pdfKnowledge')).readPdfKnowledge(file,category,report,options):await (await import('./ocrKnowledge')).readImageKnowledge(file,category,options,report)
      if(!mounted.current)return;setItems(result.items.map(i=>({...i,selected:true})));setProgress(result.message)
    }catch(e){if(mounted.current){setError(signal.aborted?'识别已取消，可以更换文件或重新识别':(e as Error).message);setProgress('')}}
    finally{if(mounted.current)setRunning(false)}
  }
  return <section className="g-panel g-source-panel"><div className="g-source-heading"><span className="g-badge green">本地识别 · 无需密钥</span><h3>PDF 与图片转知识</h3><p>原文件留在当前设备，识别资源随应用提供。自动模式优先提取文字层，少于 30 字的页面使用 OCR；可强制 OCR。识别不会自动启用知识。</p></div>
    <fieldset className="g-permission" disabled={running||busy}><div className="g-form-grid">
      <label className="g-field">文档或图片<input aria-label="OCR 文档文件" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={e=>{setFile(e.target.files?.[0]||null);setItems([]);setPreview(null);setError('');setProgress('')}}/></label>
      <label className="g-field">默认分类<input value={category} onChange={e=>setCategory(e.target.value)} maxLength={100}/></label>
      <label className="g-field">PDF 识别方式<select value={mode} onChange={e=>setMode(e.target.value as ExtractOptions['mode'])}><option value="auto">自动：文字层优先，无文字页 OCR</option><option value="always">全部选中页 OCR（混合内容适用）</option><option value="never">仅文字层（不做 OCR）</option></select></label>
      <label className="g-field">OCR 语言<select value={language} onChange={e=>setLanguage(e.target.value)}><option value="chi_sim+eng">简体中文 + English</option><option value="chi_sim">简体中文</option><option value="eng">English</option></select></label>
      <label className="g-field">PDF 起始页<input type="number" min={1} max={80} value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label className="g-field">PDF 结束页<input type="number" min={start} max={80} value={end} onChange={e=>setEnd(Number(e.target.value))}/></label>
    </div><p className="g-hint">每个文件不超过 10 MB，PDF 不超过 80 页，单次最多 OCR 20 页；图片仅识别一张。复杂表格、手写字、倾斜或低清图片需要人工校对。</p><button className="primary" disabled={!file} onClick={()=>void extract()}>开始本地识别</button></fieldset>
    {running&&<button onClick={()=>controller.current?.abort()}>取消识别</button>}
    {progress&&<p className="g-context-note" role="status" aria-live="polite">{progress}</p>}{error&&<p className="g-error" role="alert">{error}</p>}
    {!!items.length&&<fieldset className="g-permission" disabled={busy||running}><h4>校对识别结果 · {items.filter(i=>i.selected).length} 条已选</h4><div className="g-source-review">{items.map((item,index)=><article key={index}><header><label><input type="checkbox" checked={item.selected} onChange={e=>update(index,{selected:e.target.checked})}/> 第 {item.sourceMeta.page} 页</label><span className="g-badge">{item.sourceMeta.kind==='ocr'?`OCR · 置信度 ${Math.round(item.sourceMeta.confidence||0)}%`:'PDF 文字层'}</span></header><label className="g-field">知识标题<input value={item.title} onChange={e=>update(index,{title:e.target.value})} maxLength={200}/></label><label className="g-field">校对正文<textarea aria-label={'识别正文 '+(index+1)} rows={6} value={item.body} onChange={e=>update(index,{body:e.target.value})}/></label></article>)}</div>
      <p className="g-hint">置信度仅是识别引擎估计，不等于准确率。请核对名称、数字、地址和业务承诺，再检查重复条目。</p>
      <button disabled={!items.some(i=>i.selected)} onClick={()=>action(async()=>setPreview(await request('/knowledge/import-preview',payload())))}>检查重复与导入预览</button>
      {preview&&<div className="g-context-note"><p>将新增 {preview.added} 条，跳过 {preview.skipped} 条重复；新增默认停用。</p><button className="primary" disabled={!preview.added} onClick={()=>action(async()=>{await request('/knowledge/import',payload());setItems([]);setPreview(null);setProgress('导入完成，请在知识列表审核并启用。')},'识别知识已导入，尚未启用')}>确认导入识别知识</button></div>}
    </fieldset>}
  </section>
}
