'use strict';
const {Worker}=require('node:worker_threads');
const path=require('node:path');
const MODEL='Xenova/bge-small-zh-v1.5';
const REVISION='75c43b069aac4d136ba6bc1122f995fedcfd2781';
const ID=MODEL+'@'+REVISION+':q8:cls:v1';
let worker,serial=Promise.resolve(),queued=0,sequence=0;
let state={phase:'idle',progress:0,message:'首次建立索引时下载中文向量模型；之后可离线检索'};
function status(){return {...state,model:MODEL,dimensions:512};}
function embed(input,{query=false,download=false}={}){
  if(!Array.isArray(input)||!input.length||input.length>32||input.some(s=>typeof s!=='string'||!s.trim()||s.length>2400))return Promise.reject(new Error('本地向量输入无效'));
  if(queued>=8)return Promise.reject(new Error('本地向量服务繁忙，请稍后重试'));
  queued++;
  const job=serial.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
    if(!worker){worker=new Worker(path.join(__dirname,'local-embeddings-worker.js'),{workerData:{model:MODEL,revision:REVISION,cache:path.resolve(process.env.GROWTH_EMBEDDING_CACHE||path.join(__dirname,'../data/model-cache'))}});worker.unref();}
    const current=worker,id=++sequence;
    const cleanup=()=>{clearTimeout(timer);current.off('message',onMessage);current.off('error',onError);current.off('exit',onExit);current.unref();};
    const onError=()=>{cleanup();if(worker===current)worker=null;void current.terminate();state={phase:'error',progress:0,message:'本地向量模型未就绪，请检查网络、磁盘或重新建立索引'};reject(new Error(state.message));};
    const onExit=code=>{if(code!==0)onError();};
    const onMessage=m=>{if(m.id!==id)return;if(m.progress){state=m.progress;return;}if(m.error){onError();return;}cleanup();state={phase:'ready',progress:100,message:'中文向量模型已就绪，文本仅在本机计算'};resolve(m.vectors);};
    const timer=setTimeout(onError,download?180000:60000);
    current.on('message',onMessage);current.once('error',onError);current.once('exit',onExit);current.ref();
    current.postMessage({id,input,query,download});
  })).finally(()=>queued--);
  serial=job;return job;
}
module.exports={embed,status,MODEL,REVISION,ID};
