'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{JSDOM}=require('jsdom'),{transformSync}=require('esbuild');
const React=require('react'),{createRoot}=require('react-dom/client'),{Simulate}=require('react-dom/test-utils'),{act}=React;
test('channel wizard preserves generated secrets without rotating on enable, refresh preserves dirty edits, reopening hides secrets',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true}),prior={};
  for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){prior[k]=global[k];global[k]=v;}
  const oldTs=require.extensions['.ts'],oldTsx=require.extensions['.tsx'],oldFetch=global.fetch;
  for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(transformSync(readFileSync(f,'utf8'),{loader:ext.slice(1),format:'cjs',jsx:'automatic'}).code,f);
  let saved;const writes=[];
  global.fetch=async(url,options={})=>{const u=String(url),b=options.body&&JSON.parse(options.body);if(b){writes.push(b);saved={...saved,...b,id:'account',revision:(saved?.revision||0)+1,status:'待启用',verifiedAt:123,callbackVerifiedAt:123};delete saved.secret;delete saved.callbackToken;delete saved.encodingAesKey;return new Response(JSON.stringify(saved));}assert.ok(u.endsWith('/channels'));return new Response(JSON.stringify({list:saved?[saved]:[],catalog:[{id:'wecom_kf',name:'微信客服',implemented:true,requirements:'管理权限',url:'https://work.weixin.qq.com/'}],callbackListener:{enabled:false,port:18879},canManageListener:true}));};
  const Component=require('../../src/PlatformChannelsPanel.tsx').default,root=createRoot(document.getElementById('root'));
  const button=text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text),click=async text=>{assert.ok(button(text),text);await act(async()=>button(text).click())};
  const field=text=>[...document.querySelectorAll('label')].find(x=>x.textContent.startsWith(text))?.querySelector('input');
  const change=async(text,value)=>act(async()=>Simulate.change(field(text),{target:{value}}));
  try{
    await act(async()=>root.render(React.createElement(Component,{agents:[{id:'default',name:'接待员工'}]})));
    await click('添加账号 →');assert.equal(field('回调 Token').value.length,32);assert.equal(field('EncodingAESKey').value.length,43);
    await change('账号备注','接入检查');await change('企业 ID','ww_check');await change('可调用微信客服','fake-test-secret');
    await act(async()=>Simulate.submit(document.querySelector('form')));
    assert.equal(writes.length,1);assert.equal(writes[0].callbackToken.length,32);assert.equal(field('可调用微信客服'),undefined);
    await click('刷新验证状态');await click('继续设置接待 →');
    await act(async()=>Simulate.change(field('接收平台消息'),{target:{checked:true}}));await click('保存接待设置');
    assert.equal(writes[1].enabled,true);assert.equal(writes[1].callbackToken,undefined);assert.equal(writes[1].encodingAesKey,undefined);
    await click('1填写账号');assert.equal(field('可调用微信客服').value,'');await change('账号备注','未保存备注');
    await click('2检查连接');await click('刷新验证状态');assert.match(document.querySelector('[role="alert"]').textContent,/未保存/);
    await click('1填写账号');assert.equal(field('账号备注').value,'未保存备注');await change('账号备注',saved.name);
    await click('← 账号列表');await click('接入检查微信客服 · ww_check待启用');await click('1填写账号');
    assert.equal(field('回调 Token').value,'');assert.equal(field('EncodingAESKey').value,'');assert.equal(field('可调用微信客服').value,'');
  }finally{await act(async()=>root.unmount());global.fetch=oldFetch;require.extensions['.ts']=oldTs;require.extensions['.tsx']=oldTsx;for(const k of Object.keys(prior)){if(prior[k]===undefined)delete global[k];else global[k]=prior[k]}dom.window.close();}
});
