'use strict';
// Untrusted PDFs are parsed off the HTTP thread with a memory/time budget.
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(workerData),isEvalSupported:false,enableXfa:false,useWorkerFetch:false,useWasm:false,disableFontFace:true,stopAtErrors:true,verbosity:0});
  try{
    const pdf=await task.promise;
    if(pdf.numPages>80)throw Error('公开 PDF 最多 80 页，请下载后按章节拆分');
    const pages=[];let count=0;
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i),content=await page.getTextContent();
      const body=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('').replace(/[ \t]+/g,' ').trim();
      count+=body.length;if(count>120000)throw Error('PDF 正文超过 120000 字符，请按章节拆分');
      if(body)pages.push({page:i,body});page.cleanup();
    }
    if(count<30)throw Error('PDF 没有足够文字层；请下载后通过 PDF / 图片 OCR 入口识别');
    parentPort.postMessage({pages,totalPages:pdf.numPages});
  }finally{await task.destroy();}
})().catch(e=>parentPort.postMessage({error:e.name==='PasswordException'?'PDF 需要密码，请在本地解锁后导入':String(e.message).slice(0,300)}));
