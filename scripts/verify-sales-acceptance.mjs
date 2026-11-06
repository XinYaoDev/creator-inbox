// Read-only checks of the deliberately preserved synthetic browser acceptance records.
// This does not create messages, change the clock, invoke GPT, or replace browser acceptance.
import assert from 'node:assert/strict'
const base='http://127.0.0.1:18879/api/growth'
const get=async path=>{const r=await fetch(base+path);assert.ok(r.ok,`HTTP ${r.status}: ${path}`);return r.json()}
const [listing,workspace]=await Promise.all([get('/conversations'),get('/state')])
const record=listing.list.find(c=>c.name==='多轮复验访客');assert.ok(record,'Run the documented real browser acceptance first')
const detail=await get('/conversations/'+record.id),s=detail.conversation.salesState
assert.equal(detail.conversation.status,'human');assert.equal(s.phase,'handoff');assert.equal(s.turns,8)
assert.equal(s.facts.quantity.value,'三个人');assert.equal(s.facts.timing.value,'下周六上午');assert.equal(s.facts.budget.value,'每人最多150元')
assert.equal(s.noContact,true);assert.equal(s.paused,false);assert.ok(s.objections.some(o=>o.kind==='price'&&o.resolved))
assert.equal(s.asked.quantity,1);assert.equal(s.asked.budget,1);assert.equal(s.asked.confirm,1)
assert.ok(s.confirmation.evidence.includes('交给同事'));assert.equal(detail.lead.stage,'new');assert.equal(detail.salesTimeline.length,8)
assert.ok(detail.salesTimeline.some(t=>t.phase==='paused'));assert.ok(detail.salesTimeline.some(t=>t.phase==='objection'))
const replies=detail.messages.filter(m=>m.role==='ai');assert.equal(replies.length,8)
assert.ok(replies.every(m=>m.model==='gpt-6.1-sol'&&m.delivery==='delivered'&&m.retrieval?.provider==='local'))
assert.equal(detail.messages.at(-1).role,'customer');assert.equal(workspace.tasks.filter(t=>t.conversationId===record.id).length,1)
const boundary=listing.list.find(c=>c.name==='未知余位边界验收');assert.ok(boundary)
const fresh=await get('/conversations/'+boundary.id),memory=fresh.conversation.salesState
assert.equal(memory.turns,1);assert.ok(memory.resetAfterSequence>0);assert.equal(memory.facts.quantity.value,'一个人')
assert.equal(memory.facts.budget.value,'200元');assert.ok(!JSON.stringify(memory.facts).includes('六个'))
assert.ok(memory.originalRequest.evidence.startsWith('现在只我一个人'))
assert.equal(fresh.salesTimeline.length,2);assert.equal(fresh.messages.filter(m=>m.role==='ai').length,2)
console.log(JSON.stringify({eightTurnConversation:record.id,replyCount:replies.length,phase:s.phase,followups:1,dealStage:detail.lead.stage,provider:'local',model:'gpt-6.1-sol',resetConversation:boundary.id,resetVerified:true},null,2))
