import {useState} from 'react'
import catalog from '../shared/sales-scenarios.json'
const fields:Record<string,string>=Object.fromEntries(Object.entries(catalog.fields).map(([k,v])=>[k,v.label]))
const questions:Record<string,string>=Object.fromEntries(Object.entries(catalog.fields).map(([k,v])=>[k,v.question]))
const phases:Record<string,string>={discovery:'了解需求',recommendation:'匹配方案',objection:'处理顾虑',next_step:'确认下一步',handoff:'人工交接',paused:'暂停推进'}
export function salesFormData(f:FormData){return {salesScenario:f.get('salesScenario'),knowledgeCategories:f.getAll('knowledgeCategories'),salesEnabled:f.has('salesEnabled'),salesGoal:f.get('salesGoal'),salesRequired:f.getAll('salesRequired'),salesQuestions:Object.fromEntries(Object.keys(fields).map(k=>[k,f.get('salesQuestion_'+k)])),salesObjections:f.get('salesObjections'),salesMaxTurns:Number(f.get('salesMaxTurns'))}}
export function SalesPlaybookFields({agent}:{agent:any}){
  const [draft,setDraft]=useState({scenario:agent.salesScenario||'general',goal:agent.salesGoal||catalog.scenarios[0].goal,required:agent.salesRequired||['need','timing'],questions:{...questions,...agent.salesQuestions}})
  const [selected,setSelected]=useState(draft.scenario),[applied,setApplied]=useState(false)
  const scenario=catalog.scenarios.find(s=>s.id===draft.scenario)||catalog.scenarios[0]
  const apply=()=>{const next=catalog.scenarios.find(s=>s.id===selected)!;setDraft({scenario:next.id,goal:next.goal,required:next.required,questions:{...questions}});setApplied(true)}
  return <section className="wide g-sales-playbook"><div className="g-panel-head"><div><h3>多轮销售接待</h3><small>理解需求 → 解释方案与顾虑 → 确认下一步 → 人工落实</small></div><label className="g-toggle"><span>启用多轮接待</span><input type="checkbox" name="salesEnabled" defaultChecked={agent.salesEnabled}/></label></div>
    <input type="hidden" name="salesScenario" value={draft.scenario}/>
    <div className="g-scenario-picker"><label className="g-field"><span>行业接待模板</span><select aria-label="行业接待模板" value={selected} onChange={e=>setSelected(e.target.value)}>{catalog.scenarios.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><button type="button" onClick={apply}>应用到接待配置</button></div>
    <p className="g-hint">应用模板会替换接待目标、必需字段和追问，不改变品牌、知识范围、渠道或启用状态；点击底部保存后才生效。</p>
    {applied&&<p role="status" className="g-context-note">已应用「{scenario.name}」，尚未保存。</p>}
    <p><strong>当前场景：{scenario.name}</strong> · {scenario.description}</p><p className="g-context-note">{scenario.guard}</p>
    <p className="g-hint">需同时开启信息提取。只记住有顾客原话依据的信息；不重复询问已问过或拒绝提供的字段，不索取敏感身份资料。暂停、人工接管和停止联系优先于销售目标。</p>
    <label className="g-field"><span>接待目标</span><textarea name="salesGoal" rows={2} maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})}/></label>
    <div className="g-sales-questions">{scenario.fields.map(k=><div className="g-sales-question" key={k}><label><input type="checkbox" name="salesRequired" value={k} checked={draft.required.includes(k)} onChange={e=>setDraft({...draft,required:e.target.checked?[...draft.required,k]:draft.required.filter((x:string)=>x!==k)})}/>{fields[k]}</label><label className="g-field"><span>{fields[k]}追问（每会话最多一次）</span><input name={'salesQuestion_'+k} value={draft.questions[k]} onChange={e=>setDraft({...draft,questions:{...draft.questions,[k]:e.target.value}})} maxLength={160}/></label></div>)}</div>
    <label className="g-field"><span>异议处理规范（价格与承诺仍必须有知识依据）</span><textarea name="salesObjections" rows={3} maxLength={2000} defaultValue={agent.salesObjections||'先认可顾虑，再依据知识解释；不虚构优惠、不贬低竞品、不制造紧迫感；顾客拒绝后不纠缠。'}/></label>
    <label className="g-field"><span>自动推进轮次上限</span><input name="salesMaxTurns" type="number" min={2} max={30} defaultValue={agent.salesMaxTurns||12}/><small>达到上限转人工，不自动改变客户的预约或成交阶段。</small></label>
  </section>
}
export default function SalesDialoguePanel({conversation,summary,timeline=[],readOnly,busy,onReset}:{conversation:any;summary:string;timeline?:any[];readOnly:boolean;busy:boolean;onReset:()=>void}){
  const [resetId,setResetId]=useState('')
  const s=conversation.salesState
  if(!s)return null
  return <section className="g-sales-memory" aria-label="多轮需求档案"><div className="g-panel-head"><h4>需求档案</h4><span className="g-badge green">{phases[s.phase]||s.phase}</span></div><p className="g-hint">{s.scenarioName||'通用接待'} · 接待第 {s.turns} 轮 · 档案 v{s.version} · 仅团队可见</p>
    {Object.entries(s.facts||{}).map(([k,v]:[string,any])=><details key={k}><summary>{fields[k]||k}：{v.value}</summary><p>顾客原话：{v.evidence}</p><small>{v.at?new Date(v.at*1000).toLocaleString('zh-CN'):''}</small></details>)}
    {!Object.keys(s.facts||{}).length&&<p>暂无有依据的需求信息</p>}
    {s.constraints?.map((c:any,i:number)=><details key={i}><summary>补充限制 · {fields[c.field]||c.field}：{c.value}</summary><p>顾客原话：{c.evidence}</p></details>)}
    {!!s.declined?.length&&<p>拒绝提供：{s.declined.map((k:string)=>fields[k]||k).join('、')}</p>}
    {s.noContact&&<p className="g-context-note">顾客不愿留联系方式，不再重复索取。</p>}
    {s.objections?.map((o:any)=><p key={o.kind}><strong>{o.resolved?'顾虑已回应':'顾客顾虑'}：</strong>{o.evidence}</p>)}
    <p className="g-sales-next">下一步：{s.nextAction}</p>
    <details><summary>查看 / 复制交接摘要</summary><textarea aria-label="人工交接摘要" value={summary||''} readOnly rows={10} onFocus={e=>e.target.select()}/><small>点击文本框可全选复制。不会自动预约、付款或修改成交阶段。</small></details>
    <details><summary>最近接待轨迹（{timeline.length}）</summary>{timeline.map(t=><p key={t.id}><strong>v{t.version} · {phases[t.phase]}</strong><br/>{t.nextAction}</p>)}</details>
    {!readOnly&&(resetId===conversation.id?<div role="group" aria-label="确认重置需求档案"><p>重新了解当前需求；旧聊天和轨迹保留，但不再作为新需求上下文。拒绝留资意愿仍受尊重。</p><button disabled={busy||conversation.status==='ai'} onClick={()=>{setResetId('');onReset()}}>确认重新了解</button><button disabled={busy} onClick={()=>setResetId('')}>保留当前档案</button></div>:<button disabled={busy||conversation.status==='ai'} onClick={()=>setResetId(conversation.id)}>重新了解需求</button>)}
    {conversation.status==='ai'&&<small>如需重置，请先人工接管。</small>}
  </section>
}
