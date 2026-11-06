'use strict';
const {Worker}=require('node:worker_threads');
function extractPDF(bytes,{signal}={}){
  if(bytes.length>16*1024*1024)return Promise.reject(Error('公开 PDF 最多 16 MiB'));
  if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))return Promise.reject(Error('响应不是有效 PDF 文件'));
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=new Worker(require.resolve('./knowledge-pdf-worker.js'),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32}});
    let finished=false;
    const done=(err,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();err?reject(err):resolve(value);};
    const abort=()=>done(Error('PDF 采集已取消'));
    const timer=setTimeout(()=>done(Error('PDF 解析超过 30 秒，已停止；原资料不受影响')),30000);
    signal?.addEventListener('abort',abort,{once:true});
    worker.on('message',value=>done(value.error?Error(value.error):null,value));
    worker.on('error',()=>done(Error('PDF 解析失败或超出资源限制')));
    worker.on('exit',()=>{if(!finished)done(Error('PDF 解析意外中断'));});
  });
}
module.exports={extractPDF};
