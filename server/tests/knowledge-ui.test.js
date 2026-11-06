const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {JSDOM}=require('jsdom');
const {transformSync}=require('esbuild');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {Simulate}=require('react-dom/test-utils');
const {act}=React;

test('knowledge workspace preserves drafts, opens history in a native sheet, and confirms optimistic restore',async()=>{
  const dom=new JSDOM('<div class="g-content"><div id="root"></div></div>',{url:'http://localhost',pretendToBeVisual:true});
  const prior={};
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,requestAnimationFrame:cb=>setTimeout(cb,0),IS_REACT_ACT_ENVIRONMENT:true})){prior[key]=global[key];global[key]=value;}
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');this.querySelector('button')?.focus();};
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  dom.window.HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;};
  const oldTs=require.extensions['.ts'],oldTsx=require.extensions['.tsx'];
  for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,filename)=>module._compile(transformSync(readFileSync(filename,'utf8'),{loader:ext.slice(1),format:'cjs',jsx:'automatic'}).code,filename);
  const Component=require('../../src/KnowledgePanel.tsx').default,root=createRoot(document.getElementById('root'));
  const items=Array.from({length:50},(_,i)=>({id:'k'+i,title:'业务知识 '+i,body:'正文内容 '.repeat(40),category:'产品资料',version:1,enabled:true}));
  const mutations=[];let historyResolve,failRestore=true;
  const request=async(path,body)=>{
    if(path.startsWith('/knowledge/list?'))return {list:items,total:130319,page:1,categories:['产品资料']};
    if(path==='/knowledge/imports')return {list:[]};
    if(path==='/knowledge/k0')return {...items[0],version:3};
    if(path.endsWith('/versions'))return new Promise(r=>{historyResolve=r;});
    if(path.endsWith('/restore')){mutations.push(body);if(failRestore)throw Error('知识已被其他操作修改，请重新读取');return {};}
    throw Error('Unexpected request '+path);
  };
  const action=async fn=>{try{await fn();}catch{/* The parent presents a global error; sheet must also show its own error. */}};
  const byText=(text,scope=document)=>[...scope.querySelectorAll('button')].find(x=>x.textContent===text);
  const click=async button=>{assert.ok(button);await act(async()=>button.click());};
  const revisions={list:[{id:'v3',version:3,created:123,actor:'管理员',snapshot:{...items[0],version:3}},{id:'v1',version:1,created:100,actor:'管理员',snapshot:items[0]}]};
  try{
    await act(async()=>{root.render(React.createElement(Component,{items,index:{enabled:false},busy:false,request,action,onEdit:()=>{}}));});
    await act(async()=>new Promise(r=>setTimeout(r,210)));
    assert.equal(document.querySelectorAll('.g-knowledge-item').length,50);
    assert.match(document.querySelector('.g-knowledge-list-heading').textContent,/130,319/);
    assert.equal(document.querySelector('.g-knowledge-verify').hidden,true);
    assert.equal(document.querySelectorAll('.g-knowledge-pagination').length,2);
    const origin=byText('版本记录');origin.focus();document.querySelector('.g-content').scrollTop=740;
    await click(origin);
    assert.ok(document.querySelector('dialog[open]'));
    assert.match(document.querySelector('dialog').textContent,/正在读取版本记录/);
    await act(async()=>historyResolve(revisions));
    assert.match(document.querySelector('dialog').textContent,/当前 v3/);
    assert.match(document.querySelector('.g-history-body').textContent,/正文内容/);
    assert.equal(document.querySelector('[aria-label="选择知识版本"]').options.length,2);
    await click(document.querySelector('[aria-label="关闭版本记录"]'));
    assert.equal(document.querySelector('dialog'),null);assert.equal(document.activeElement,origin);assert.equal(document.querySelector('.g-content').scrollTop,740);
    await click(origin);await act(async()=>historyResolve(revisions));
    await act(async()=>Simulate.change(document.querySelector('[aria-label="选择知识版本"]'),{target:{value:'v1'}}));
    await click(byText('恢复此版本'));assert.equal(mutations.length,0);
    await click(byText('确认恢复 v1'));assert.deepEqual(mutations,[{revisionId:'v1',expectedVersion:3}]);
    assert.match(document.querySelector('dialog [role="alert"]').textContent,/已被其他操作修改/);
    await click(byText('重新读取最新版本'));await act(async()=>historyResolve(revisions));
    await act(async()=>Simulate.change(document.querySelector('[aria-label="选择知识版本"]'),{target:{value:'v1'}}));
    failRestore=false;await click(byText('恢复此版本'));await click(byText('确认恢复 v1'));
    assert.equal(document.querySelector('dialog'),null);assert.equal(document.querySelector('[aria-label="知识状态"]').value,'disabled');
    await click(byText('采集与导入'));await click(document.querySelectorAll('.g-knowledge-import-modes button')[3]);
    const textarea=document.querySelector('.g-knowledge-import textarea');
    await act(async()=>Simulate.change(textarea,{target:{value:'未提交的业务资料'}}));
    await click(byText('知识列表'));await click(byText('采集与导入'));
    assert.equal(document.querySelector('.g-knowledge-import textarea').value,'未提交的业务资料');
    await click(byText('检索验证'));assert.equal(document.querySelector('.g-knowledge-verify').hidden,false);
    assert.equal(document.querySelector('[aria-label="业务知识列表"]').parentElement.hidden,true);
  }finally{
    await act(async()=>root.unmount());require.extensions['.ts']=oldTs;require.extensions['.tsx']=oldTsx;
    for(const key of Object.keys(prior)){if(prior[key]===undefined)delete global[key];else global[key]=prior[key];}dom.window.close();
  }
});

