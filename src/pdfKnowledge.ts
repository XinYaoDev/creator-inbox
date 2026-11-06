import {checkExtracted,cleanText,createLocalOCR,type ExtractedPage,type ExtractOptions} from './ocrKnowledge'
// PDF bytes and page images never leave the browser. Only reviewed text is imported.
export async function readPdfKnowledge(file:File,category:string,onProgress:(message:string)=>void,options?:ExtractOptions){
  if(file.size>10*1024*1024)throw Error('PDF 不能超过 10 MB，请拆分后导入')
  const settings=options||{mode:'auto',language:'chi_sim+eng',start:1,end:80,signal:new AbortController().signal}
  const signal=AbortSignal.any([settings.signal,AbortSignal.timeout(10*60*1000)])
  onProgress('正在加载本地 PDF 解析器…')
  const [pdfjs,worker]=await Promise.all([import('pdfjs-dist'),import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc=worker.default
  const bytes=new Uint8Array(await file.arrayBuffer())
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('该文件不是有效的 PDF')
  const assetBase=import.meta.env.BASE_URL+'pdfjs/'
  const task=pdfjs.getDocument({data:bytes,cMapUrl:assetBase+'cmaps/',cMapPacked:true,standardFontDataUrl:assetBase+'standard_fonts/',enableXfa:false,useWorkerFetch:false,useWasm:false,stopAtErrors:true,verbosity:0})
  let ocr:Awaited<ReturnType<typeof createLocalOCR>>|undefined,ocrPages=0,currentOCRPage=0
  const cancel=()=>{void task.destroy()};signal.addEventListener('abort',cancel,{once:true})
  try{
    signal.throwIfAborted();const doc=await task.promise
    if(doc.numPages>80)throw Error('单个 PDF 最多 80 页，请拆分后导入')
    const start=settings.start,end=Math.min(doc.numPages,settings.end)
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||start>end)throw Error('页码范围无效或起始页超出文件页数')
    const items:ExtractedPage[]=[],empty:number[]=[]
    for(let pageNumber=start;pageNumber<=end;pageNumber++){
      signal.throwIfAborted();onProgress(`正在提取第 ${pageNumber} / ${end} 页…`)
      const page=await doc.getPage(pageNumber),content=await page.getTextContent()
      let body=cleanText(content.items.map(i=>'str'in i?i.str+(i.hasEOL?'\n':' '):'').join('')),confidence:number|undefined,kind:'pdf'|'ocr'='pdf'
      if(settings.mode==='always'||(settings.mode==='auto'&&body.replace(/\s/g,'').length<30)){
        if(++ocrPages>20)throw Error('单次最多 OCR 20 页，请选择更小的页码范围')
        currentOCRPage=pageNumber
        const progress=(message:string)=>onProgress(`第 ${currentOCRPage} / ${end} 页 · ${message}`)
        if(!ocr)ocr=await createLocalOCR(settings.language,signal,progress)
        const view=page.getViewport({scale:1}),scale=Math.min(2.5,3200/Math.max(view.width,view.height))
        const viewport=page.getViewport({scale}),canvas=document.createElement('canvas')
        canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height)
        try{progress('正在渲染扫描页面…');await page.render({canvas,viewport}).promise;const result=await ocr.recognize(canvas);body=result.text;confidence=result.confidence;kind='ocr'}finally{canvas.width=canvas.height=0}
      }
      page.cleanup();signal.throwIfAborted()
      if(!body){empty.push(pageNumber);continue}
      for(let i=0;i<body.length;i+=12000)items.push({title:file.name.replace(/\.pdf$/i,'').slice(0,140)+` · 第 ${pageNumber} 页`+(body.length>12000?' · '+(i/12000+1):''),body:body.slice(i,i+12000),category,sourceMeta:{kind,filename:file.name,page:pageNumber,...(confidence===undefined?{}:{confidence})}})
      checkExtracted(items)
    }
    if(!items.length)throw Error(settings.mode==='never'?'没有文字层，请选择自动 OCR 或全部页面 OCR':'没有识别到文字，请检查文件清晰度、方向和语言')
    const message=`已提取 ${items.length} 条知识，其中 ${ocrPages} 页使用本地 OCR。${empty.length?'第 '+empty.join('、')+' 页没有文字，已跳过。':''}请审核识别结果、文字顺序、数字与表格。`
    return {items,content:JSON.stringify(items),message}
  }
  catch(e){if(signal.aborted)throw Error(settings.signal.aborted?'识别已取消':'识别超过十分钟，请缩小页码范围');if((e as Error).name==='PasswordException')throw Error('PDF 有密码保护，请先在本地解密后导入');throw e}
  finally{signal.removeEventListener('abort',cancel);await ocr?.close();await task.destroy().catch(()=>{})}
}
