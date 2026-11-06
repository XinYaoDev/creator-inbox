import {useEffect,useState,type FormEvent} from 'react'
import {api} from './api'
type Config={id:string;title:string;intro:string;enabled:boolean;autoReply:boolean;workflowReply?:boolean;agentId:string;origins:string[];dailyLimit:number}
export default function WebChannelPanel({agents}:{agents:{id:string;name:string}[]}) {
  const [saved,setSaved]=useState<Config|null>(null),[draft,setDraft]=useState<Config|null>(null),[origins,setOrigins]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  useEffect(()=>{let active=true;api('/api/growth/web-channel').then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);if(active){setSaved(d);setDraft(d);setOrigins(d.origins.join('\n'))}}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[])
  const dirty=JSON.stringify(draft)!==JSON.stringify(saved)||origins!==(saved?.origins.join('\n')||'')
  useEffect(()=>{if(!dirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[dirty])
  async function save(e:FormEvent){e.preventDefault();if(busy||!draft)return;setBusy(true);setError('');setNotice('');try{const r=await api('/api/growth/web-channel',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({...draft,origins:origins.split('\n').map(s=>s.trim()).filter(Boolean)})});const d=await r.json();if(!r.ok)throw new Error(d.error);setSaved(d);setDraft(d);setOrigins(d.origins.join('\n'));setNotice('已保存，网页咨询配置立即生效。')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  const url=saved?.id?location.origin+'/chat/'+saved.id:''
  return <section className="g-panel"><div className="g-panel-head"><div><h3>网页咨询</h3><small>访客消息直接进入统一接待；无需社交平台账号</small></div><span className={'g-badge '+(saved?.enabled?'green':'neutral')}>{saved?.enabled?'已开放':'未开放'}</span></div><div className="g-team-body">
    {error&&<p className="g-error" role="alert">{error}</p>}{notice&&<p className="g-context-note" role="status">{notice}</p>}
    {draft&&<form onSubmit={save}><fieldset disabled={busy} className="g-permission"><div className="g-form-grid">
      <label className="g-field"><span>访客端标题</span><input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} maxLength={80} required/></label>
      <label className="g-field"><span>接待员工</span><select value={draft.agentId} onChange={e=>setDraft({...draft,agentId:e.target.value})}>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="g-field wide"><span>开场说明</span><textarea value={draft.intro} onChange={e=>setDraft({...draft,intro:e.target.value})} maxLength={600} rows={2}/></label>
      <label className="g-toggle"><span>开放网页咨询</span><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/></label>
      <label className="g-field"><span>接待方式</span><select value={draft.autoReply?'ai':draft.workflowReply?'workflow':'human'} onChange={e=>setDraft({...draft,autoReply:e.target.value==='ai',workflowReply:e.target.value==='workflow'})}><option value="human">人工接待</option><option value="ai">AI / 知识库自动接待</option><option value="workflow">工作流接待</option></select><small>工作流模式仅执行已启用且渠道为网页咨询的任务，不调用 GPT。</small></label>
      <label className="g-field"><span>每日进线消息上限</span><input type="number" min={10} max={10000} value={draft.dailyLimit} onChange={e=>setDraft({...draft,dailyLimit:Number(e.target.value)})}/><small>北京时间每日重置；限制所有访客合计消息数，降低滥用与模型费用风险。</small></label>
      <label className="g-field"><span>允许嵌入的网站（每行一个）</span><textarea value={origins} onChange={e=>setOrigins(e.target.value)} placeholder="https://example.com" rows={3}/><small>只填网站源地址，不含路径。不填则仅支持独立咨询链接及同源嵌入。</small></label>
    </div><p className="g-hint">新会话按所选方式接待；已有人工会话不会被自动抢回。AI 同时遵循员工开关、网页渠道勾选和排班。未配置模型时直接引用已启用知识，无法回答则转人工。停用工作流接待会取消等待中的流程。</p><button className="primary" disabled={busy||(!dirty&&!!saved?.id)}>{busy?'正在保存…':'保存网页渠道'}</button></fieldset></form>}
    {url&&<div className="g-web-install"><h4>接入你的页面</h4><p>独立咨询链接：<a href={url} target="_blank" rel="noreferrer">打开访客咨询页面 ↗</a></p><label className="g-field"><span>嵌入代码</span><textarea readOnly rows={3} value={`<iframe src="${url}" title="在线咨询" style="width:100%;height:640px;border:0;border-radius:16px" referrerpolicy="no-referrer"></iframe>`} onFocus={e=>e.currentTarget.select()}/></label><p className="g-hint">{location.hostname==='127.0.0.1'||location.hostname==='localhost'?'当前仅能在本机访问。正式上线需部署 HTTPS 服务、创建管理员账号，再使用部署后的地址生成代码。':'正式使用前，请确认管理员登录已启用，并根据你的业务提供隐私告知。'} 停用会立即阻止访客收发，但保留历史记录。访客凭据 7 天后失效。</p></div>}
  </div></section>
}
