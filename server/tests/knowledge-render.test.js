'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderPublic,browserRuntime}=require('../knowledge-render');
const {publicURL,extractPage,inspectHTML,renderingMode}=require('../knowledge-web');
const response=(s,type='text/html')=>({status:200,headers:{'content-type':type},bytes:Buffer.from(s)});
let available=true;try{browserRuntime();}catch{available=false;}
const options={skip:available?false:'Install the pinned public renderer to run actual Chromium safety tests',timeout:40000};
test('dynamic mode validation, hash routes and pre-render indexing/verification guards',()=>{
  assert.equal(publicURL('https://example.org/#/guide').hash,'#/guide');
  assert.equal(publicURL('https://example.org/#heading').hash,'');
  assert.equal(inspectHTML('<div id="app">Loading</div><script src="/app.js"></script>','https://example.org'),true);
  assert.throws(()=>inspectHTML('<meta name="robots" content="noindex"><div id="app"></div>','https://example.org'),/不允许索引/);
  assert.throws(()=>inspectHTML('<title>Just a moment</title>','https://example.org'),/安全拦截/);
  assert.equal(renderingMode(undefined),'auto');assert.throws(()=>renderingMode('unrestricted'),/模式无效/);
});
test('real sandbox executes JS and fetches public JSON through a credential-free broker',options,async()=>{
  const visited=[],checked=[];
  const html='<title>动态服务</title><main id="app"></main><script src="/app.js"></script>';
  const fetcher=async url=>{visited.push(url);if(url.endsWith('/app.js'))return response("fetch('/data.json').then(r=>r.json()).then(d=>document.querySelector('main').textContent=d.body)",'application/javascript');if(url.endsWith('/data.json'))return response(JSON.stringify({body:'这是由 JavaScript 和公开 JSON 生成的业务正文，提供开放时间与预约说明。'.repeat(12)}),'application/json');throw Error('Unexpected request');};
  const rendered=await renderPublic('https://example.org/',{response:response(html),fetcher,policy:async u=>{checked.push(u.href);return 0;},validateURL:publicURL});
  assert.match(extractPage(rendered.html,rendered.url).body,/JavaScript 和公开 JSON/);
  assert.deepEqual(visited,['https://example.org/app.js','https://example.org/data.json']);
  assert.equal(checked.length,3);assert.equal(rendered.blocked,0);assert.ok(rendered.waitMs>=5000);
});
test('real sandbox rejects private fetch, POST, frames and popups without forwarding credentials',options,async()=>{
  const forwarded=[];
  const html=`<main>${'公开正文内容，仅用于安全测试。'.repeat(30)}</main><script>
    fetch('http://127.0.0.1/private').catch(()=>{});
    fetch('/write',{method:'POST',body:'blocked'}).catch(()=>{});
    const f=document.createElement('iframe');f.src='http://169.254.169.254/metadata';document.body.appendChild(f);
    window.open('http://127.0.0.1/popup');
  </script>`;
  await assert.rejects(()=>renderPublic('https://example.org/',{response:response(html),fetcher:async u=>{forwarded.push(u);return response('must not happen');},policy:async()=>0,validateURL:publicURL}),/内网|本机|脚本|数据未完整/);
  assert.deepEqual(forwarded,[]);
});
test('cancellation terminates a real busy JavaScript renderer instead of hanging the server',options,async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),800);
  try{await assert.rejects(()=>renderPublic('https://example.org/',{response:response('<main>busy</main><script>while(true){}</script>'),fetcher:async()=>response(''),policy:async()=>0,validateURL:publicURL,signal:controller.signal}),/取消/);}finally{clearTimeout(timer);}
});
test('optional search preloading is omitted but unknown essential script failures stay fail-closed',options,async()=>{
  const text='Requested public article remains readable without an optional site search widget. '.repeat(6),visited=[];
  const rendered=await renderPublic('https://example.org/#/guide',{response:response('<main>'+text+'</main><script src="https://cdn.jsdelivr.net/npm/docsify@5/dist/plugins/search.min.js"></script>'),fetcher:async u=>{visited.push(u);throw Error('Should not preload search');},policy:async()=>0,validateURL:publicURL});
  assert.equal(rendered.omittedResources,1);assert.deepEqual(visited,[]);assert.match(rendered.html,/Requested public article/);
  await assert.rejects(()=>renderPublic('https://example.org/',{response:response('<main>'+text+'</main><script src="/required.js"></script>'),fetcher:async()=>({status:403,headers:{},bytes:Buffer.from('Forbidden')}),policy:async()=>0,validateURL:publicURL}),/HTTP 403/);
});
