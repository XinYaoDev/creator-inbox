'use strict';
const {createHash}=require('node:crypto');
const {publicURL,renderingMode}=require('./knowledge-web.js');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=k=>createHash('sha256').update(k.title+'\n'+k.body).digest('hex');
function createKnowledgeSources({db,all,get,put,knowledge,web,event,clock}){
  const detail=id=>get('knowledgeSource',id)||fail('知识来源不存在',404);
  const patch=(id,data)=>{const s=detail(id);return put('knowledgeSource',{...s,...data,version:(s.version||1)+1},id);};
  const view=s=>{const {baseline,...rest}=s;return {...rest,tracked:baseline?.length||0};};
  const pending=id=>{const s=detail(id);return s.reviewId?get('knowledgeSourceReview',s.reviewId):null;};
  function save(input,id){
    const old=id?detail(id):null;
    if(old&&Number(input.expectedVersion)!==old.version)fail('来源已更新，请刷新后再试',409);
    if(old?.jobId)fail('请等待当前同步完成后修改设置',409);
    if(id&&input.url!==undefined&&publicURL(input.url).href!==old.url)fail('更换网址请新建来源，原来源可暂停');
    const url=publicURL(old?.url||input.url).href,interval=Number(input.interval??old?.interval??86400),maxPages=Number(input.maxPages??old?.maxPages??1);
    if(!Number.isInteger(interval)||interval<900||interval>30*86400)fail('同步间隔为 15 分钟至 30 天');
    if(![1,3,5,10,20].includes(maxPages))fail('来源范围支持 1、3、5、10 或 20 页');
    const maxDepth=Number(input.maxDepth??old?.maxDepth??1);if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>3)fail('链接深度为 0–3 层');
    if(!old&&all('knowledgeSource').length>=50)fail('每个空间最多 50 个持续来源');
    const enabled=input.enabled??old?.enabled??true;
    const renderMode=renderingMode(input.renderMode??old?.renderMode);
    const result=put('knowledgeSource',{...old,url,interval,maxPages,maxDepth,renderMode,name:String(input.name??old?.name??new URL(url).hostname).trim().slice(0,100),category:String(input.category??old?.category??'持续同步').trim().slice(0,100),enabled:!!enabled,version:(old?.version||0)+1,baseline:old?.baseline||[],failures:old?.failures||0,nextAt:old?.nextAt||clock(),status:old?.status||'idle'},id);
    event('','知识来源设置',result.name+' / '+(result.enabled?'自动检查':'已暂停'));return view(result);
  }
  function check(id,manual=false){
    const s=detail(id);if(s.jobId)return view(s);
    if(s.reviewId)fail('此来源有待审核变更，请先采用或忽略',409);
    if(!manual&&!s.enabled)return view(s);
    try{const j=web.start({url:s.url,maxPages:s.maxPages,maxDepth:s.maxDepth??1,renderMode:s.renderMode??'auto',category:s.category},{sourceId:id});return view(patch(id,{jobId:j.id,status:'checking',lastAttempt:clock(),error:''}));}
    catch(e){if(e.status===429){if(manual)throw e;return view(patch(id,{nextAt:clock()+60}));}throw e;}
  }
  function reconcile(s){
    if(!s.jobId)return;
    const j=web.detail(s.jobId);if(['queued','running'].includes(j.status))return;
    const failed=j.pages?.filter(p=>p.status==='failed')||[];
    if(j.status!=='completed'){
      const failures=(s.failures||0)+1;patch(s.id,{jobId:null,status:'error',failures,lastChecked:clock(),nextAt:clock()+Math.min(7*86400,s.interval*2**Math.min(failures,8)),error:j.error||'本次采集失败，旧知识保持不变'});return;
    }
    const baseline=s.baseline||[],changes=[],seen=new Set();
    for(const item of j.items){
      seen.add(item.key);const old=baseline.find(b=>b.key===item.key),fingerprint=hash(item);
      if(old?.hash===fingerprint)continue;
      const current=old?.knowledgeId?get('knowledge',old.knowledgeId):item.existingId?get('knowledge',item.existingId):null;
      changes.push({key:item.key,type:old?'changed':'added',incoming:item,hash:fingerprint,knowledgeId:current?.id||'',expectedVersion:current?.version||0,before:current?{title:current.title,body:current.body,enabled:current.enabled,archived:current.archived}:null,state:'pending'});
    }
    // Only a successfully fetched page can establish that an old part vanished.
    // An unreachable page never implies deletion, and partial crawls retain data.
    for(const old of baseline){if(!seen.has(old.key)&&j.pages.some(p=>p.status==='success'&&p.url===old.url)){
      const current=old.knowledgeId?get('knowledge',old.knowledgeId):null;
      changes.push({key:old.key,type:'removed',incoming:null,knowledgeId:current?.id||'',expectedVersion:current?.version||0,before:current?{title:current.title,body:current.body,enabled:current.enabled,archived:current.archived}:null,state:'pending'});
    }}
    const review=changes.length?put('knowledgeSourceReview',{sourceId:s.id,jobId:j.id,changes,version:1,fetchedAt:j.finishedAt}):null;
    const warning=failed.length?'部分页面未成功采集，旧条目保留：'+failed.map(p=>p.error).join('；').slice(0,450):'';
    patch(s.id,{jobId:null,reviewId:review?.id||null,status:review?'review':failed.length?'error':'unchanged',lastChecked:clock(),nextAt:clock()+s.interval,failures:failed.length?s.failures+1:0,error:warning,lastResult:changes.length+' 条变更，'+(j.items.length-changes.filter(c=>c.type!=='removed').length)+' 条未变化'});
    event('','知识来源检查',s.name+' / '+changes.length+' 条待审核');
  }
  let ticking=false;
  function tick(){
    if(ticking)return;ticking=true;
    try{for(let s of all('knowledgeSource')){try{reconcile(s);s=detail(s.id);if(s.enabled&&!s.jobId&&!s.reviewId&&s.nextAt<=clock())check(s.id);}catch(e){patch(s.id,{status:'error',error:String(e.message).slice(0,500),nextAt:clock()+900});}}}finally{ticking=false;}
  }
  function review(id){const s=detail(id);reconcile(s);return {source:view(detail(id)),review:pending(id)};}
  function decide(id,input){
    const s=detail(id),r=pending(id);if(!r||Number(input.expectedVersion)!==r.version)fail('审核批次已变化，请刷新',409);
    if(!['accept','ignore'].includes(input.action)||!Array.isArray(input.keys)||!input.keys.length||new Set(input.keys).size!==input.keys.length)fail('请选择变更及处理方式');
    const selected=input.keys.map(key=>r.changes.find(c=>c.key===key&&c.state==='pending'));if(selected.some(c=>!c))fail('选中变更已处理或不存在',409);
    if(input.action==='accept')for(const c of selected){if(c.knowledgeId){const current=get('knowledge',c.knowledgeId);if(!current||current.version!==c.expectedVersion||current.archived!==c.before.archived)fail('知识在采集后被修改，请忽略此批并重新检查，防止覆盖人工编辑',409);}}
    let baseline=[...(s.baseline||[])],added=0,updated=0,archived=0;
    db.exec('SAVEPOINT source_review');try{
      for(const c of selected){
        let knowledgeId=c.knowledgeId;
        if(input.action==='accept'){
          if(c.type==='removed'){if(knowledgeId){knowledge.save({archived:true,enabled:false,expectedVersion:c.expectedVersion},knowledgeId);archived++;}}
          else{const i=c.incoming,k=knowledge.save({title:i.title,body:i.body,category:i.category,enabled:false,archived:false,...(knowledgeId?{expectedVersion:c.expectedVersion}:{}),source:i.url,sourceMeta:{kind:'web',url:i.url,part:i.part,fetchedAt:r.fetchedAt}},knowledgeId||undefined);knowledgeId=k.id;c.knowledgeId=k.id;c.expectedVersion=k.version;c.before={title:k.title,body:k.body,enabled:false,archived:false};c.type==='added'?added++:updated++;}
        }
        baseline=baseline.filter(b=>b.key!==c.key);if(c.type!=='removed')baseline.push({key:c.key,hash:c.hash,url:c.incoming.url,part:c.incoming.part,knowledgeId});
        c.state=input.action==='accept'?'accepted':'ignored';c.decidedAt=clock();
      }
      const remaining=r.changes.filter(c=>c.state==='pending').length;
      put('knowledgeSourceReview',{...r,version:r.version+1},r.id);
      patch(id,{baseline,reviewId:remaining?r.id:null,lastReviewId:r.id,status:remaining?'review':'idle',nextAt:clock()+s.interval,lastResult:`已处理 ${selected.length} 条；剩余 ${remaining} 条待审核`});
      event('','审核来源变更',s.name+' / '+input.action+' / '+selected.length+' 条');db.exec('RELEASE source_review');
      return {added,updated,archived,remaining,...review(id)};
    }catch(e){db.exec('ROLLBACK TO source_review');db.exec('RELEASE source_review');throw e;}
  }
  const list=()=>{tick();return all('knowledgeSource').map(view);};
  return {save,list,review,decide,tick,check};
}
module.exports={createKnowledgeSources};
