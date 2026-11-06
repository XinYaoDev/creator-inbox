'use strict';
const {createHash}=require('node:crypto');
const fingerprint=card=>createHash('sha256').update(JSON.stringify([card.title,card.body,card.url,card.button,card.trigger,card.channel,card.keywords,card.excludeKeywords,card.matchMode,card.cooldownMinutes,card.dailyLimit])).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function createCards({all,get,put,event,clock}){
  function list(conversationId){
    const c=get('conversation',conversationId);
    return all('cardSuggestion').filter(s=>s.conversationId===conversationId).slice(0,50).map(s=>{
      const card=get('card',s.cardId);
      const reason=!c||c.optedOut||c.status==='resolved'?'会话已结束或停止联系':!card?.enabled?'卡片已停用':clock()-s.created>=86400?'建议超过 24 小时，已过期':fingerprint(card)!==s.fingerprint?'卡片已更新，请使用最新版本':'';
      return {...s,available:s.status==='pending'&&!reason,reason};
    });
  }
  function trigger(c,text,triggerName,messageId){
    if(c.optedOut||c.status==='resolved')return [];
    const made=[];
    for(const card of all('card').filter(c=>c.enabled&&c.trigger===triggerName)){
      if(card.channel&&card.channel!=='all'&&card.channel!==c.channel)continue;
      const lower=text.toLowerCase(),keywords=card.keywords||[];
      if((card.excludeKeywords||[]).some(w=>lower.includes(w.toLowerCase())))continue;
      if(keywords.length&&!(card.matchMode==='all'?keywords.every(w=>lower.includes(w.toLowerCase())):keywords.some(w=>lower.includes(w.toLowerCase()))))continue;
      const id=createHash('sha256').update(JSON.stringify([card.id,c.id,messageId])).digest('hex');
      if(get('cardSuggestion',id))continue;
      const previous=all('cardSuggestion').filter(s=>s.cardId===card.id&&s.conversationId===c.id);
      if(previous.some(s=>s.status==='pending'&&clock()-s.created<86400&&s.fingerprint===fingerprint(card)))continue;
      if(previous.some(s=>clock()-s.created<(card.cooldownMinutes??1440)*60))continue;
      if(previous.filter(s=>clock()-s.created<86400).length>=(card.dailyLimit||3))continue;
      const suggestion=put('cardSuggestion',{conversationId:c.id,cardId:card.id,messageId,status:'pending',fingerprint:fingerprint(card),name:card.name,title:card.title,body:card.body,url:card.url,button:card.button,trigger:triggerName},id);
      event(c.id,'卡片建议',card.name+'：已生成待审核文字草稿，未发送');made.push(suggestion);
    }
    return made;
  }
  function act(conversationId,id,action){
    const s=get('cardSuggestion',id);if(!s||s.conversationId!==conversationId)fail('卡片建议不存在',404);
    if(!['adopt','dismiss'].includes(action))fail('卡片操作无效');
    if(s.status!=='pending')fail('卡片建议已处理',409);
    if(action==='adopt'){
      const view=list(conversationId).find(x=>x.id===id);
      if(!view?.available)fail(view?.reason||'卡片建议已失效',409);
    }
    put('cardSuggestion',{...s,status:action==='adopt'?'adopted':'dismissed'},id);
    event(conversationId,action==='adopt'?'采用卡片草稿':'忽略卡片建议',s.name+(action==='adopt'?'：仅填入回复框，尚未发送':''));
    return {status:action==='adopt'?'adopted':'dismissed',...(action==='adopt'?{text:[s.title,s.body,s.url].filter(Boolean).join('\n')}:{} )};
  }
  return {list,trigger,act};
}
module.exports={createCards};
