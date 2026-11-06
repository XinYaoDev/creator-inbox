import {useEffect,useRef,useState,type FormEvent} from 'react'
import './web-chat.css'
type Message={id:string;sequence:number;role:string;content:string;ts:number;source:string}
type Stored={token:string;expires:number}
const siteId=location.pathname.split('/')[2]||'',storageKey='laike-visitor:'+siteId
function restored():Stored|null{try{const d=JSON.parse(localStorage.getItem(storageKey)||'null');return d&&/^[a-f0-9]{64}$/.test(d.token)&&d.expires>Date.now()/1000?d:null}catch{return null}}
const label=(m:Message)=>m.role==='customer'?'你':m.role==='human'?'人工客服':m.role==='workflow'?'自动服务':m.source==='knowledge'?'知识库答复':m.source==='model'?'AI 助手':'接待提示'
export default function WebChat(){
  const [config,setConfig]=useState<{title:string;intro:string;privacy:string}|null>(null),[session,setSession]=useState<Stored|null>(restored)
  const [messages,setMessages]=useState<Message[]>([]),[status,setStatus]=useState('open'),[replying,setReplying]=useState(false),[optedOut,setOptedOut]=useState(false)
  const [name,setName]=useState(''),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[networkError,setNetworkError]=useState(''),[notice,setNotice]=useState(''),[contact,setContact]=useState(false),[expired,setExpired]=useState(false)
  const [confirmRestart,setConfirmRestart]=useState(false)
  const current=useRef(session),cursor=useRef(0),list=useRef<HTMLDivElement>(null),nearBottom=useRef(true),busyRef=useRef(false),pending=useRef<{content:string;requestId:string}|null>(null)
  current.current=session
  async function call(action:string,body?:unknown,token=current.current?.token){
    const r=await fetch('/api/webchat/'+siteId+'/'+action,{method:body===undefined?'GET':'POST',credentials:'omit',cache:'no-store',headers:{'X-Webchat-Client':'1',...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)})
    const d=await r.json();if(!r.ok){if(r.status===401)setExpired(true);throw new Error(d.error||'连接失败，请重试')}return d
  }
  useEffect(()=>{call('config').then(d=>{setConfig(d);document.title=d.title.includes('在线咨询')?d.title:d.title+' · 在线咨询'}).catch(e=>setError(e.message))},[])
  useEffect(()=>{
    if(!session||expired)return;let cancelled=false,timer:ReturnType<typeof setTimeout>
    const poll=async()=>{try{const d=await call('messages?after='+cursor.current,undefined,session.token);if(cancelled)return
      setStatus(d.status);setOptedOut(d.optedOut);setReplying(d.replying)
      if(d.messages.length){cursor.current=d.messages[d.messages.length-1].sequence;setMessages(old=>{const ids=new Set(old.map(m=>m.id));return [...old,...d.messages.filter((m:Message)=>!ids.has(m.id))]})}
      if(cursor.current)await call('ack',{sequence:cursor.current},session.token)
      if(!cancelled)setNetworkError('')
      if(!cancelled)timer=setTimeout(poll,d.hasMore?100:2000)
    }catch(e){if(!cancelled){setNetworkError((e as Error).message);timer=setTimeout(poll,5000)}}}
    poll();return()=>{cancelled=true;clearTimeout(timer)}
  },[session,expired])
  useEffect(()=>{if(nearBottom.current&&list.current)list.current.scrollTop=list.current.scrollHeight},[messages,replying])
  async function act(fn:()=>Promise<void>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setNotice('');try{await fn()}catch(e){setError((e as Error).message)}finally{busyRef.current=false;setBusy(false)}}
  function remember(value:Stored){current.current=value;setSession(value);try{localStorage.setItem(storageKey,JSON.stringify(value))}catch{setNotice('浏览器不允许保存会话，关闭页面后将无法续聊。')}}
  async function send(e:FormEvent){e.preventDefault();if(!draft.trim())return;const content=draft.trim();await act(async()=>{
    let visitor=current.current
    if(!visitor){const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');const d=await call('session',{token,name},'');visitor={token,expires:d.expires};remember(visitor)}
    if(pending.current?.content!==content)pending.current={content,requestId:crypto.randomUUID()}
    await call('messages',pending.current,visitor.token);pending.current=null;setDraft('');nearBottom.current=true
  })}
  function restart(){try{localStorage.removeItem(storageKey)}catch{/* storage is optional */}current.current=null;setSession(null);cursor.current=0;setMessages([]);setExpired(false);setOptedOut(false);setStatus('open');setReplying(false);setContact(false);setConfirmRestart(false);setDraft('');setName('');setError('');setNetworkError('');setNotice('');nearBottom.current=true;pending.current=null}
  async function saveContact(e:FormEvent<HTMLFormElement>){e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));await act(async()=>{await call('contact',{...data,consent:data.consent==='on'});setContact(false);setNotice('联系方式已提交，工作人员可在本次咨询档案中查看。')})}
  return <main className="wc-shell"><section className="wc-window" aria-label="在线咨询"><header className="wc-header"><span className="wc-mark" aria-hidden="true">来</span><div><h1>{config?.title||'在线咨询'}</h1><p>{expired?'会话已过期':optedOut?'已停止联系':status==='human'?'人工客服接待中':replying?'正在准备答复…':status==='resolved'?'本次咨询已完成':'消息将由接待团队处理'}</p></div>{session&&!expired&&<button disabled={busy||optedOut} onClick={()=>act(async()=>{await call('handoff',{});setStatus('human');setNotice('已申请人工服务，请在此等待回复。')})}>找人工</button>}</header>
    <div className="wc-messages" ref={list} role="log" aria-label="咨询消息" aria-live="polite" onScroll={e=>{const el=e.currentTarget;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}>
      {config&&<div className="wc-welcome"><span>欢迎咨询</span><h2>有什么可以帮你？</h2><p>{config.intro}</p><small>自动答复可能有误，涉及预约、价格或承诺请以工作人员确认为准。</small></div>}
      {messages.map(m=><article key={m.id} className={'wc-message '+(m.role==='customer'?'wc-own':'')}><small>{label(m)} · {new Date(m.ts*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</small><p>{m.content}</p></article>)}
      {replying&&<p className="wc-typing" role="status">接待助手正在准备答复…</p>}
    </div>
    <div className="wc-controls">{networkError&&<p className="wc-error" role="status">连接暂不可用：{networkError}。正在尝试恢复…</p>}{error&&<div className="wc-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="收起错误提示">×</button></div>}{notice&&<p className="wc-notice" role="status">{notice}</p>}
      {expired||optedOut?<div className="wc-restart"><p>{expired?'凭据有效期为 7 天。开始新会话后，旧记录仍由接待团队保留。':'已记录停止联系的意愿，本会话不会再发送回复。'}</p><button onClick={restart}>开始新会话</button></div>:<>
        {session&&<button className="wc-link" onClick={()=>setContact(!contact)}>{contact?'收起联系方式':'自愿留下联系方式'}</button>}
        {contact&&<form className="wc-contact" onSubmit={saveContact}><fieldset disabled={busy}><label>称呼<input name="name" autoComplete="name" maxLength={80}/></label><label>手机号<input name="phone" type="tel" inputMode="tel" maxLength={11} placeholder="手机号或微信至少填一项"/></label><label>微信号<input name="wechat" maxLength={20}/></label><label className="wc-consent"><input name="consent" type="checkbox" required/>同意将联系方式用于本次咨询跟进</label><button>提交联系方式</button></fieldset></form>}
        <form onSubmit={send} className="wc-composer"><fieldset disabled={busy||!config}>
          {!session&&<label className="wc-name">怎么称呼你（可选）<input value={name} onChange={e=>setName(e.target.value)} maxLength={80} placeholder="输入称呼"/></label>}
          <label className="wc-compose-label"><span className="wc-sr-only">咨询内容</span><textarea value={draft} onChange={e=>setDraft(e.target.value)} maxLength={2000} rows={3} placeholder="输入你的问题…" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')e.currentTarget.form?.requestSubmit()}}/></label>
          <div className="wc-send"><small>{draft.length}/2000 · ⌘ / Ctrl + Enter 发送</small><button disabled={busy||!draft.trim()||!config}>{busy?'发送中…':'发送消息'}</button></div>
        </fieldset></form>
      </>}
      {config&&<details className="wc-privacy"><summary>隐私与会话说明</summary><p>{config.privacy} 此设备会保存 7 天有效的会话凭据以便续聊；请勿在共享设备留下联系方式。刷新不会重复发送消息。</p>{session&&!expired&&!optedOut&&(confirmRestart?<div role="group" aria-label="确认新咨询"><p>旧记录仍由接待团队保留，本页面将不再展示旧会话，当前草稿会清空。</p><button disabled={busy||replying} onClick={restart}>确认开始新咨询</button><button onClick={()=>setConfirmRestart(false)}>继续当前咨询</button></div>:<button disabled={busy||replying} onClick={()=>setConfirmRestart(true)}>开始新的咨询</button>)}</details>}
    </div>
  </section></main>
}
