'use strict';
// This is the product's isolated public-document renderer, never a connection to
// the user's browser. All network bytes are supplied by the validated fetcher.
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {fork}=require('node:child_process');
const http=require('node:http');
const {once}=require('node:events');
let active=0;
function browserRuntime(){
  const packageRoot=path.dirname(require.resolve('playwright-core'));
  const spec=JSON.parse(fs.readFileSync(path.join(packageRoot,'browsers.json'),'utf8')).browsers.find(b=>b.name==='chromium-headless-shell');
  const platform=process.platform==='darwin'?'mac-'+(process.arch==='arm64'?'arm64':'x64'):process.platform==='win32'?'win64':'linux64';
  const name='chrome-headless-shell-'+platform,exe=process.platform==='win32'?'chrome-headless-shell.exe':'chrome-headless-shell';
  const cache=process.platform==='darwin'?path.join(os.homedir(),'Library/Caches/ms-playwright'):process.platform==='win32'?path.join(process.env.LOCALAPPDATA||os.homedir(),'ms-playwright'):path.join(os.homedir(),'.cache/ms-playwright');
  const candidates=[path.resolve(__dirname,'../browser-runtime'),path.join(cache,'chromium_headless_shell-'+spec.revision)];
  for(const root of candidates){const executable=path.join(root,name,exe);if(fs.existsSync(executable))return {root,executable,version:spec.browserVersion};}
  throw Error('缺少独立网页渲染组件，请安装包含浏览器组件的完整客户端；普通网页采集仍可使用');
}
async function renderPublic(url,{response,signal,fetcher,policy,validateURL}={}){
  signal?.throwIfAborted();if(active>=2)throw Error('动态网页渲染正忙，请稍后再试');
  const runtime=browserRuntime();active++;
  // Fail-closed transport: even a browser request missed by interception goes
  // to this rejecting proxy. Chromium never receives a working network proxy.
  const deny=http.createServer((_q,r)=>{r.writeHead(403);r.end();});
  deny.on('connect',(_q,socket)=>{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});
  try{deny.listen(0,'127.0.0.1');await once(deny,'listening');signal?.throwIfAborted();}catch(e){active--;deny.close();throw e;}
  return new Promise((resolve,reject)=>{
    let finished=false,requests=0,totalBytes=0,blocked=0,inFlight=0;const origins=new Set([new URL(url).origin]),waiters=[],lastRequest=new Map();
    const controller=new AbortController(),requestSignal=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    let child;
    try{child=fork(path.join(__dirname,'knowledge-render-worker.js'),[],{execPath:process.execPath,execArgv:['--max-old-space-size=192'],serialization:'advanced',detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'en_US.UTF-8',...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})}});}
    catch(e){active--;deny.close();reject(Error('独立网页渲染组件启动失败'));return;}
    const terminate=()=>{if(!child.pid)return;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
    const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();while(waiters.length)waiters.shift()();deny.close();if(child.connected)child.send({type:'stop'});const killer=setTimeout(terminate,1500);killer.unref();child.once('exit',()=>clearTimeout(killer));active--;error?reject(error):resolve({...value,requests,totalBytes,blocked,rendererVersion:runtime.version});};
    const abort=()=>done(Error('动态网页采集已取消'));
    const timer=setTimeout(()=>done(Error('动态网页渲染超过 60 秒，已停止；没有自动入库')),60000);
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>done(Error('独立网页渲染组件启动失败')));
    child.once('exit',()=>{if(!finished)done(Error('独立网页渲染已停止，请检查内存或重新采集'));});
    child.on('message',async message=>{
      if(finished)return;
      if(message?.type==='result'){if(typeof message.html!=='string'||Buffer.byteLength(message.html)>2*1024**2)return done(Error('动态网页正文结构超过 2 MiB'));return done(null,{html:message.html,url:message.url,waitMs:message.waitMs,omittedResources:message.omittedResources||0});}
      if(message?.type==='error')return done(Error('动态网页未能完成渲染：'+String(message.reason||'组件异常').slice(0,180)));
      if(message?.type!=='fetch')return;
      if(inFlight>=3)await new Promise(r=>waiters.push(r));inFlight++;
      try{
        requestSignal.throwIfAborted();
        if(++requests>100)throw Error('页面超过 100 个资源请求');
        if(message.method!=='GET')throw Error('动态采集禁止提交表单或写入请求');
        const target=validateURL(message.url);
        if(message.navigation&&target.origin!==new URL(url).origin)throw Error('动态页面跨站跳转，已阻止');
        origins.add(target.origin);if(origins.size>8)throw Error('页面依赖超过 8 个公开站点');
        // Includes scripts and JSON dependencies, not only the top document.
        const delay=await policy(target),nextAt=Math.max(Date.now(),lastRequest.get(target.origin)||0);lastRequest.set(target.origin,nextAt+delay*1000);
        if(nextAt>Date.now())await require('node:timers/promises').setTimeout(nextAt-Date.now(),undefined,{signal:requestSignal});
        requestSignal.throwIfAborted();
        const r=target.href.split('#')[0]===url.split('#')[0]&&message.navigation?response:await fetcher(target.href,{signal:requestSignal,maxBytes:6*1024**2});
        if(/\b(noindex|none)\b/i.test(r.headers['x-robots-tag']||''))throw Error('资源声明不允许索引');
        if(r.status>=400)throw Error('动态资源返回 HTTP '+r.status+'，未绕过访问限制');
        if([301,302,303,307,308].includes(r.status)){const next=validateURL(new URL(r.headers.location||'',target).href);if(next.origin!==target.origin)throw Error('资源跨站跳转已阻止');}
        totalBytes+=r.bytes.length;if(totalBytes>24*1024**2)throw Error('页面资源超过 24 MiB');
        const headers={};for(const [key,value] of Object.entries(r.headers))if(!['set-cookie','set-cookie2','connection','transfer-encoding','content-length','content-disposition','alt-svc','report-to','nel'].includes(key)&&typeof value==='string')headers[key]=value;
        if(child.connected&&!finished)child.send({type:'response',id:message.id,status:r.status,headers,bytes:r.bytes});
      }catch(e){blocked++;if(child.connected&&!finished)child.send({type:'response',id:message.id,error:String(e.message).slice(0,180)});}finally{inFlight--;waiters.shift()?.();}
    });
    child.send({type:'start',url,executable:runtime.executable,proxy:'http://127.0.0.1:'+deny.address().port});
  });
}
module.exports={renderPublic,browserRuntime};
