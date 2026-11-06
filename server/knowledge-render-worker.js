'use strict';
const {chromium}=require('playwright-core');
let browser,closing=false,next=0;const pending=new Map();
const stop=async()=>{if(closing)return;closing=true;for(const {reject} of pending.values())reject(Error('cancelled'));pending.clear();const timer=setTimeout(()=>process.exit(0),900);timer.unref();try{await browser?.close();}finally{process.exit(0);}};
process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
const send=message=>{if(process.connected)process.send(message);};
process.on('message',async message=>{
  if(message?.type==='stop')return stop();
  if(message?.type==='response'){const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(Error(message.error)):task.resolve(message);}return;}
  if(message?.type!=='start'||browser)return;
  try{
    browser=await chromium.launch({executablePath:message.executable,headless:true,chromiumSandbox:true,timeout:10000,proxy:{server:message.proxy,bypass:'<-loopback>'},args:['--disable-quic','--disable-background-networking','--disable-component-update','--disable-domain-reliability','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND','--js-flags=--max-old-space-size=256']});
    const context=await browser.newContext({viewport:{width:1280,height:900},userAgent:'LaikeKnowledgeBot/1.0',serviceWorkers:'block',acceptDownloads:false,permissions:[],ignoreHTTPSErrors:false});
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page=await context.newPage();let inFlight=0,mainError='',resourceError='',omittedResources=0;
    page.on('dialog',d=>void d.dismiss().catch(()=>{}));page.on('popup',p=>void p.close().catch(()=>{}));
    await context.route('**/*',async route=>{
      const request=route.request(),type=request.resourceType();
      // Document capture does not need advertising/analytics. Do not fetch or
      // bypass their access controls, and do not mistake an optional ad failure
      // for a failure of the site's actual body/API. Unknown dependencies remain
      // fail-closed. This list is not an authentication/paywall bypass.
      const target=new URL(request.url()),host=target.hostname;
      // Docsify's optional search plugin preloads every linked article (even
      // other sites). It is not needed to render the requested article, and
      // running it would turn a one-page capture into an unrequested crawl.
      const optionalSearch=host==='cdn.jsdelivr.net'&&/^\/npm\/docsify@[^/]+\/dist\/plugins\/search(?:\.min)?\.js$/.test(target.pathname);
      if(optionalSearch||['googletagmanager.com','google-analytics.com','carbonads.com','doubleclick.net','googlesyndication.com'].some(d=>host===d||host.endsWith('.'+d))){omittedResources++;return route.abort().catch(()=>{});}
      let mainFrame=false;try{mainFrame=request.frame()===page.mainFrame();}catch{return route.abort().catch(()=>{});}
      if(!['document','script','stylesheet','xhr','fetch'].includes(type)||request.method()!=='GET'||(type==='document'&&!mainFrame))return route.abort().catch(()=>{});
      const id=++next;inFlight++;
      try{
        const response=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({type:'fetch',id,url:request.url(),method:request.method(),navigation:type==='document'});});
        await route.fulfill({status:response.status,headers:response.headers,body:response.bytes});
      }catch(e){if(type==='document')mainError=e.message;else if(['script','xhr','fetch'].includes(type))resourceError=e.message;await route.abort().catch(()=>{});}finally{inFlight--;}
    });
    const start=Date.now();
    await page.goto(message.url,{waitUntil:'domcontentloaded',timeout:18000});
    let previous='',stableAt=Date.now(),html='';
    // A public SPA may fetch its search index after its main article. Allow a
    // bounded settling window for these dependencies instead of declaring a
    // partially loaded page successful merely because its text stopped moving.
    while(Date.now()-start<50000){
      const snapshot=await page.evaluate(()=>{
        if(document.querySelectorAll('*').length>30000)throw Error('正文结构超过 30000 个元素');
        const root=document.documentElement.cloneNode(true);
        root.querySelectorAll('script,style,iframe,object,embed,canvas,svg,noscript,form,nav,header,footer,aside,[hidden],[aria-hidden="true"]').forEach(n=>n.remove());
        const html=root.outerHTML;if(html.length>2000000)throw Error('正文结构过大');
        return {html,text:root.querySelector('body')?.textContent||''};
      });
      if(snapshot.text!==previous){previous=snapshot.text;stableAt=Date.now();}
      html=snapshot.html;
      if(Date.now()-start>=5000&&Date.now()-stableAt>=1500&&inFlight===0&&previous.trim().length>=200)break;
      await new Promise(r=>setTimeout(r,250));
    }
    if(mainError)throw Error(mainError);
    if(resourceError)throw Error('必要脚本或数据未完整载入：'+resourceError);
    if(inFlight||Date.now()-stableAt<1500)throw Error('页面仍在持续加载，未将不完整内容标记成功');
    if(previous.trim().length<30)throw Error(resourceError||'没有公开正文；可能需要登录、验证码或用户操作');
    send({type:'result',html,url:page.url(),waitMs:Date.now()-start,omittedResources});
  }catch(error){send({type:'error',reason:/timeout/i.test(error.message)?'页面加载超时':String(error.message).replace(/\n[\s\S]*/, '').slice(0,180)});}
  finally{await stop();}
});
