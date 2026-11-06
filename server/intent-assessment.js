'use strict';
// Advisory sales intent only. Evidence must quote an actual customer message;
// no inferred contact details, demographic profiles or automatic deal stages.
function groundedAssessment(raw,messages){
  if(!raw||!['low','medium','high'].includes(raw.intent)||!Number.isFinite(raw.confidence)||raw.confidence<0.7||raw.confidence>1)return null;
  const evidence=typeof raw.evidence==='string'?raw.evidence.trim().slice(0,200):'';
  const reason=typeof raw.reason==='string'?raw.reason.trim().slice(0,300):'';
  if(evidence.length<4||!reason||!messages.some(m=>m.includes(evidence)))return null;
  const tags=Array.isArray(raw.tags)?[...new Set(raw.tags.filter(x=>typeof x==='string').map(x=>x.trim()).filter(x=>x&&x.length<=30))].slice(0,5):[];
  return {intent:raw.intent,confidence:raw.confidence,evidence,reason,tags};
}
module.exports={groundedAssessment};
