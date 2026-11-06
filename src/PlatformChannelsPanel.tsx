import {useEffect,useRef,useState} from 'react'
import {api} from './api'
type Channel={id:string;provider:string;name:string;appId:string;originalId:string;kfId:string;publicBase:string;agentId:string;revision:number;enabled:boolean;autoReply:boolean;verifiedAt?:number;callbackVerifiedAt?:number;lastInboundAt?:number;lastSentAt?:number;lastError?:string;callbackUrl?:string;callbackPath?:string;status?:string;pending?:number;dead?:number;accounts?:{id:string;name:string;manageable:boolean}[]}
type Platform={id:string;name:string;implemented:boolean;description:string;requirements:string;url:string}
type Draft=Partial<Channel>&{secret?:string;callbackToken?:string;encodingAesKey?:string}
const when=(v?:number)=>v?new Date(v*1000).toLocaleString('zh-CN',{hour12:false}):'尚未完成'
const states:Record<string,string>={pending:'等待处理',retry:'等待重试',dead:'需要处理',done:'已处理',accepted:'平台已接受',failed:'发送失败',unknown:'结果未知',sending:'发送中'}
async function request(path='',body?:unknown,method=body===undefined?'GET':'POST'){
  const r=await api('/api/growth/channels'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}),d=await r.json();if(!r.ok)throw Error(d.error||'渠道请求失败');return d
}
const randomSetup=()=>({callbackToken:Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join(''),encodingAesKey:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=$/,'')})
export default function PlatformChannelsPanel({agents}:{agents:{id:string;name:string}[]}){
  const [list,setList]=useState<Channel[]>([]),[catalog,setCatalog]=useState<Platform[]>([]),[draft,setDraft]=useState<Draft|null>(null),[selected,setSelected]=useState<Channel|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[step,setStep]=useState(0),[activity,setActivity]=useState<any>(null),[listener,setListener]=useState<any>({enabled:false,port:18879}),[canManageListener,setCanManageListener]=useState(false),[callbackPort,setCallbackPort]=useState(18879),[reconcile,setReconcile]=useState<{id:string;result:string;note:string}|null>(null)
  const heading=useRef<HTMLHeadingElement>(null),draftKey=useRef(''),secretBaseline=useRef<Record<string,string>>({})
  async function load(){const d=await request();setList(d.list);setCatalog(d.catalog);setListener(d.callbackListener);setCallbackPort(d.callbackListener.port||18879);setCanManageListener(!!d.canManageListener);return d.list as Channel[]}
  useEffect(()=>{load().catch(e=>setError(e.message))},[])
  useEffect(()=>{heading.current?.focus()},[step,!!draft])
  const dirty=!!draft&&JSON.stringify(draft)!==draftKey.current
  useEffect(()=>{if(!dirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[dirty])
  async function action(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  function open(c?:Channel,p?:Platform){if(dirty&&!window.confirm('当前输入尚未保存，确定切换吗？'))return;setSelected(c||null);const next=c?{...c}:{provider:p!.id,name:p!.name,agentId:agents[0]?.id||'default',...randomSetup()};setDraft(next);draftKey.current=JSON.stringify(next);secretBaseline.current={};setStep(c?1:0);setError('');setNotice('');setActivity(null)}
  function patch(p:Partial<Draft>){setDraft(d=>({...d,...p}))}
  async function save(){
    const payload:any={...draft,expectedRevision:selected?.revision};for(const key of ['callbackToken','encodingAesKey'] as const)if(selected&&payload[key]===secretBaseline.current[key])delete payload[key];
    const saved=await request(selected?'/'+selected.id:'',payload,selected?'PATCH':'POST');
    secretBaseline.current={callbackToken:draft?.callbackToken||'',encodingAesKey:draft?.encodingAesKey||''};
    const next={...saved,callbackToken:draft?.callbackToken,encodingAesKey:draft?.encodingAesKey,secret:''};setSelected(saved);setDraft(next);draftKey.current=JSON.stringify(next);await load();setNotice('已加密保存。接下来检查权限和回调，不会自动发送消息。');setStep(1);return saved as Channel
  }
  async function verify(){let c=selected!;if(dirty)c=await save();let result=await request('/'+c.id+'/verify',{});
    if(!c.kfId&&result.accounts?.filter((a:any)=>a.manageable).length===1){const match=result.accounts.find((a:any)=>a.manageable);c=await request('/'+c.id,{expectedRevision:result.connection.revision,kfId:match.id},'PATCH');result=await request('/'+c.id+'/verify',{});}
    setSelected(result.connection);const next={...result.connection,callbackToken:draft?.callbackToken,encodingAesKey:draft?.encodingAesKey,secret:''};setDraft(next);draftKey.current=JSON.stringify(next);await load();setNotice(result.message)
  }
  async function refresh(){
    if(dirty)throw Error('当前有未保存的修改，请先保存，再刷新连接状态');
    const rows=await load(),fresh=rows.find(c=>c.id===selected?.id);
    if(fresh){setSelected(fresh);const next={...fresh,callbackToken:draft?.callbackToken,encodingAesKey:draft?.encodingAesKey,secret:''};setDraft(next);draftKey.current=JSON.stringify(next);}
    setNotice('已刷新平台回调和接收状态')
  }
  async function copy(text:string){try{await navigator.clipboard.writeText(text);setNotice('已复制')}catch{setError('无法访问剪贴板，请选中对应文本手动复制')}}
  const platform=catalog.find(p=>p.id===(draft?.provider||selected?.provider))
  return <section className="g-panel g-platforms" aria-label="官方平台接入">
    <div className="g-panel-head"><div><h3>平台接入中心</h3><small>先验证，再接待。每个账号独立配置，不混用权限。</small></div><span className="g-badge">{list.length} 个账号</span></div>
    <div className="g-platform-body">
      {error&&<p className="g-error" role="alert">{error}</p>}{notice&&<p className="g-context-note" role="status">{notice}</p>}
      {canManageListener&&<details className="g-platform-runtime"><summary>本机回调入口 · {listener.listening?'已启动':'未启动'}</summary><p className="g-hint">仅接收有平台签名的消息，不提供工作台、文件或管理接口。开启本机入口不等于公网可访问，还需将 HTTPS 回调域名连接到此入口。</p><div className="g-actions"><label className="g-field">本机端口<input type="number" min={1024} max={65535} value={callbackPort} onChange={e=>setCallbackPort(Number(e.target.value))}/></label><button disabled={busy} onClick={()=>action(async()=>{const result=await request('/runtime',{enabled:!listener.enabled,port:callbackPort},'PATCH');setListener(result);setNotice(result.listening?'本机回调入口已启动，仅监听 127.0.0.1:'+result.port:'回调入口已关闭')})}>{listener.enabled?'关闭入口':'开启本机入口'}</button></div>{listener.error&&<p role="alert">{listener.error}</p>}</details>}
      {!draft&&<>
        {!!list.length&&<div className="g-platform-accounts">{list.map(c=><button key={c.id} onClick={()=>open(c)}><span><strong>{c.name}</strong><small>{catalog.find(p=>p.id===c.provider)?.name} · {c.appId}</small></span><span className="g-badge">{c.status}</span>{!!c.dead&&<span>需处理 {c.dead} 项</span>}</button>)}</div>}
        <div className="g-platform-picker">{catalog.map(p=><article key={p.id}><header><h4>{p.name}</h4><span className="g-badge">{p.implemented?'可配置 · 待实号验收':'待完成接入'}</span></header><p>{p.description}</p><small>{p.requirements}</small>{p.implemented?<button onClick={()=>open(undefined,p)}>添加账号 →</button>:<a href={p.url} target="_blank" rel="noreferrer">查看平台与接入条件 ↗</a>}</article>)}</div>
      </>}
      {draft&&<>
        <div className="g-platform-editor-head"><button disabled={busy} onClick={()=>{if(!dirty||window.confirm('放弃未保存的修改？')){setDraft(null);setSelected(null);setActivity(null)}}}>← 账号列表</button><h4 ref={heading} tabIndex={-1}>{platform?.name}接入</h4><span>{selected?.status||'尚未保存'}</span></div>
        <ol className="g-platform-steps">{['填写账号','检查连接','启用接待'].map((s,i)=><li key={s}><button disabled={busy||i>0&&!selected||i===2&&(!selected?.verifiedAt||!selected?.callbackVerifiedAt)} aria-current={step===i?'step':undefined} onClick={()=>setStep(i)}><b>{i+1}</b>{s}</button></li>)}</ol>
        <details className="g-platform-guidance" key={step} open={step===0}><summary>接入准备与官方后台</summary><p>{platform?.requirements}</p><a href={platform?.url} target="_blank" rel="noreferrer">打开官方管理后台 ↗</a><p>当前采用自有应用接入。官方一键扫码需要本产品先取得相应第三方服务商资格，尚未具备。</p></details>
        {step===0&&<form onSubmit={e=>{e.preventDefault();void action(async()=>{await save()})}}><fieldset disabled={busy} className="g-permission"><div className="g-form-grid">
          <label className="g-field">账号备注<input required value={draft.name||''} onChange={e=>patch({name:e.target.value})} maxLength={80}/></label>
          <label className="g-field">{draft.provider==='wecom_kf'?'企业 ID（CorpID）':'公众号 AppID'}<input required value={draft.appId||''} readOnly={!!selected} onChange={e=>patch({appId:e.target.value})}/></label>
          {draft.provider==='wechat_official'&&<label className="g-field">公众号原始 ID<input placeholder="gh_ 开头" required readOnly={!!selected} value={draft.originalId||''} onChange={e=>patch({originalId:e.target.value})}/></label>}
          <label className="g-field">{draft.provider==='wecom_kf'?'可调用微信客服的应用 Secret':'公众号 AppSecret'}<input type="password" autoComplete="new-password" required={!selected} value={draft.secret||''} onChange={e=>patch({secret:e.target.value})} placeholder={selected?'已保存；留空不变':'仅加密保存在本机，不回显'}/></label>
          <label className="g-field wide">HTTPS 回调域名<input type="url" placeholder="https://service.example.com（没有可先留空）" value={draft.publicBase||''} onChange={e=>patch({publicBase:e.target.value})}/></label>
          <div className="wide g-platform-secrets"><p>下面两项为自动生成的回调凭据，请复制到平台的服务器配置，并选择“安全模式”。已有平台配置也可以直接粘贴替换。</p>{(['callbackToken','encodingAesKey'] as const).map((key,i)=><label className="g-field" key={key}>{i?'EncodingAESKey':'回调 Token'}<div className="g-platform-copy"><input type="password" autoComplete="new-password" required={!selected} value={draft[key]||''} placeholder={selected?'已保存，不回显；需变更时重新填写':''} onChange={e=>patch({[key]:e.target.value})}/><button type="button" disabled={!draft[key]} onClick={()=>copy(draft[key]!)}>复制</button></div></label>)}<small>关闭本页后不再显示这些值。修改回调凭据会暂停接入，需重新验证。</small></div>
        </div><div className="g-actions"><button className="primary" disabled={busy}>{busy?'正在保存…':'保存并检查连接'}</button></div></fieldset></form>}
        {step===1&&selected&&<div className="g-platform-checks">
          <article><h4>1 · 凭据与账号权限</h4><p>{selected.verifiedAt?'已验证：'+when(selected.verifiedAt):'尚未验证。此检查不会向顾客发送消息。'}</p><button disabled={busy} onClick={()=>action(verify)}>{busy?'检查中…':'检测账号权限'}</button>
            {draft.provider==='wecom_kf'&&!!draft.accounts?.length&&<label className="g-field">选择客服账号<select value={draft.kfId||''} disabled={!!selected.kfId||busy} onChange={e=>patch({kfId:e.target.value})}><option value="">请选择</option>{draft.accounts.map(a=><option key={a.id} value={a.id} disabled={!a.manageable}>{a.name}{a.manageable?'':'（无管理权限）'}</option>)}</select>{dirty&&<button disabled={busy} onClick={()=>action(verify)}>保存选择并重新检查</button>}</label>}</article>
          <article><h4>2 · 平台回调验证</h4><p>{selected.callbackVerifiedAt?'已收到平台签名验证：'+when(selected.callbackVerifiedAt):'将回调 URL 复制到平台后台并保存，然后刷新检查。'}</p><div className="g-platform-copy"><input aria-label="回调 URL" readOnly value={selected.callbackUrl||selected.callbackPath||''}/><button disabled={!selected.callbackUrl} onClick={()=>copy(selected.callbackUrl!)}>复制 URL</button></div>
            {!selected.publicBase&&<p className="g-warning">还没有配置公网 HTTPS 域名，本机地址不能直接填写到平台。</p>}
            {!listener.listening&&<p className="g-hint">独立回调监听未开启。可在上方“本机回调入口”开启；公网仍需 HTTPS 反向代理，不要公开整个工作台。</p>}
            <div className="g-actions"><button disabled={busy} onClick={()=>action(refresh)}>刷新验证状态</button><button disabled={busy} onClick={()=>setStep(0)}>修改配置</button></div></article>
          <div className="g-actions"><button className="primary" disabled={!selected.verifiedAt||!selected.callbackVerifiedAt||busy} onClick={()=>setStep(2)}>继续设置接待 →</button></div>
        </div>}
        {step===2&&selected&&<div className="g-platform-checks"><div className="g-form-grid"><label className="g-field">接待员工<select value={draft.agentId} onChange={e=>patch({agentId:e.target.value})}>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="g-toggle">接收平台消息<input type="checkbox" checked={!!draft.enabled} onChange={e=>patch({enabled:e.target.checked,...(!e.target.checked?{autoReply:false}:{})})}/></label><label className="g-toggle wide">启用 AI 自动外发（将真实回复顾客）<input type="checkbox" checked={!!draft.autoReply} onChange={e=>patch({autoReply:e.target.checked})}/></label></div>
          <p className="g-hint">建议先保持人工接待：用自己的测试账号发来消息，在“统一接待”回复并检查原平台是否收到，再启用 AI。非文本消息自动转人工；工作流回复和平台原生卡片尚未开放。</p>
          <button className="primary" disabled={busy} onClick={()=>action(async()=>{if(draft.autoReply&&!selected.autoReply&&!window.confirm('启用后，AI 将按排班向真实顾客发送消息。确认已用自己的测试账号完成验收？'))return;await save();setStep(2);setNotice('接待设置已保存')})}>保存接待设置</button>
          <div className="g-platform-evidence"><p>最近进线：{when(selected.lastInboundAt)}</p><p>最近发送被平台接受：{when(selected.lastSentAt)}</p><p>积压：{selected.pending||0} · 需处理：{selected.dead||0}</p></div>
        </div>}
        {selected&&<details className="g-platform-diagnostics"><summary>接收与发送记录 / 故障排查</summary><div className="g-actions"><button disabled={busy} onClick={()=>action(async()=>{setActivity(await request('/'+selected.id+'/activity'));await refresh()})}>读取记录</button><button disabled={busy} onClick={()=>action(async()=>{await request('/'+selected.id+'/retry',{});setNotice('已安排重试接收；不会重发结果未知的消息')})}>重试失败接收</button>{selected.provider==='wecom_kf'&&<button disabled={busy} onClick={()=>action(async()=>{await request('/'+selected.id+'/sync',{});setNotice('已安排增量续拉')})}>增量续拉</button>}</div>{selected.lastError&&<p className="g-error">{selected.lastError}</p>}{activity&&<><h4>最近发送</h4>{!activity.outbox.length&&<p>暂无发送，不会显示虚构的成功记录。</p>}{activity.outbox.map((v:any)=><div key={v.id}><p>{when(v.created)} · {states[v.state]||v.state} {v.error}</p>{v.state==='unknown'&&<button disabled={busy} onClick={()=>setReconcile({id:v.id,result:'accepted',note:''})}>核实原平台结果</button>}</div>)}{reconcile&&<form className="g-platform-secrets" onSubmit={e=>{e.preventDefault();void action(async()=>{await request('/'+selected.id+'/reconcile',{outboxId:reconcile.id,result:reconcile.result,note:reconcile.note,confirmed:true});setActivity(await request('/'+selected.id+'/activity'));setReconcile(null);setNotice('已记录人工核实结果，没有重新发送消息')})}}><p>先到原平台查看该顾客的聊天记录。此操作仅更正本地状态，不发送消息。</p><label className="g-field">核实结果<select value={reconcile.result} onChange={e=>setReconcile({...reconcile,result:e.target.value})}><option value="accepted">确认原平台已收到发送</option><option value="failed">确认原平台没有发送</option></select></label><label className="g-field">核实依据<input required maxLength={500} value={reconcile.note} onChange={e=>setReconcile({...reconcile,note:e.target.value})} placeholder="检查的会话、时间和结果"/></label><button disabled={busy} type="submit">确认已核实并记录</button><button type="button" onClick={()=>setReconcile(null)}>取消</button></form>}<h4>最近接收</h4>{activity.events.map((v:any)=><p key={v.id}>{when(v.created)} · {states[v.state]||v.state} · 尝试 {v.attempts} 次 {v.error}</p>)}<h4>操作记录</h4>{activity.audit.map((v:any,i:number)=><p key={i}>{when(v.created)} · {v.action} · {v.detail}</p>)}</>}</details>}
      </>}
    </div>
  </section>
}
