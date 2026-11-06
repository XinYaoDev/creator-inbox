'use strict';
const http=require('node:http');
const {fail}=require('./channel-crypto.js');
function createChannelListener({db,callback,initialPort=0}){
  db.exec('CREATE TABLE IF NOT EXISTS channel_runtime(id INTEGER PRIMARY KEY CHECK(id=1),port INTEGER NOT NULL,enabled INTEGER NOT NULL)');
  if(!db.prepare('SELECT 1 FROM channel_runtime WHERE id=1').get())db.prepare('INSERT INTO channel_runtime VALUES(1,?,?)').run(initialPort||18879,initialPort?1:0);
  let server,actualPort=0,error='',changing=false;
  const settings=()=>db.prepare('SELECT port,enabled FROM channel_runtime WHERE id=1').get();
  function status(){const c=settings();return {enabled:!!c.enabled,listening:!!server?.listening,host:'127.0.0.1',port:c.port,actualPort,error};}
  function open(port){return new Promise((resolve,reject)=>{
    const next=http.createServer((req,res)=>{
      try{const u=new URL(req.url,'http://localhost');if(!/^\/api\/channel-callback\/[a-f0-9-]{36}$/.test(u.pathname)){res.writeHead(404);return res.end('not found');}void callback(req,res,u);}catch{res.writeHead(400);res.end('invalid callback');}
    });
    next.requestTimeout=15000;next.headersTimeout=10000;next.maxConnections=64;
    next.once('error',reject);next.listen(port,'127.0.0.1',()=>{next.removeListener('error',reject);next.on('error',()=>{error='回调入口连接异常，请重新开启';});resolve(next);});
  });}
  async function configure({enabled,port}){
    if(changing)fail('回调入口正在切换，请稍后再试',409);
    if(typeof enabled!=='boolean')fail('请明确开启或关闭回调入口');
    const target=Number(port??settings().port);if(!Number.isInteger(target)||target<1024||target>65535)fail('回调端口需在 1024–65535 之间');
    changing=true;
    try{
      if(enabled){if(!server?.listening||actualPort!==target){const next=await open(target),previous=server;server=next;actualPort=target;previous?.close();previous?.closeAllConnections();}}
      else{server?.close();server?.closeAllConnections();server=null;actualPort=0;}
      db.prepare('UPDATE channel_runtime SET port=?,enabled=? WHERE id=1').run(target,enabled?1:0);error='';return status();
    }catch(e){error=e.code==='EADDRINUSE'?'回调端口已被其他程序使用，请选择其他端口':'无法开启回调入口，请检查本机网络权限';throw Object.assign(new Error(error),{status:409});}finally{changing=false;}
  }
  return {status,configure,start:async()=>{const c=settings();if(c.enabled)try{await configure({enabled:true,port:c.port});}catch{/* Diagnostics remain visible; the desktop itself must stay available. */}},close:()=>{server?.close();server?.closeAllConnections();server=null;}};
}
module.exports={createChannelListener};
