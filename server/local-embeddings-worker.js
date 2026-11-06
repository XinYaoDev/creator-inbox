'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {existsSync}=require('node:fs');
const path=require('node:path');
let tokenizer,model;
parentPort.on('message',async({id,input,query,download})=>{
  try{
    const {AutoTokenizer,AutoModel,env}=await import('@huggingface/transformers');
    // Only fixed, pinned public model assets are downloaded. No customer text leaves this worker.
    env.cacheDir=workerData.cache;env.localModelPath=workerData.cache;env.allowLocalModels=true;env.allowRemoteModels=download;
    if(!model||!tokenizer){
      parentPort.postMessage({id,progress:{phase:'loading',progress:0,message:download?'正在下载 / 载入本地中文向量模型…':'正在从缓存载入中文向量模型…'}});
      const options={revision:workerData.revision,dtype:'q8',device:'cpu',local_files_only:!download,
        session_options:{intraOpNumThreads:Math.min(4,Math.max(1,Math.floor(require('node:os').availableParallelism()/2))),interOpNumThreads:1},
        progress_callback:p=>{if(p.status==='progress')parentPort.postMessage({id,progress:{phase:'loading',progress:Math.round(p.progress||0),message:'载入模型文件：'+String(p.file||'').slice(0,80)}});}};
      // Explicit components avoid the pipeline's unpinned remote file discovery on cold/offline starts.
      const directory=path.join(workerData.cache,workerData.model,workerData.revision);
      const cached=['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx'].every(file=>existsSync(path.join(directory,file)));
      // Load pinned cached files directly: remote-id cache discovery in v4 can omit tokenizer files offline.
      const source=cached?directory:workerData.model;
      tokenizer=await AutoTokenizer.from_pretrained(source,options);
      model=await AutoModel.from_pretrained(source,options);
    }
    const vectors=[];
    // Small batches bound CPU memory. Each local chunk is below the model's 512-token limit.
    for(let i=0;i<input.length;i+=8){
      const batch=input.slice(i,i+8).map(s=>query?'为这个句子生成表示以用于检索相关文章：'+s:s);
      const inputs=await tokenizer(batch,{padding:true,truncation:true,max_length:512});
      const output=await model(inputs),hidden=output.last_hidden_state;
      if(hidden.dims.length!==3||hidden.dims[0]!==batch.length||hidden.dims[2]!==512)throw Error('Invalid local output');
      // BGE uses the CLS token, followed by L2 normalization (not mean pooling).
      for(let row=0;row<batch.length;row++){
        const start=row*hidden.dims[1]*512,vector=Array.from(hidden.data.slice(start,start+512),Number),norm=Math.hypot(...vector);
        if(!Number.isFinite(norm)||!norm)throw Error('Invalid local vector');
        vectors.push(vector.map(n=>n/norm));
      }
      parentPort.postMessage({id,progress:{phase:'encoding',progress:Math.round(vectors.length/input.length*100),message:`本地编码 ${vectors.length}/${input.length} 个片段`}});
    }
    parentPort.postMessage({id,vectors});
  }catch{parentPort.postMessage({id,error:true});}
});
