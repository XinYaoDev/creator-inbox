import type {Worker} from 'tesseract.js'
export type ExtractedPage={title:string;body:string;category:string;sourceMeta:{kind:'ocr'|'pdf';filename:string;page:number;confidence?:number}}
export type ExtractOptions={mode:'auto'|'always'|'never';language:string;start:number;end:number;signal:AbortSignal}
export const cleanText=(text:string)=>text.replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu,'').trim()
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{const cancel=()=>reject(Error('识别已取消'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel))})
}
export function checkExtracted(items:ExtractedPage[]){if(items.length>200||new TextEncoder().encode(JSON.stringify(items)).byteLength>700000)throw Error('识别结果超过 700 KB / 200 条，请缩小页码范围')}
export async function createLocalOCR(language:string,signal:AbortSignal,progress:(message:string)=>void){
  const {createWorker,PSM}=await import('tesseract.js')
  const base=new URL(import.meta.env.BASE_URL+'ocr/',location.origin).href
  let worker:Worker|undefined,closed=false
  const stop=()=>{closed=true;void worker?.terminate()}
  signal.addEventListener('abort',stop,{once:true})
  try{
    signal.throwIfAborted()
    worker=await abortable(createWorker(language,1,{workerPath:base+'worker.min.js',corePath:base+'core',langPath:base+'lang',workerBlobURL:false,errorHandler:()=>{},logger:m=>{if(!closed)progress(m.status==='recognizing text'?`正在识别文字 ${Math.round(m.progress*100)}%`:'正在加载本地识别资源…')}}).then(w=>{if(closed)void w.terminate();return w}),signal)
    signal.throwIfAborted()
    await worker!.setParameters({tessedit_pageseg_mode:PSM.AUTO,user_defined_dpi:'200'})
    return {
      async recognize(canvas:HTMLCanvasElement){signal.throwIfAborted();const {data}=await abortable(worker!.recognize(canvas),signal);signal.throwIfAborted();return {text:cleanText(data.text),confidence:data.confidence}},
      async close(){closed=true;signal.removeEventListener('abort',stop);await worker?.terminate()},
    }
  }catch(e){closed=true;signal.removeEventListener('abort',stop);await worker?.terminate();throw e}
}
export async function readImageKnowledge(file:File,category:string,options:ExtractOptions,progress:(message:string)=>void){
  if(file.size>10*1024*1024)throw Error('图片不能超过 10 MB')
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('请选择 PNG、JPEG 或 WebP 图片')
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(10*60*1000)])
  const bitmap=await createImageBitmap(file)
  let ocr:Awaited<ReturnType<typeof createLocalOCR>>|undefined
  const canvas=document.createElement('canvas')
  try{
    signal.throwIfAborted()
    if(bitmap.width*bitmap.height>40000000)throw Error('图片超过 4000 万像素，请缩小后导入')
    const scale=Math.min(2,3200/Math.max(bitmap.width,bitmap.height))
    canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale)
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height)
    ocr=await createLocalOCR(options.language,signal,progress)
    const result=await ocr.recognize(canvas)
    if(!result.text)throw Error('未识别到文字，请检查清晰度、方向和识别语言')
    const items:ExtractedPage[]=[]
    for(let i=0;i<result.text.length;i+=12000)items.push({title:file.name.slice(0,150)+(result.text.length>12000?' · '+(i/12000+1):''),body:result.text.slice(i,i+12000),category,sourceMeta:{kind:'ocr',filename:file.name,page:1,confidence:result.confidence}})
    checkExtracted(items);return {items,message:`图片已识别，置信度 ${Math.round(result.confidence)}%。置信度不等于准确率，请核对数字、名称和表格。`}
  }catch(e){if(signal.aborted)throw Error(options.signal.aborted?'识别已取消':'识别超过十分钟，请缩小图片后重试');throw e}
  finally{bitmap.close();canvas.width=canvas.height=0;await ocr?.close()}
}