test('version sheet is viewport anchored with its own scroll area; hidden task panels cannot enlarge the page',()=>{
  const css=readFileSync(resolve(__dirname,'../../src/growth.css'),'utf8');
  const dom=new JSDOM(`<style>${css}</style><div class="g-app"><div class="g-knowledge-workspace"><fieldset class="g-form-grid g-permission"></fieldset><div hidden class="g-knowledge-verify"></div><dialog open class="g-knowledge-drawer"><div class="g-knowledge-drawer-body"></div></dialog></div></div>`);
  try{
    const style=s=>dom.window.getComputedStyle(dom.window.document.querySelector(s));
    assert.equal(style('.g-knowledge-drawer').position,'fixed');assert.equal(style('.g-knowledge-drawer').overflow,'hidden');
    assert.equal(style('.g-knowledge-drawer-body').overflow,'auto');assert.equal(style('.g-knowledge-verify').display,'none');
    assert.equal(style('fieldset').display,'grid');
  }finally{dom.window.close();}
});

test('continuous sources prioritize existing sources, preserve a collapsed draft, and reveal edits and reviews',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
  const prior={};
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){prior[key]=global[key];global[key]=value;}
  const scrolled=[];dom.window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this.className);};
  const oldTs=require.extensions['.ts'],oldTsx=require.extensions['.tsx'];
  for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,filename)=>module._compile(transformSync(readFileSync(filename,'utf8'),{loader:ext.slice(1),format:'cjs',jsx:'automatic'}).code,filename);
  const Component=require('../../src/KnowledgeSourcesPanel.tsx').default,root=createRoot(document.getElementById('root'));
  const source={id:'source-1',name:'产品文档',url:'https://example.com/help',category:'产品',maxPages:1,maxDepth:1,renderMode:'auto',interval:900,enabled:true,version:2,reviewId:'review-1',status:'review',tracked:1};
  const request=async path=>path.endsWith('/review')?{source,review:{version:1,changes:[{key:'c1',state:'pending',type:'added',incoming:{title:'新文档',body:'待核对正文'}}]}}:{list:[source]};
  const button=text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text);
  const click=async text=>{assert.ok(button(text),text);await act(async()=>button(text).click());};
  try{
    await act(async()=>root.render(React.createElement(Component,{request,action:fn=>fn(),busy:false})));
    assert.equal(document.querySelector('.g-source-editor').hidden,true);
    assert.match(document.querySelector('.g-source-list').textContent,/产品文档/);
    await click('添加持续来源');assert.equal(document.querySelector('.g-source-editor').hidden,false);
    await act(async()=>Simulate.change(document.querySelector('[aria-label="持续同步网页地址"]'),{target:{value:'https://example.com/draft'}}));
    await click('收起添加表单');await click('添加持续来源');
    assert.equal(document.querySelector('[aria-label="持续同步网页地址"]').value,'https://example.com/draft');
    await click('修改设置');assert.equal(document.querySelector('[aria-label="持续同步网页地址"]').readOnly,true);
    assert.equal(scrolled.at(-1),'g-source-editor');
    await click('取消修改');assert.equal(document.querySelector('.g-source-editor').hidden,true);
    await click('查看并审核变更');assert.ok(document.querySelector('.g-source-review'));
    assert.match(scrolled.at(-1),/g-source-review/);assert.match(document.querySelector('.g-source-review').textContent,/待核对正文/);
    await click('收起审核');assert.equal(document.querySelector('.g-source-review'),null);
  }finally{
    await act(async()=>root.unmount());require.extensions['.ts']=oldTs;require.extensions['.tsx']=oldTsx;
    for(const key of Object.keys(prior)){if(prior[key]===undefined)delete global[key];else global[key]=prior[key];}dom.window.close();
  }
});
