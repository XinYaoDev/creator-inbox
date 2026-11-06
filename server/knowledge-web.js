'use strict';
// Public, bounded, credential-free collection. Never use the app's browser session.
const http=require('node:http'),https=require('node:https'),dns=require('node:dns').promises;
const {createHash}=require('node:crypto');
const ipaddr=require('ipaddr.js');
const {JSDOM}=require('jsdom');
const {Readability}=require('@mozilla/readability');
const robotsParser=require('robots-parser');
const {extractPDF}=require('./knowledge-pdf.js');
const {renderPublic}=require('./knowledge-render.js');
const UA='LaikeKnowledgeBot/1.0';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
let activeCollectors=0;
function publicAddress(address){
  try{let ip=ipaddr.parse(address);if(ip.kind()==='ipv6'&&ip.isIPv4MappedAddress())ip=ip.toIPv4Address();return ip.range()==='unicast';}catch{return false;}
}
function publicURL(value){
  let u;try{u=new URL(value);}catch{fail('请输入完整的公开网页地址');}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||u.href.length>2000)fail('仅支持无凭据、默认端口的 HTTP / HTTPS 网页');
  if(!host.includes('.')&&!host.includes(':')||/(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host)||host.endsWith('.'))fail('不能采集本机或内网地址');
  if(ipaddr.isValid(host)&&!publicAddress(host))fail('不能采集本机、内网或保留地址');
  // Preserve hash-router paths used by public SPAs, but drop ordinary anchors.
  if(!/^#!?\//.test(u.hash))u.hash='';return u;
}
async function resolvePublic(u,lookup=dns.lookup){
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const records=ipaddr.isValid(host)?[{address:host,family:ipaddr.parse(host).kind()==='ipv6'?6:4}]:await lookup(host,{all:true,verbatim:true});
  if(!records.length||records.some(r=>!publicAddress(r.address)))fail('网页域名解析到了内网或保留地址，已阻止采集');
  return records;
}
async function networkLookup(host,options){
  const records=await dns.lookup(host,options);
  // Some local network proxies return RFC 2544 fake IPs for every public domain.
  // Never connect to those reserved addresses: resolve through fixed HTTPS DNS,
  // then still validate and pin the real public IP. No fallback for RFC1918, etc.
  if(!records.length||!records.every(r=>/^198\.(18|19)\./.test(r.address)))return records;
  const data=await new Promise((resolve,reject)=>{
    const req=https.get('https://1.1.1.1/dns-query?type=A&name='+encodeURIComponent(host),{agent:false,headers:{Accept:'application/dns-json'},signal:AbortSignal.timeout(8000)},res=>{
      const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>64000){res.destroy();reject(Error('DNS 响应过大'));}else chunks.push(b)});res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw Error();resolve(JSON.parse(Buffer.concat(chunks).toString()))}catch{reject(Error('安全 DNS 查询失败'))}});
    });req.on('error',reject);
  });
  if(data.Status!==0)fail('公开域名解析失败');
  return (data.Answer||[]).filter(r=>r.type===1).map(r=>({address:r.data,family:4}));
}
async function fetchPublic(value,{signal,maxBytes=2*1024*1024,lookup=networkLookup}={}){
  const u=publicURL(value),records=await resolvePublic(u,lookup);
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    // Pin validated DNS addresses for this connection, including dual-stack lookup.
    const req=(u.protocol==='https:'?https:http).request(u,{method:'GET',agent:false,signal,
      lookup:(_host,options,cb)=>options.all?cb(null,records):cb(null,records[0].address,records[0].family),
      headers:{'User-Agent':UA,Accept:'text/html, application/pdf, application/json, text/plain;q=0.9','Accept-Encoding':'identity'}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){clearTimeout(timer);res.destroy();req.destroy();reject(Error('网页超过采集大小限制'));}else chunks.push(chunk);});
      res.on('error',()=>reject(Error('网页连接中断')));
      res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),url:u.href});});
    });
    const timer=setTimeout(()=>req.destroy(Error('网页请求超时')),12000);timer.unref();
    req.on('error',error=>{clearTimeout(timer);reject(error.name==='AbortError'?error:Error('网页连接失败，请确认公开访问和网络连接'));});
    req.end();
  });
}
function decode(response){
  const encoding=/charset\s*=\s*["']?([\w-]+)/i.exec(response.headers['content-type']||'')?.[1]||/charset\s*=\s*["']?([\w-]+)/i.exec(response.bytes.subarray(0,4096).toString('ascii'))?.[1]||'utf-8';
  try{return new TextDecoder(encoding).decode(response.bytes);}catch{fail('网页字符编码不受支持');}
}
function extractPage(html,url,contentType='text/html'){
  if(contentType.includes('application/json')){
    let value;try{value=JSON.parse(html);}catch{fail('公开 JSON 内容无法解析');}
    const body=JSON.stringify(value,null,2);if(body.length<10||body.length>120000)fail('公开 JSON 正文过短或超过 120000 字符');
    return {title:'公开 JSON · '+(new URL(url).pathname.split('/').pop()||new URL(url).hostname),body,links:[]};
  }
  if(contentType.includes('text/plain'))return {title:new URL(url).pathname.split('/').pop()||new URL(url).hostname,body:html.trim(),links:[]};
  if(!contentType.includes('text/html')&&!contentType.includes('application/xhtml+xml'))fail('只支持 HTML / 纯文本网页；PDF 请通过文件导入');
  const dom=new JSDOM(html,{url}); // No scripts, external resources or network execution.
  try{
    const doc=dom.window.document;
    if([...doc.querySelectorAll('meta[name="robots"],meta[name="LaikeKnowledgeBot"]')].some(m=>/\b(noindex|none)\b/i.test(m.content)))fail('网页声明不允许索引，已跳过');
    const links=[...doc.querySelectorAll('a[href]')].map(a=>{try{const u=new URL(a.getAttribute('href'),url);if(!/^#!?\//.test(u.hash))u.hash='';return u.href;}catch{return '';}}).filter(Boolean);
    doc.querySelectorAll('script,style,nav,header,footer,aside,form,iframe,noscript,svg,canvas,[hidden],[aria-hidden="true"]').forEach(e=>e.remove());
    const article=new Readability(doc.cloneNode(true),{charThreshold:80,maxElemsToParse:30000}).parse();
    const fragment=article?.content?JSDOM.fragment(article.content):null;
    const root=fragment||doc.querySelector('main,article')||doc.body;
    root.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));
    root.querySelectorAll('p,div,li,h1,h2,h3,h4,tr,section,pre').forEach(e=>e.append('\n'));
    const body=(root.textContent||'').replace(/[\t\u00a0 ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    if(body.length<30)fail('没有提取到足够正文；可能需要登录、动态加载或人工复制');
    if(body.length>120000)fail('网页正文过长，请选择更具体的页面');
    return {title:(article?.title||doc.title||new URL(url).hostname).trim().slice(0,170),body,links:[...new Set(links)]};
  }finally{dom.window.close();}
}
function renderingMode(value){const mode=value??'auto';if(!['auto','static','javascript'].includes(mode))fail('网页渲染模式无效');return mode;}
function inspectHTML(html,url){
  const dom=new JSDOM(html,{url});try{
    const doc=dom.window.document;
    if([...doc.querySelectorAll('meta[name="robots"],meta[name="LaikeKnowledgeBot"]')].some(m=>/\b(noindex|none)\b/i.test(m.content)))fail('网页声明不允许索引，已跳过');
    if(/just a moment|access denied|verify.*human|security verification|人机验证|安全验证/i.test(doc.title))fail('页面是访问验证或安全拦截，不自动处理验证码或绕过限制');
    const root=doc.querySelector('#app,#root,app-root,#__next');
    return !!doc.querySelector('script')&&((root&&root.textContent.trim().length<80)||/enable javascript|开启.*javascript|启用.*javascript/i.test(doc.querySelector('noscript')?.textContent||''));
  }finally{dom.window.close();}
}
function createWebKnowledge({all,get,put,knowledge,event,clock,fetcher=fetchPublic,renderer=renderPublic}){
  const controllers=new Map(),recent=[];
  for(const job of all('knowledgeCollect').filter(j=>['queued','running'].includes(j.status)))put('knowledgeCollect',{...job,status:'interrupted',error:'服务重启中断采集，请重新采集；未写入知识库'},job.id);
  const jobs=()=>all('knowledgeCollect').slice(0,20).map(({items,...job})=>({...job,itemCount:items?.length||0}));
  const detail=id=>get('knowledgeCollect',id)||fail('采集记录不存在',404);
  async function run(id){
    const initial=detail(id),controller=controllers.get(id),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(initial.renderMode==='static'?90000:180000)]);
    const pages=[],items=[],robots=new Map(),robotsChecks=[],seen=new Set(),queue=[{url:initial.url,depth:0}];
    let totalBytes=0;
    const record=patch=>put('knowledgeCollect',{...detail(id),pages,items,robotsChecks,...patch},id);
    const policy=async u=>{
      if(!robots.has(u.origin)){
        robots.set(u.origin,(async()=>{
        let target=u.origin+'/robots.txt',r;
        for(let i=0;i<4;i++){
          r=await fetcher(target,{signal,maxBytes:256000});
          if([301,302,303,307,308].includes(r.status)){const next=publicURL(new URL(r.headers.location||'',target).href);if(next.origin!==u.origin)fail('robots.txt 跨站跳转，无法确认采集许可');target=next.href;continue;}break;
        }
        robotsChecks.push({origin:u.origin,status:r.status});
        // RFC 9309 2.3.1.3 treats 4xx robots as unavailable. Remain stricter for
        // explicit authentication/refusal/rate limits; CDN /robots.txt often
        // returns 400 when it is not a package resource. Never ignore 401/403/429.
        if([400,404,410].includes(r.status))return robotsParser(target,'');
        else if(r.status===200)return robotsParser(target,decode(r));
        else fail('无法确认 robots.txt 采集许可（HTTP '+r.status+'）');
        })());
      }
      const rules=await robots.get(u.origin);
      if(rules.isAllowed(u.href,UA)===false)fail('网站 robots.txt 不允许采集此页');
      const delay=Number(rules.getCrawlDelay(UA)||0);
      if(delay>10)fail('网站要求较长采集间隔，请手动导入资料');
      return Math.max(0,delay);
    };
    try{
      record({status:'running'});
      while(queue.length&&pages.length<initial.maxPages){
        signal.throwIfAborted();let {url,depth}=queue.shift();if(seen.has(url))continue;seen.add(url);
        try{
          let response,finalURL;
          for(let redirect=0;redirect<=4;redirect++){
            finalURL=publicURL(url);const delay=await policy(finalURL);
            if(pages.length&&delay)await require('node:timers/promises').setTimeout(delay*1000,undefined,{signal});
            response=await fetcher(finalURL.href,{signal,maxBytes:16*1024*1024});
            if(![301,302,303,307,308].includes(response.status))break;
            if(redirect===4||!response.headers.location)fail('网页重定向过多或缺少目标地址');
            const next=publicURL(new URL(response.headers.location,finalURL).href);
            // No cross-origin redirects: protect arbitrary third parties and remain in scope.
            if(next.origin!==finalURL.origin)fail('网页跳转到其他站点，请直接输入目标公开地址');
            url=next.href;
          }
          if(response.status!==200)fail('网页返回 HTTP '+response.status+'；不会绕过登录或访问限制');
          if(/\b(noindex|none)\b/i.test(response.headers['x-robots-tag']||''))fail('网页声明不允许索引，已跳过');
          const pdf=/application\/pdf/i.test(response.headers['content-type']||'')||response.bytes.subarray(0,5).toString()==='%PDF-';
          let extracted,rendered;
          if(pdf){const result=await extractPDF(response.bytes,{signal});extracted={title:decodeURIComponent(finalURL.pathname.split('/').pop()||'公开 PDF').slice(0,170),body:result.pages.map(p=>'[第 '+p.page+' 页]\n'+p.body).join('\n\n'),links:[],pdfPages:result.totalPages};}
          else{
            if(response.bytes.length>2*1024*1024)fail('网页超过 2 MiB 大小限制');
            const html=decode(response),type=response.headers['content-type']||'',isHTML=/text\/html|application\/xhtml\+xml/i.test(type);
            let needsRender=isHTML&&inspectHTML(html,finalURL.href),extractionError;
            try{extracted=extractPage(html,finalURL.href,type);if(isHTML&&extracted.body.length<200&&/<script\b/i.test(html))needsRender=true;}catch(e){extractionError=e;if(isHTML)needsRender=true;}
            if(isHTML&&initial.renderMode!=='static'&&(initial.renderMode==='javascript'||needsRender)){
              record({status:'running',phase:'rendering',currentUrl:finalURL.href});
              rendered=await renderer(finalURL.href,{response,signal,fetcher,policy,validateURL:publicURL});
              if(publicURL(rendered.url).origin!==finalURL.origin)fail('动态网页跨站跳转，已阻止');
              finalURL=publicURL(rendered.url);extracted=extractPage(rendered.html,finalURL.href,'text/html');
            }else if(extractionError)throw extractionError;
          }
          totalBytes+=Buffer.byteLength(extracted.body);if(totalBytes>600000)fail('采集总正文超过 600 KB，请减少页面数');
          const existing=knowledge.findWeb(finalURL.href);
          for(let offset=0;offset<extracted.body.length;offset+=12000){
            const part=offset/12000+1,key=createHash('sha256').update(finalURL.href+'#'+part).digest('hex');
            const old=existing.find(k=>!k.archived&&k.sourceMeta?.kind==='web'&&k.sourceMeta.url===finalURL.href&&k.sourceMeta.part===part);
            items.push({key,title:extracted.title+(extracted.body.length>12000?' · 第 '+part+' 部分':''),body:extracted.body.slice(offset,offset+12000),category:initial.category,url:finalURL.href,part,existingId:old?.id||'',expectedVersion:old?.version||0});
          }
          pages.push({url:finalURL.href,title:extracted.title,status:'success',characters:extracted.body.length,depth,rendered:!!rendered,...(rendered?{renderWaitMs:rendered.waitMs,resourceRequests:rendered.requests,resourceBytes:rendered.totalBytes,blockedResources:rendered.blocked,omittedResources:rendered.omittedResources,rendererVersion:rendered.rendererVersion}:{}),...(pdf?{pdfPages:extracted.pdfPages}:{})});
          if(depth<(initial.maxDepth??1)&&initial.maxPages>1){
            for(const link of extracted.links){try{const next=publicURL(link);if(next.origin===finalURL.origin&&!next.search&&!/\.(zip|png|jpg|jpeg|gif|mp4|docx?|exe|dmg|js|css)$/i.test(next.pathname)&&!seen.has(next.href)&&!queue.some(p=>p.url===next.href)&&queue.length<initial.maxPages-pages.length)queue.push({url:next.href,depth:depth+1});}catch{/* Skip unsafe links. */}}
          }
        }catch(e){if(signal.aborted)throw e;pages.push({url,status:'failed',error:e.message});}
        record({status:'running'});
      }
      record({status:items.length?'completed':'failed',phase:null,currentUrl:null,finishedAt:clock(),error:items.length?'':'未采集到可导入的正文，请查看各页原因'});
      event('','网页知识采集',pages.filter(p=>p.status==='success').length+' 页成功；尚未入库');
    }catch(e){record({status:controller.signal.aborted?'cancelled':'failed',error:controller.signal.aborted?'采集已取消，未自动写入知识库':'采集超时或中断，可重新采集',finishedAt:clock()});}
    finally{controllers.delete(id);activeCollectors--;}
  }
  function start(input,meta={}){
    const url=publicURL(input.url).href;
    if(controllers.size||activeCollectors>=3)fail('已有采集在进行，请稍后再试',429);
    while(recent.length&&recent[0]<clock()-600)recent.shift();if(recent.length>=10)fail('采集过于频繁，请十分钟后再试',429);
    const maxPages=Number(input.maxPages||1);if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)fail('单次采集 1–20 页');
    const maxDepth=Number(input.maxDepth??1);if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>3)fail('链接深度为 0–3 层');
    const renderMode=renderingMode(input.renderMode);
    const job=put('knowledgeCollect',{url,maxPages,maxDepth,renderMode,category:String(input.category||'网页资料').trim().slice(0,100)||'网页资料',status:'queued',pages:[],items:[],...(meta.sourceId?{sourceId:meta.sourceId}:{})});
    controllers.set(job.id,new AbortController());recent.push(clock());activeCollectors++;void run(job.id);return job;
  }
  function cancel(id){const job=detail(id);controllers.get(id)?.abort();return job;}
  function importItems(id,input){
    const job=detail(id);if(job.status!=='completed')fail('只有已完成的采集可以导入');
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>200)fail('请选择需要导入的条目');
    const keys=new Set(),selected=input.items.map(k=>{
      const original=job.items.find(i=>i.key===k.key);if(!original||keys.has(k.key))fail('采集条目无效或重复');keys.add(k.key);
      return {...original,title:k.title,body:k.body,category:k.category};
    });
    return knowledge.commitWebImport(selected,{update:input.update===true,fetchedAt:job.finishedAt});
  }
  return {jobs,detail,start,cancel,importItems};
}
module.exports={createWebKnowledge,publicURL,publicAddress,resolvePublic,fetchPublic,extractPage,renderingMode,inspectHTML};
