import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from './api'
import LibraryTab from './LibraryTab'
import NoteTab from './components/NoteTab'
import AccountsTab from './components/AccountsTab'
import PublishTab from './components/PublishTab'
import WorkflowPanel from './WorkflowPanel'
import TeamPanel, {LoginPanel} from './TeamPanel'
import KnowledgePanel from './KnowledgePanel'
import CommercePanel from './CommercePanel'
import ModelSettingsPanel from './ModelSettingsPanel'
import ReportsPanel from './ReportsPanel'
import UpdateNotice from './UpdateNotice'
import WebChannelPanel from './WebChannelPanel'
import PlatformChannelsPanel from './PlatformChannelsPanel'
import SalesDialoguePanel,{SalesPlaybookFields,salesFormData} from './SalesDialoguePanel'
import KnowledgeScope from './KnowledgeScope'
import type { Account, Group } from './types'
import './growth.css'

type RecordData = { id: string; [key: string]: any }
type State = { access:{role:string;name:string;secured:boolean;memberId?:string;workspaceId?:string;workspaceName?:string}; stats: any; agents: RecordData[]; members: RecordData[]; knowledge: RecordData[]; rules: RecordData[]; cards: RecordData[]; tasks: RecordData[]; channels: Record<string, string>; workflows:RecordData[]; workflowRuns:RecordData[] }
type Detail = { conversation: RecordData; messages: RecordData[]; lead: RecordData | null; events: RecordData[]; cardSuggestions?:RecordData[];salesSummary?:string;salesTimeline?:RecordData[] }
type Page = 'overview'|'inbox'|'comments'|'leads'|'agent'|'knowledge'|'rules'|'reports'|'cards'|'settings'|'library'|'notes'|'publish'|'workflows'|'model'|'commerce'
const stages: Record<string,string> = {new:'新线索',qualified:'跟进中',scheduled:'已预约',won:'已成交',lost:'已流失'}
const statusText: Record<string,string> = {open:'待接待',ai:'AI 接待',human:'人工接待',resolved:'已完成'}
const intentText: Record<string,string> = {high:'高意向',medium:'有意向',low:'待识别'}
const channelText: Record<string,string> = {wechat:'视频号',douyin:'抖音',xiaohongshu:'小红书',wecom:'微信客服',wechat_official:'微信公众号',web:'网页咨询',sandbox:'测试'}
const names: Record<Page,string> = {overview:'工作概览',inbox:'统一接待',comments:'评论管理',leads:'顾客与线索',agent:'AI 员工',knowledge:'业务知识库',rules:'自动化跟进',reports:'数据报表',cards:'营销卡片',settings:'渠道与团队',library:'素材库',notes:'内容创作',publish:'发布助手',workflows:'智能任务',model:'模型设置',commerce:'本地业务台'}
const desc: Partial<Record<Page,string>> = {overview:'让每一次咨询，都有下一步。',leads:'从首次咨询到成交，让客户关系持续向前。',agent:'把业务知识与接待方式，交给你的数字同事。',knowledge:'让每个回答有据可查。',rules:'把重复的分配、打标与提醒，交给规则。',reports:'从真实会话中，找到值得改善的环节。',cards:'准备可复用的信息卡片。',settings:'管理你的接待渠道和负责人。',model:'灵活配置 GPT：独立 API 密钥，或本机 Hermes → Codex 连接。'}
const stamp = (n: number) => n ? new Date(n*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—'
const arrayText = (s:string) => s.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean)
async function request(path:string, body?:unknown, method=body===undefined?'GET':'POST') {
  const r=await api('/api/growth'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
  const d=await r.json()
  if(!r.ok||d.ok===false)throw new Error(d.error||'请求失败')
  return d
}
function Icon({name,size=20}:{name:string;size?:number}) {
  const paths:Record<string,ReactNode>={
    overview:<><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    inbox:<><path d="M4 4h16v12l-4 4H4z"/><path d="M4 14h5l2 3h3l2-3h4"/></>,
    comments:<><path d="M4 4h16v13H9l-5 4z"/><path d="M8 8h8M8 12h5"/></>,
    leads:<><circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 5a4 4 0 0 1 0 8M19 16a5 5 0 0 1 3 5"/></>,
    agent:<><rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4M9 13h.01M15 13h.01M9 17h6M1 11v6M23 11v6"/></>,
    knowledge:<><path d="M12 5c-3-3-7-3-10-1v16c4-2 7-2 10 0 3-2 6-2 10 0V4c-3-2-7-2-10 1zM12 5v15"/></>,
    rules:<><rect x="8" y="2" width="8" height="5" rx="1"/><rect x="2" y="17" width="7" height="5" rx="1"/><rect x="15" y="17" width="7" height="5" rx="1"/><path d="M12 7v5H5v5M12 12h7v5"/></>,
    reports:<><path d="M3 3v18h18M7 17v-6M12 17V6M17 17v-9"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 3-1 4 4 1 2 3 4-1 2-3 4-1 1-4-3-2-1-4-4-1z"/></>,
    cards:<><rect x="2" y="5" width="20" height="15" rx="3"/><path d="M2 10h20M6 15h4"/></>,
    library:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-5 4 3 3-3 5 5"/></>,
    notes:<><path d="M14 3H4v18h16V10M10 14l3-1 8-8-3-3-8 8z"/></>,
    publish:<><path d="m3 11 18-8-8 18-2-8zM11 13 10 10"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,
    search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
    check:<path d="m5 12 4 4L19 6"/>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,
    refresh:<><path d="M20 7V2l-3 3a9 9 0 1 0 4 8M20 7h-5"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.overview}</svg>
}
function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={'g-badge '+tone}>{children}</span>}
function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="g-empty"><span className="g-empty-icon"><Icon name="inbox" size={28}/></span><h3>{title}</h3><p>{children||'接入渠道或创建测试会话后，数据会显示在这里。'}</p></div>}
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement;ref.current?.focus()
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'){
      const items=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]')||[])
      if(!items.length)return
      if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items[items.length-1]?.focus()}
      if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus()}
    }}
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus()}
  },[onClose])
  return <div className="g-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="g-modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><button className="g-icon" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></header>{children}</div></div>
}
function Field({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}){return <label className={'g-field'+(wide?' wide':'')}><span>{label}</span>{children}</label>}
function TextField({label,name,value='',type='text',required=false}:{label:string;name:string;value?:string|number;type?:string;required?:boolean}){return <Field label={label}><input name={name} type={type} defaultValue={value} required={required}/></Field>}
function Area({label,name,value='',rows=4}:{label:string;name:string;value?:string;rows?:number}){return <Field label={label} wide><textarea name={name} defaultValue={value} rows={rows}/></Field>}
function Toggle({label,name,checked=false}:{label:string;name:string;checked?:boolean}){return <label className="g-toggle"><span>{label}</span><input type="checkbox" name={name} defaultChecked={checked}/></label>}
function Search({value,onChange,placeholder='搜索'}:{value:string;onChange:(v:string)=>void;placeholder?:string}){return <label className="g-search"><Icon name="search" size={17}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/></label>}

export default function GrowthApp(){
  const initial=(location.hash.slice(1) as Page)||'overview'
  const [page,setPageState]=useState<Page>(names[initial]?initial:'overview')
  const [state,setState]=useState<State|null>(null),[conversations,setConversations]=useState<RecordData[]>([]),[total,setTotal]=useState(0),[listPage,setListPage]=useState(1)
  const [leads,setLeads]=useState<RecordData[]>([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState<Detail|null>(null)
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[channel,setChannel]=useState('all')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[toast,setToast]=useState(''),[auth,setAuth]=useState(false)
  const [modal,setModal]=useState<{kind:string;item?:RecordData}|null>(null)
  const [drafts,setDrafts]=useState<Record<string,{text:string;note:boolean;requestId:string}>>({}),[suggestion,setSuggestion]=useState<any>(null)
  const [showCustomer,setShowCustomer]=useState(false)
  const message=drafts[selected]?.text||'',noteMode=drafts[selected]?.note||false
  const setMessage=(text:string)=>setDrafts(old=>({...old,[selected]:{text,note:old[selected]?.note||false,requestId:crypto.randomUUID()}}))
  const setNoteMode=(note:boolean)=>setDrafts(old=>({...old,[selected]:{text:old[selected]?.text||'',note,requestId:crypto.randomUUID()}}))
  const [agentId,setAgentId]=useState('default'),[preview,setPreview]=useState<any>(null)
  const [leadStage,setLeadStage]=useState('all'),[leadView,setLeadView]=useState('table'),[runs,setRuns]=useState<RecordData[]>([])
  const [accounts,setAccounts]=useState<Account[]>([]),[groups,setGroups]=useState<Group[]>([])
  const selectedRef=useRef(selected);selectedRef.current=selected
  const contentRef=useRef<HTMLDivElement>(null)
  const messagesRef=useRef<HTMLDivElement>(null),stickToBottom=useRef(true),lastViewed=useRef('')
  const listSequence=useRef(0)
  const busyRef=useRef(false)
  const isAdmin=!state||state.access.role==='admin',readOnly=state?.access.role==='viewer'
  const legacyAllowed=isAdmin&&(!state?.access.workspaceId||state.access.workspaceId==='default')
  const setPage=(p:Page)=>{if(p!==page&&!window.dispatchEvent(new Event('g-before-navigate',{cancelable:true})))return;setPageState(p);location.hash=p;setSearch('');setFilter('all');setListPage(1)}
  const closeModal=useCallback(()=>setModal(null),[])
  const notify=(s:string)=>{setToast(s);setTimeout(()=>setToast(''),3500)}
  const loadState=useCallback(async()=>{setState(await request('/state'));setLeads((await request('/leads')).list)},[])
  const loadList=useCallback(async()=>{
    const sequence=++listSequence.current
    const params=new URLSearchParams({q:search,status:filter,channel,page:String(listPage),kind:page==='comments'?'comment':'all'})
    const d=await request('/conversations?'+params);if(sequence===listSequence.current){setConversations(d.list);setTotal(d.total)}
  },[search,filter,channel,listPage,page])
  const loadDetail=useCallback(async()=>{if(selected){const data=await request('/conversations/'+selected);if(selectedRef.current===selected)setDetail(previous=>{
    if(previous?.conversation.id!==selected)return data
    const ids=new Set(data.messages.map((m:RecordData)=>m.id));return {...data,messages:[...previous.messages.filter(m=>!ids.has(m.id)),...data.messages]}
  })}},[selected])
  const loadAccounts=useCallback(async()=>{const r=await api('/api/accounts');if(!r.ok)throw new Error('账号读取失败');const d=await r.json();setAccounts(d.accounts||[]);setGroups(d.groups||[])},[])
  const refresh=useCallback(async()=>{await Promise.all([loadState(),loadList(),loadDetail()])},[loadState,loadList,loadDetail])
  const action=async(fn:()=>Promise<unknown>,success?:string)=>{
    if(busyRef.current)return
    busyRef.current=true;setBusy(true);setError('')
    try{await fn();if(success)notify(success);try{await refresh()}catch{setError('操作已完成，但数据刷新失败。请点击右上角刷新数据，不要重复提交。')}}catch(e){setError((e as Error).message)}finally{busyRef.current=false;setBusy(false)}
  }
  useEffect(()=>{const fn=()=>{setAuth(true);setState(null);setDetail(null);setConversations([]);setLeads([]);setModal(null);setDrafts({});setSuggestion(null)};window.addEventListener('inbox:unauthorized',fn);return()=>window.removeEventListener('inbox:unauthorized',fn)},[])
  useEffect(()=>{const fn=()=>{const p=location.hash.slice(1) as Page;if(names[p])setPageState(p)};window.addEventListener('hashchange',fn);return()=>window.removeEventListener('hashchange',fn)},[])
  useEffect(()=>{if(contentRef.current)contentRef.current.scrollTop=0},[page])
  useEffect(()=>{if(page==='comments')setSelected('')},[page])
  useEffect(()=>{loadState().catch(e=>setError(e.message))},[loadState])
  useEffect(()=>{let active=true;const t=setTimeout(()=>{if(active)loadList().catch(e=>setError(e.message))},180);return()=>{active=false;clearTimeout(t)}},[loadList])
  useEffect(()=>{setSuggestion(null);setShowCustomer(false);setDetail(null);loadDetail().catch(e=>setError(e.message))},[loadDetail])
  useEffect(()=>{if(!detail||detail.conversation.id!==selected||!messagesRef.current)return;if(stickToBottom.current||lastViewed.current!==selected){messagesRef.current.scrollTop=messagesRef.current.scrollHeight;stickToBottom.current=true}lastViewed.current=selected},[selected,detail?.messages[detail.messages.length-1]?.id])
  useEffect(()=>{if(!Object.values(drafts).some(d=>d.text.trim()))return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard)},[drafts])
  useEffect(()=>{const timer=setInterval(()=>refresh().catch(()=>{}),20000);return()=>clearInterval(timer)},[refresh])
  useEffect(()=>{if(state&&legacyAllowed&&(page==='settings'||page==='publish'))loadAccounts().catch(e=>setError(e.message));if(page==='rules'&&isAdmin)request('/runs').then(d=>setRuns(d.list)).catch(e=>setError(e.message))},[page,loadAccounts,legacyAllowed,isAdmin,!!state])
  useEffect(()=>{if(!state)return;if((!isAdmin&&!['overview','inbox','comments','leads','reports','settings'].includes(page))||(!legacyAllowed&&['library','notes','publish'].includes(page)))setPage('overview')},[page,isAdmin,legacyAllowed,!!state])
  const members=state?.members||[],agent=state?.agents.find(a=>a.id===agentId)||state?.agents[0]
  const ownerName=(id:string)=>members.find(m=>m.id===id)?.name||'未分配'
  const openConversation=(id:string)=>{setPage('inbox');setSelected(id)}
  const saveResource=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();const data=new FormData(e.currentTarget),b:any=Object.fromEntries(data),kind=modal!.kind,item=modal?.item
    if(['knowledge','rule','card'].includes(kind))b.enabled=data.has('enabled')
    if(kind==='knowledge'&&item)b.expectedVersion=item.version||1
    if(kind==='rule')b.minutes=Number(b.minutes)
    if(kind==='card'){b.keywords=arrayText(b.keywords||'');b.excludeKeywords=arrayText(b.excludeKeywords||'')}
    if(kind==='member')b.active=true
    if(kind==='lead')b.tags=arrayText(b.tags||'')
    await action(async()=>{
      if(kind==='sandbox'){const c=await request('/sandbox',b);openConversation(c.id)}
      else if(kind==='task')await request('/conversations/'+selected+'/task',{...b,dueAt:new Date(b.dueAt).getTime()/1000})
      else await request('/'+(kind==='lead'?'leads':kind)+(item?'/'+item.id:''),b,item?'PATCH':'POST')
      closeModal()
    },'已保存')
  }
  const downloadLeads=async()=>{const r=await api('/api/growth/leads.csv');if(!r.ok)throw new Error('导出失败');const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download='客户线索.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  const visibleLeads=leads.filter(l=>(leadStage==='all'||l.stage===leadStage)&&(l.name+' '+l.phone+' '+l.wechat+' '+l.tags.join(' ')).includes(search))
  const navGroups:[string,Page[]][]=isAdmin?[['工作空间',['overview','inbox','comments','leads','commerce']],['AI 工作中心',['agent','knowledge','rules','workflows','cards','model']],['内容与洞察',legacyAllowed?['notes','library','publish','reports']:['reports']]]:[['工作空间',['overview','inbox','comments','leads','reports']]]
  if(auth)return <div className="g-app"><LoginPanel/></div>
  return <div className="g-app">
    <aside className="g-sidebar">
      <a className="g-brand" href="#overview" onClick={e=>{e.preventDefault();setPage('overview')}}><span className="g-logo">来</span><span>来客 <em>AI</em><small>增长工作台</small></span></a>
      <div className="g-workspace"><span className="g-workspace-icon">创</span><span>{state?.access.workspaceName||'我的创作团队'}<small>独立数据工作空间</small></span><span className="g-dots">···</span></div>
      <nav aria-label="主导航">{navGroups.map(([label,pages])=><div className="g-navgroup" key={label}><p>{label}</p>{pages.map(p=><button key={p} aria-label={names[p]} title={names[p]} aria-current={page===p?'page':undefined} className={page===p?'active':''} onClick={()=>setPage(p)}><Icon name={p==='model'?'settings':p}/><span>{names[p]}</span>{p==='inbox'&&!!state?.stats.pending&&<b>{state.stats.pending}</b>}{p==='agent'&&<small>Agent</small>}</button>)}</div>)}</nav>
      <div className="g-sidebar-bottom"><button className={page==='settings'?'active':''} onClick={()=>setPage('settings')}><Icon name="settings"/>{names.settings}</button>{legacyAllowed&&<a href="?legacy=1" className="g-legacy-link">原版创作者工作台 <span>↗</span></a>}<div className="g-profile"><span>{state?.access.name.slice(0,1)||'我'}</span><div>{state?.access.name||'正在连接'}<small>数据存储于本地</small></div><i/></div></div>
    </aside>
    <main className="g-main">
      <UpdateNotice/>
      <header className="g-topbar"><span>工作空间 <i>/</i> <strong>{names[page]}</strong></span><div><span className="g-model"><i/>{state?.stats.modelConfigured?'模型已配置':'知识库模式'}</span>{state?.stats.demo&&<Badge tone="amber">隔离演示环境</Badge>}<button className="g-icon" aria-label="刷新数据" disabled={busy} onClick={()=>action(async()=>{if(isAdmin)await request('/sync',{});await refresh()},'已同步本地数据')}><Icon name="refresh" size={18}/></button><span className="g-user">我</span></div></header>
      {error&&<div className="g-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}
      {state&&!isAdmin&&<div className="g-context-note">当前身份：{state.access.name} · {readOnly?'只读成员（不能修改、回复或导出）':'接待员（可回复与管理顾客，不可修改系统配置）'}。权限由服务端强制校验。</div>}
      {!state?<div className="g-loading">正在连接工作台…{error&&<button onClick={()=>action(refresh)}>重试连接</button>}</div>:<>
      {!['inbox','comments','notes','library','publish'].includes(page)&&<div className="g-page-heading"><div><div className="g-eyebrow">WORKSPACE / {page.toUpperCase()}</div><h1>{names[page]}</h1><p>{desc[page]}</p></div><div className="g-actions">
        {page==='overview'&&isAdmin&&<><button onClick={()=>setPage('settings')}>管理渠道</button><button className="primary" onClick={()=>setModal({kind:'sandbox'})}><Icon name="plus" size={16}/>测试接待</button></>}
        {page==='leads'&&!readOnly&&<button onClick={()=>action(downloadLeads,'已导出客户线索')}>导出 CSV ↗</button>}
        {['knowledge','rules','cards'].includes(page)&&<button className="primary" onClick={()=>setModal({kind:page==='knowledge'?'knowledge':page==='rules'?'rule':'card'})}><Icon name="plus" size={16}/>新增{page==='knowledge'?'知识':page==='rules'?'规则':'卡片'}</button>}
        {page==='agent'&&<button className="primary" disabled={busy} onClick={()=>action(async()=>{const a=await request('/agent',{...agent,name:'新的接待助手',enabled:false});setAgentId(a.id)},'员工已创建')}>＋ 新增员工</button>}
      </div></div>}
      <div ref={contentRef} className={'g-content '+(['inbox','comments'].includes(page)?'g-content-chat':'')}>
      {page==='model'&&isAdmin&&<ModelSettingsPanel onRefresh={loadState}/>}
      {page==='commerce'&&isAdmin&&<CommercePanel request={request} busy={busy} onOpen={openConversation}/>}
      {page==='workflows'&&<WorkflowPanel state={state} conversations={conversations} request={request} action={action} onOpen={openConversation} busy={busy}/>}
      {page==='overview'&&<>
        <section className="g-hero"><div><Badge tone="green">每个机会，认真接住</Badge><h2>从一次对话，<br/>开始下一次增长。</h2><p>把分散的咨询连起来，让 AI 帮你理解需求，<br/>让团队专注更有价值的关系。</p><button onClick={()=>setPage('inbox')}>进入接待工作台 <Icon name="arrow" size={16}/></button></div><div className="g-orbit"><div className="g-orbit-label top">01 · 接住咨询</div><span className="g-orbit-core"><Icon name="agent" size={42}/><b>AI + 你的团队</b></span><div className="g-orbit-label left">02 · 识别意向</div><div className="g-orbit-label right">03 · 持续跟进</div><i className="orbit-dot"/></div></section>
        <div className="g-metrics">{[['inbox','累计会话',state.stats.total,'已进入工作台的咨询'],['leads','已留资客户',state.stats.captured,'包含电话或微信的客户'],['agent','等待人工',state.stats.human,'需要同事进一步处理'],['reports','已成交',state.stats.won,'已标记成交的客户']].map(([icon,label,n,hint])=><section className="g-metric" key={String(label)}><div><span>{label}</span><Icon name={String(icon)}/></div><strong>{n}</strong><small>{hint}</small></section>)}</div>
        <div className="g-two-col"><section className="g-panel"><div className="g-panel-head"><h3>近 7 天咨询</h3><span>会话创建数 · 北京时间</span></div><Trend data={state.stats.trend}/></section><section className="g-panel"><div className="g-panel-head"><h3>接待准备</h3><span>三个步骤，开始工作</span></div><div className="g-setup">{(isAdmin?[['settings','接入你的渠道','连接账号，让咨询进入同一个工作台'],['knowledge','准备业务知识','录入常见问题、产品和服务说明'],['agent','培训 AI 员工','配置接待方式，在测试会话里验证']]:[['inbox','查看待接待咨询','接住新咨询，保留对话上下文'],['leads','查看顾客进展','了解联系方式、意向和跟进阶段'],['reports','查看接待报表','了解团队接待和转化表现']]).map(([p,title,hint],i)=><button key={p} onClick={()=>setPage(p as Page)}><span>{i+1}</span><div><strong>{title}</strong><small>{hint}</small></div><Icon name="arrow" size={16}/></button>)}</div></section></div>
        <section className="g-panel"><div className="g-panel-head"><h3>待办跟进 <Badge>{state.tasks.filter(t=>t.status==='pending').length}</Badge></h3>{isAdmin&&<button className="text" onClick={()=>setPage('rules')}>查看自动化 →</button>}</div><Tasks tasks={state.tasks} busy={busy||readOnly} onDone={t=>action(()=>request('/tasks/'+t.id,{status:'done'},'PATCH'),'跟进已完成')} onOpen={openConversation}/></section>
      </>}
      {['inbox','comments'].includes(page)&&<div className={'g-inbox'+(selected?' has-selection':'')}>
        <section className="g-conversation-list"><div className="g-list-heading"><h2>{names[page]}</h2><button className="g-icon" aria-label="新建测试会话" disabled={!isAdmin} onClick={()=>setModal({kind:'sandbox'})}><Icon name="plus"/></button></div><Search value={search} onChange={v=>{setSearch(v);setListPage(1)}} placeholder="搜索顾客或消息"/>
          <div className="g-list-filters"><select aria-label="会话状态" value={filter} onChange={e=>{setFilter(e.target.value);setListPage(1)}}>{Object.entries({all:'全部会话',pending:'未回复',unread:'未读',unassigned:'未分配',ai:'AI 接管',human:'待人工处理',resolved:'已完成'}).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select><select aria-label="接入渠道" value={channel} onChange={e=>{setChannel(e.target.value);setListPage(1)}}><option value="all">所有渠道</option>{Object.entries(channelText).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></div>
          <div className="g-conversation-scroll">{!conversations.length?<Empty title="暂无会话"/>:conversations.map(c=><button className={'g-conversation '+(selected===c.id?'selected':'')} onClick={()=>{setSelected(c.id);if(!readOnly)action(()=>request('/conversations/'+c.id,{read:true},'PATCH'))}} key={c.id}><span className={'g-avatar '+c.channel}>{c.name.slice(0,1)}</span><div><header><strong>{c.name}</strong><time>{stamp(c.lastAt).split(' ')[1]}</time></header><p>{c.lastContent||'暂无消息'}</p><footer><span>{channelText[c.channel]}{c.sourceKind==='comment'?' · 评论':''}</span><Badge tone={c.intent==='high'?'amber':'neutral'}>{intentText[c.intent]}</Badge>{c.unread>0&&<b>{c.unread}</b>}</footer></div></button>)}</div>
          <div className="g-pagination"><span>{total} 条会话</span><button disabled={listPage===1} onClick={()=>setListPage(p=>p-1)}>上一页</button><button disabled={listPage*50>=total} onClick={()=>setListPage(p=>p+1)}>下一页</button></div>
        </section>
        {!detail?<div className="g-chat-empty"><Empty title="选择一段对话"><>所有咨询汇聚于此。<br/>从左侧选择顾客，开始接待。</></Empty></div>:<>
          <section className="g-chat"><header className="g-chat-header"><button className="g-chat-back" aria-label="返回会话列表" onClick={()=>setSelected('')}>←</button><div className={'g-avatar '+detail.conversation.channel}>{detail.conversation.name.slice(0,1)}</div><div><strong>{detail.conversation.name}</strong><small>{channelText[detail.conversation.channel]} · {statusText[detail.conversation.status]}</small></div><div className="g-actions">
            <button className="g-customer-toggle" aria-expanded={showCustomer} onClick={()=>setShowCustomer(v=>!v)}>顾客档案</button>
            <button disabled={busy||readOnly} onClick={()=>action(()=>request('/conversations/'+selected,{status:detail.conversation.status==='human'?'ai':'human',owner:detail.conversation.status==='human'?'':state.access.memberId||'owner'},'PATCH'),'接待状态已更新')}>{detail.conversation.status==='human'?'交给 AI':'人工接管'}</button>
            <button disabled={busy||readOnly} onClick={()=>action(()=>request('/conversations/'+selected,{status:detail.conversation.status==='resolved'?'open':'resolved'},'PATCH'),'会话状态已更新')}>{detail.conversation.status==='resolved'?'重新打开':'完成会话'}</button></div></header>
            {detail.conversation.handoffReason&&<div className="g-context-note">转人工原因：{detail.conversation.handoffReason}</div>}
            {detail.conversation.sourceKind==='web'?<div className="g-context-note">网页访客会收到这里的回复。内部备注仅团队可见；自动接待受渠道开关与员工排班控制。</div>:detail.conversation.sourceKind==='platform'?<div className="g-context-note">回复将发送给真实顾客，受平台时限与条数限制。发送结果未知时请先到原平台核实，再到“渠道与团队”记录结果。非文本消息需在原平台查看；内部备注不会外发。</div>:detail.conversation.sourceKind!=='sandbox'&&<div className="g-context-note">此平台的 AI 回复需人工审核；旧版采集仅视频号有发送适配器，其他平台请到原平台处理。</div>}
            <div className="g-messages" ref={messagesRef} onScroll={e=>{const el=e.currentTarget;stickToBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<96}}>
              {detail.messages.length>=200&&<button disabled={busy} onClick={()=>action(async()=>{
                const first=detail.messages[0],id=selected
                const data=await request('/conversations/'+id+'/messages?beforeTs='+first.ts+'&beforeSeq='+first.sequence)
                if(id!==selectedRef.current)return
                setDetail(d=>d?{...d,messages:[...data.messages,...d.messages]}:d)
                if(!data.messages.length)notify('已经是最早的消息')
              })}>加载更早消息</button>}
              {detail.messages.map(m=><div key={m.id} className={'g-message '+(m.role==='customer'?'incoming':m.role==='note'?'internal':'outgoing')}>
                <small>{m.role==='customer'?detail.conversation.name:m.role==='note'?'内部备注':m.role==='workflow'?'工作流回复':m.source==='knowledge'?'知识库答复':m.role==='ai'?'AI 接待':'客服'} · {stamp(m.ts)}</small><p>{m.content}</p>
                {m.role==='ai'&&<details className="g-message-evidence"><summary>回答依据{m.model?' · '+m.model:''}</summary><p>{m.refs?.length?m.refs.map((r:any)=>`${r.title}（v${r.version||1}）${r.similarity!==undefined?' · 向量相似度 '+r.similarity.toFixed(3):''}`).join('、'):'未引用知识条目，请核对员工背景与回答内容。'}</p>{!!m.businessRefs?.length&&<p>本地业务依据：{m.businessRefs.map((r:any)=>`${r.title}（v${r.version}）`).join('、')}</p>}{m.retrieval&&<p>实际检索：{m.retrieval.mode==='hybrid'?(m.retrieval.provider==='local'?'本地向量 + 关键词':'API 向量 + 关键词'):'关键词'}{m.retrieval.warning?' · '+m.retrieval.warning:''}</p>}<small>记录回答时提供的知识版本，不代表逐句事实核验。仅团队可见。</small></details>}
                {m.role!=='customer'&&m.role!=='note'&&<small className={['failed','unknown'].includes(m.delivery)?'g-failure':''}>
                  {({failed:'发送失败',sending:'发送中',unknown:'发送结果未知，请到原平台核实',sent:'平台已接受',queued:'等待访客端接收',delivered:'访客端已接收（不代表已阅读）',local:'仅测试会话',imported:'历史消息'} as Record<string,string>)[m.delivery]}
                </small>}
              </div>)}
            </div>
            {suggestion&&<div className="g-suggestion"><div><Icon name="agent" size={18}/><strong>{suggestion.source==='model'?'AI 回复建议':suggestion.source==='knowledge'?'知识库参考':'接待提示'}</strong><button className="text" onClick={()=>setSuggestion(null)}>收起</button></div><p>{suggestion.text}</p><small>{suggestion.refs?.length?'依据：'+suggestion.refs.map((r:any)=>r.title).join('、'):'未引用业务知识'}{suggestion.handoff?' · 建议转人工':''}</small><button disabled={!!message.trim()||readOnly} onClick={()=>{setMessage(suggestion.text);setNoteMode(false)}}>{message.trim()?'请先处理现有草稿':'采用到输入框'}</button></div>}
            {!!detail.cardSuggestions?.some(s=>s.status==='pending')&&<div className="g-card-suggestions">{detail.cardSuggestions.filter(s=>s.status==='pending').map(s=><div key={s.id}><strong>卡片建议 · {s.name}</strong><p>{s.title}</p><small>{s.available?'已命中触发规则；只会添加到草稿，需人工审核后发送':s.reason}</small><div className="g-actions"><button disabled={busy||readOnly||!s.available||!!message.trim()} onClick={()=>action(async()=>{const id=selected;const d=await request('/conversations/'+id+'/cards/'+s.id+'/adopt',{});if(id===selectedRef.current){setMessage(d.text);setNoteMode(false)}},'卡片文字已采用，尚未发送')}>{message.trim()?'请先处理现有草稿':'采用卡片草稿'}</button><button disabled={busy||readOnly} onClick={()=>action(()=>request('/conversations/'+selected+'/cards/'+s.id+'/dismiss',{}),'已忽略卡片建议')}>忽略</button></div></div>)}</div>}
            <form className="g-composer" onSubmit={e=>{e.preventDefault();if(!message.trim())return;const id=selected,draft=drafts[id];action(async()=>{await request('/conversations/'+id+'/'+(draft.note?'note':'reply'),{content:draft.text,requestId:draft.requestId});setDrafts(old=>old[id]?.requestId===draft.requestId?{...old,[id]:{...draft,text:''}}:old)},noteMode?'已添加内部备注':'消息已处理')}}>
              <fieldset className="g-permission" disabled={readOnly}><div className="g-composer-tools"><button type="button" className={!noteMode?'selected':''} onClick={()=>setNoteMode(false)}>回复</button><button type="button" className={noteMode?'selected':''} onClick={()=>setNoteMode(true)}>内部备注</button><button className="g-ai-button" type="button" disabled={busy} onClick={()=>action(async()=>{const id=selected;const result=await request('/conversations/'+id+'/suggest',{});if(id===selectedRef.current)setSuggestion(result)})}><Icon name="agent" size={16}/>生成回复建议</button></div>
              {!!state.cards.filter(c=>c.enabled).length&&<select aria-label="插入营销卡片文字" disabled={!!message.trim()} value="" onChange={e=>{const card=state.cards.find(c=>c.id===e.target.value);if(card){setMessage([card.title,card.body,card.url].filter(Boolean).join('\n'));setNoteMode(false)}}}><option value="">{message.trim()?'已有草稿，请先处理后再插入卡片':'插入营销卡片文字（审核后发送）'}</option>{state.cards.filter(c=>c.enabled).map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select>}
              <textarea aria-label={noteMode?'内部备注':'回复内容'} placeholder={noteMode?'记录给团队看的上下文，不会发送给客户…':'输入回复内容…'} value={message} onChange={e=>setMessage(e.target.value)} rows={3}/>
              <footer><small>{noteMode?'仅团队可见':detail.conversation.sourceKind==='sandbox'?'测试会话不会发送给真实客户':'将通过已接入的平台发送'}</small><button className="primary" disabled={busy||!message.trim()||(!noteMode&&detail.conversation.optedOut)}>{noteMode?'保存备注':'发送回复'} <Icon name="arrow" size={16}/></button></footer></fieldset>
            </form>
            {isAdmin&&detail.conversation.sourceKind==='sandbox'&&<form className="g-test-incoming" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const content=new FormData(form).get('incoming');action(async()=>{await request('/conversations/'+selected+'/incoming',{content});form.reset()})}}><input name="incoming" aria-label="模拟顾客消息" placeholder="模拟顾客发来下一条消息" required/><button disabled={busy}>模拟进线</button></form>}
          </section>
          <aside className={'g-customer'+(showCustomer?' is-open':'')} aria-label="顾客档案"><div className="g-panel-head"><h3>顾客档案</h3><button className="g-customer-toggle" aria-label="关闭顾客档案" onClick={()=>setShowCustomer(false)}>×</button></div><div className="g-customer-avatar">{detail.conversation.name.slice(0,1)}</div><h2>{detail.conversation.name}</h2><div className="g-customer-badges"><Badge tone={detail.conversation.intent==='high'?'amber':'green'}>{intentText[detail.conversation.intent]}</Badge><Badge>{channelText[detail.conversation.channel]}</Badge></div>
            {detail.conversation.intentAssessment&&<div className="g-context-note"><strong>AI 意向依据 · 可人工修正</strong><p>{detail.conversation.intentAssessment.reason}</p><p>顾客原话：{detail.conversation.intentAssessment.evidence}</p><small>{detail.conversation.intentAssessment.model} · {stamp(detail.conversation.intentAssessment.at)}</small></div>}
            <SalesDialoguePanel conversation={detail.conversation} summary={detail.salesSummary||''} timeline={detail.salesTimeline} readOnly={readOnly} busy={busy} onReset={()=>action(()=>request('/conversations/'+selected+'/sales-reset',{expectedVersion:detail.conversation.salesState?.version||0}),'需求档案已重置，历史聊天保留')}/>
            <Field label="接待负责人"><select disabled={readOnly} value={detail.conversation.owner} onChange={e=>action(()=>request('/conversations/'+selected,{owner:e.target.value},'PATCH'),'已分配负责人')}><option value="">未分配</option>{members.map(m=><option key={m.id} value={m.id} disabled={m.active===false}>{m.name}{m.active===false?'（已停用）':''}</option>)}</select></Field>
            <Field label="接待员工"><select disabled={readOnly} value={detail.conversation.agentId} onChange={e=>action(()=>request('/conversations/'+selected,{agentId:e.target.value},'PATCH'))}>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <dl><dt>电话</dt><dd>{detail.lead?.phone||'未留资'}</dd><dt>微信</dt><dd>{detail.lead?.wechat||'未留资'}</dd><dt>跟进阶段</dt><dd>{stages[detail.lead?.stage]||'未建立线索'}</dd></dl>
            {detail.conversation.optedOut&&<Badge tone="red">顾客已要求停止联系</Badge>}
            {detail.lead&&!readOnly&&<button onClick={()=>setModal({kind:'lead',item:detail.lead!})}>编辑客户资料</button>}<button disabled={readOnly} onClick={()=>setModal({kind:'task'})}>＋ 添加跟进提醒</button>
            <h4>操作时间线</h4><div className="g-timeline">{detail.events.length?detail.events.slice(0,12).map(e=><div key={e.id}><strong>{e.action}</strong><p>{e.detail}</p><small>{stamp(e.ts)}</small></div>):<p>暂无操作记录</p>}</div>
          </aside>
        </>}
      </div>}
      {page==='leads'&&<><div className="g-toolbar"><Search value={search} onChange={setSearch} placeholder="搜索姓名、电话、微信或标签"/><select aria-label="跟进阶段" value={leadStage} onChange={e=>setLeadStage(e.target.value)}><option value="all">全部阶段</option>{Object.entries(stages).map(([id,n])=><option value={id} key={id}>{n}</option>)}</select><div className="g-segment"><button className={leadView==='table'?'selected':''} onClick={()=>setLeadView('table')}>列表</button><button className={leadView==='board'?'selected':''} onClick={()=>setLeadView('board')}>看板</button></div><span>{visibleLeads.length} 位顾客</span></div>
        {leadView==='table'?<section className="g-panel g-table-wrap"><table className="g-table"><thead><tr>{['顾客','来源','联系方式','意向','跟进阶段','负责人','操作'].map(n=><th key={n}>{n}</th>)}</tr></thead><tbody>{visibleLeads.map(l=><tr key={l.id}><td><strong>{l.name}</strong><small>{l.tags.join(' · ')||'暂无标签'}</small></td><td>{channelText[l.channel]}</td><td>{l.phone||l.wechat||'未留资'}</td><td><Badge tone={l.intent==='high'?'amber':'neutral'}>{intentText[l.intent]}</Badge></td><td><select disabled={readOnly} aria-label={l.name+'的阶段'} value={l.stage} onChange={e=>action(()=>request('/leads/'+l.id,{stage:e.target.value},'PATCH'),'阶段已更新')}>{Object.entries(stages).map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></td><td>{ownerName(l.owner)}</td><td><button className="text" onClick={()=>openConversation(l.id)}>会话</button><button disabled={readOnly} className="text" onClick={()=>setModal({kind:'lead',item:l})}>编辑</button></td></tr>)}</tbody></table>{!visibleLeads.length&&<Empty title="还没有客户线索"/>}</section>:<div className="g-board">{Object.entries(stages).map(([id,n])=><section key={id}><header><span className={'stage-dot '+id}/><strong>{n}</strong><Badge>{visibleLeads.filter(l=>l.stage===id).length}</Badge></header>{visibleLeads.filter(l=>l.stage===id).map(l=><button className="g-lead-card" onClick={()=>readOnly?openConversation(l.id):setModal({kind:'lead',item:l})} key={l.id}><strong>{l.name}</strong><Badge tone={l.intent==='high'?'amber':'neutral'}>{intentText[l.intent]}</Badge><p>{l.notes||l.phone||'等待进一步了解需求'}</p><footer>{channelText[l.channel]}<span>{ownerName(l.owner)}</span></footer></button>)}</section>)}</div>}
      </>}
      {page==='knowledge'&&<KnowledgePanel items={state.knowledge} index={state.stats.knowledgeIndex} busy={busy} request={request} action={action} onEdit={k=>setModal({kind:'knowledge',item:k})}/>}
      {page==='agent'&&agent&&<div className="g-agent-layout"><aside className="g-agent-list">{state.agents.map(a=><button className={agent.id===a.id?'selected':''} onClick={()=>{setAgentId(a.id);setPreview(null)}} key={a.id}><span className="g-agent-avatar"><Icon name="agent" size={23}/></span><div><strong>{a.name}</strong><small>{a.enabled?'已启用':'未启用'} · {a.channels.map((c:string)=>channelText[c]).join('、')||'未选渠道'}</small></div><i className={a.enabled?'online':''}/></button>)}<div className="g-help">自动接待需同时启用员工、勾选渠道并开启该账号的 AI 接待。微信客服与公众号需先完成授权和真实收发验收；旧版采集会话仍须人工审核。</div></aside>
        <section className="g-panel g-agent-config"><form key={agent.id+'-'+agent.updated} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),b:any={...Object.fromEntries(f),...salesFormData(f)};for(const k of ['enabled','welcomeEnabled','collectEnabled','handoffEnabled','followupEnabled','screeningEnabled','lookupLocalBusiness'])b[k]=f.has(k);b.channels=f.getAll('channels');b.knowledgeIds=f.getAll('knowledgeIds');b.days=f.getAll('days');for(const k of ['bannedWords','screeningKeywords','excludeKeywords'])b[k]=arrayText(b[k]||'');action(()=>request('/agent/'+agent.id,b,'PATCH'),'AI 员工配置已保存')}}>
          <div className="g-panel-head"><div><h3>培训你的 AI 员工</h3><small>配置保存后，下次接待即使用新规则。</small></div><button className="primary" disabled={busy}>保存配置</button></div>
          <div className="g-form-grid"><TextField label="员工名称" name="name" value={agent.name} required/><Field label="排班方式"><select name="schedule" defaultValue={agent.schedule}><option value="always">全天接待</option><option value="weekly">按周排班（北京时间）</option></select></Field><Toggle label="启用员工" name="enabled" checked={agent.enabled}/><div/>
            <TextField label="开始时间" name="start" type="time" value={agent.start}/><TextField label="结束时间" name="end" type="time" value={agent.end}/>
            <Field label="工作日" wide><div className="g-checks">{['日','一','二','三','四','五','六'].map((d,i)=><label key={d}><input type="checkbox" name="days" value={i} defaultChecked={agent.days.includes(String(i))}/>周{d}</label>)}</div></Field>
            <Area label="员工人设" name="role" value={agent.role} rows={3}/><Area label="品牌与业务背景" name="brand" value={agent.brand}/><Area label="接待规范与限制" name="instructions" value={agent.instructions}/><Area label="对话风格" name="style" value={agent.style} rows={3}/>
            <TextField label="回复字数上限" name="maxLength" type="number" value={agent.maxLength}/><TextField label="敏感词（逗号分隔）" name="bannedWords" value={agent.bannedWords.join('，')}/>
            <div className="g-field wide"><span>知识范围（分类 / 逐条限定）</span><KnowledgeScope items={state.knowledge} agent={agent} request={request}/></div>
            <Field label="适用渠道" wide><div className="g-checks">{Object.entries(channelText).map(([id,n])=><label key={id}><input type="checkbox" name="channels" value={id} defaultChecked={agent.channels.includes(id)}/>{n}</label>)}</div></Field>
            <h3 className="wide g-form-section">接待技能</h3><Toggle label="新客欢迎语" name="welcomeEnabled" checked={agent.welcomeEnabled}/><Toggle label="信息提取（手机号、微信、意向）" name="collectEnabled" checked={agent.collectEnabled}/><Area label="欢迎语" name="welcome" value={agent.welcome} rows={2}/><Toggle label="主动要求人工 / 争议转人工" name="handoffEnabled" checked={agent.handoffEnabled}/><Toggle label="沉默客户跟进提醒（不自动外发）" name="followupEnabled" checked={agent.followupEnabled}/><TextField label="沉默提醒间隔（分钟）" name="followupMinutes" type="number" value={agent.followupMinutes}/>
            <Area label="高意向未留资引导（每个会话最多提示一次）" name="collectPrompt" value={agent.collectPrompt} rows={2}/>
            <SalesPlaybookFields agent={agent}/>
            <Toggle label="只读查询本地商品、库存和预约时段（不自动操作）" name="lookupLocalBusiness" checked={!!agent.lookupLocalBusiness}/>
            <Toggle label="启用关键词筛选（不匹配则人工判断）" name="screeningEnabled" checked={agent.screeningEnabled}/><Field label="筛选匹配方式"><select name="screeningMode" defaultValue={agent.screeningMode||'any'}><option value="any">任一关键词</option><option value="all">全部关键词</option></select></Field><TextField label="目标需求关键词（逗号分隔）" name="screeningKeywords" value={(agent.screeningKeywords||[]).join('，')}/><TextField label="排除关键词（逗号分隔）" name="excludeKeywords" value={(agent.excludeKeywords||[]).join('，')}/>
          </div>
        </form></section>
        <aside className="g-panel g-agent-preview"><Badge tone="green">独立预览</Badge><h3>像顾客一样聊一聊</h3><p>使用已保存的配置，不创建客户或发送平台消息。</p><div className="g-preview-art"><Icon name="agent" size={48}/></div><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);action(async()=>setPreview(await request('/preview',{agentId:agent.id,message:f.get('message')})))}}><textarea aria-label="预览顾客问题" name="message" rows={4} placeholder="输入顾客可能问的问题…" required/><button className="primary" disabled={busy}>测试回答</button></form>{preview&&<div className="g-preview-result"><Badge>{preview.source==='model'?'大模型':preview.source==='knowledge'?'知识直接匹配':'规则兜底'}</Badge><p>{preview.text}</p><small>{preview.handoff?'转人工：'+preview.reason:'回答完成'}<br/>知识依据：{preview.refs?.map((r:any)=>r.title).join('、')||'无'}<br/>本地业务依据：{preview.businessRefs?.map((r:any)=>r.title+'（v'+r.version+'）').join('、')||'无'}</small></div>}</aside>
      </div>}
      {page==='rules'&&<>
        <div className="g-note-banner"><Icon name="rules"/><span>当条件满足，执行分配、打标或创建跟进待办。沉默提醒每条消息最多触发一次，停止联系和已完成会话不再触发。</span><button disabled={busy} onClick={()=>action(async()=>{const result=await request('/tick',{});setRuns((await request('/runs')).list);notify('本次触发 '+result.created+' 条规则')})}>立即检查</button></div>
        <div className="g-rule-grid">{state.rules.map(r=><section className="g-panel g-rule-card" key={r.id}><header><span className="g-square-icon"><Icon name="rules"/></span><Badge tone={r.enabled?'green':'neutral'}>{r.enabled?'运行中':'未启用'}</Badge></header><h3>{r.name}</h3><div className="g-flow-step"><small>当</small><strong>{({incoming:'收到新消息',high_intent:'发现高意向',silent:'客户沉默'} as any)[r.trigger]}</strong><span>{r.channel==='all'?'全部渠道':channelText[r.channel]}</span></div><div className="g-flow-line">↓</div><div className="g-flow-step"><small>执行</small><strong>{({tag:'添加标签',assign:'分配负责人',handoff:'转人工',followup:'创建跟进'} as any)[r.action]}</strong><span>{r.value}</span></div><footer><button onClick={()=>setModal({kind:'rule',item:r})}>编辑规则</button><button disabled={busy} onClick={()=>action(()=>request('/rule/'+r.id,{enabled:!r.enabled},'PATCH'),'规则已更新')}>{r.enabled?'暂停':'启用'}</button></footer></section>)}</div>
        {!state.rules.length&&<section className="g-panel"><Empty title="把接待经验写成规则">例如：包含“预约”的高意向咨询，分配给负责人并创建跟进提醒。</Empty></section>}
        <section className="g-panel"><div className="g-panel-head"><h3>待办与提醒</h3></div><Tasks tasks={state.tasks} busy={busy||readOnly} onDone={t=>action(()=>request('/tasks/'+t.id,{status:'done'},'PATCH'),'已完成')} onOpen={openConversation}/></section>
        <section className="g-panel"><div className="g-panel-head"><h3>规则执行日志</h3></div>{runs.length?<table className="g-table"><thead><tr><th>规则</th><th>时间</th><th>结果</th><th>会话</th></tr></thead><tbody>{runs.map(r=><tr key={r.runKey}><td>{state.rules.find(x=>x.id===r.ruleId)?.name||r.ruleId}</td><td>{stamp(r.ts)}</td><td><Badge tone="green">成功</Badge></td><td><button className="text" onClick={()=>openConversation(r.conversationId)}>查看</button></td></tr>)}</tbody></table>:<p className="g-muted-pad">还没有执行记录，规则真正命中后才会出现在这里。</p>}</section>
      </>}
      {page==='reports'&&<ReportsPanel members={state.members as {id:string;name:string}[]} channels={state.channels} readOnly={!!readOnly}/>}
      {page==='cards'&&<><div className="g-note-banner"><Icon name="cards"/><span>规则命中后在会话中生成待审核文字草稿，24 小时有效；支持渠道、关键词、排除词和频控。不会自动外发。平台原生卡片需要独立授权接口，目前未接入。</span></div><div className="g-card-grid">{state.cards.map(c=><section className="g-marketing-card" key={c.id}><div className="g-card-cover"><Icon name="cards" size={40}/><span>{c.enabled?'业务信息卡':'已停用'}</span></div><div><h3>{c.title}</h3><p>{c.body}</p>{c.url?<a href={c.url} target="_blank" rel="noreferrer">{c.button} ↗</a>:<span>{c.button}</span>}<p className="g-hint">{({manual:'仅手动插入',incoming:'新消息触发',high_intent:'高意向触发'} as Record<string,string>)[c.trigger||'manual']}{c.trigger&&c.trigger!=='manual'?` · ${c.channel==='all'?'全部渠道':channelText[c.channel]} · 每位顾客 ${c.cooldownMinutes} 分钟间隔 / 24 小时最多 ${c.dailyLimit} 次`:''}</p></div><footer><span>{c.name}</span><button onClick={()=>setModal({kind:'card',item:c})}>编辑</button><button disabled={busy} onClick={()=>action(()=>request('/card/'+c.id,{enabled:!c.enabled},'PATCH'),'卡片状态已更新')}>{c.enabled?'停用':'启用'}</button></footer></section>)}</div>{!state.cards.length&&<Empty title="还没有营销卡片">准备预约指引、产品介绍或品牌信息卡。</Empty>}</>}
      {page==='settings'&&<>{isAdmin&&<><PlatformChannelsPanel agents={state.agents as {id:string;name:string}[]}/><WebChannelPanel agents={state.agents as {id:string;name:string}[]}/></>}<TeamPanel onRefresh={loadState}/>{isAdmin&&<>
        {legacyAllowed&&<details className="g-panel g-legacy-panel"><summary className="g-panel-head">旧版创作者账号与分组（采集）</summary><p className="g-context-note">这里的登录用于旧版内容与评论采集，不等于获得官方私信接待权限。配置微信客服与公众号，请使用上方“平台接入中心”。</p><AccountsTab groups={groups} accounts={accounts} onChanged={()=>{loadAccounts().catch(e=>setError(e.message))}} lastCollect={null} onRecollect={()=>action(async()=>{const r=await api('/api/collect',{method:'POST'});if(!r.ok)throw new Error('同步启动失败')},'已启动平台采集')}/></details>}
        <section className="g-panel"><div className="g-panel-head"><div><h3>负责人目录</h3><small>登录成员会自动同步到名录；单独新增的负责人没有登录权限。</small></div><button onClick={()=>setModal({kind:'member'})}>＋ 新增负责人</button></div><div className="g-members">{members.map(m=><div key={m.id}><span className="g-user">{m.name.slice(0,1)}</span><strong>{m.name}</strong><Badge>{m.active?'接待负责人':'已停用'}</Badge></div>)}</div></section>
        </>}
        <div className="g-help">大模型：{state.stats.modelConfigured?state.stats.model:'未配置，当前使用本地知识匹配与规则兜底'}。接待模块使用「模型设置」中保存的 API 或本机 Hermes → Codex 连接，不自动回退到 Kimi。登录凭据不返回页面。</div>
      </>}
      {page==='library'&&legacyAllowed&&<div className="g-legacy-panel"><LibraryTab/></div>}
      {page==='notes'&&legacyAllowed&&<div className="g-legacy-panel g-notes"><NoteTab/></div>}
      {page==='publish'&&legacyAllowed&&<div className="g-legacy-panel"><PublishTab accounts={accounts} groups={groups}/></div>}
      </div></>}
    </main>
    {toast&&<div className="g-toast" role="status"><Icon name="check" size={18}/>{toast}</div>}
    {busy&&<div className="g-progress" role="status" aria-label="正在处理"/>}
    {modal&&<Modal title={modal.kind==='sandbox'?'测试接待':modal.kind==='task'?'添加跟进':(modal.item?'编辑':'新增')+({knowledge:'业务知识',lead:'顾客资料',rule:'自动化规则',member:'负责人',card:'营销卡片'} as any)[modal.kind]} onClose={closeModal}><form className="g-modal-body" onSubmit={saveResource}>
      {modal.kind==='sandbox'&&<><p className="g-help">只创建本地测试会话，不向外部平台发送消息。</p><TextField label="访客名称" name="name" value="测试访客" required/><Field label="接待方式"><select name="agentId"><option value="">人工测试</option>{state?.agents.map(a=><option value={a.id} key={a.id}>{a.name}（{a.enabled?'已启用':'未启用，先保存启用配置'}）</option>)}</select></Field><Area label="顾客第一条消息" name="content" value="你好，请问周末可以预约吗？" rows={3}/></>}
      {modal.kind==='knowledge'&&<><TextField label="知识标题" name="title" value={modal.item?.title} required/><TextField label="分类" name="category" value={modal.item?.category||'常见问题'}/><Area label="业务知识正文" name="body" value={modal.item?.body} rows={9}/><Toggle label="启用这条知识" name="enabled" checked={modal.item?.enabled??true}/></>}
      {modal.kind==='member'&&<TextField label="负责人姓名" name="name" required/>}
      {modal.kind==='task'&&<><TextField label="跟进内容" name="title" required/><TextField label="提醒时间" name="dueAt" type="datetime-local" required/><Field label="负责人"><select name="owner"><option value="">沿用会话负责人</option>{members.map(m=><option value={m.id} key={m.id} disabled={m.active===false}>{m.name}{m.active===false?'（已停用）':''}</option>)}</select></Field></>}
      {modal.kind==='lead'&&<><div className="g-form-grid"><TextField label="姓名" name="name" value={modal.item?.name} required/><Field label="跟进阶段"><select name="stage" defaultValue={modal.item?.stage}>{Object.entries(stages).map(([id,n])=><option value={id} key={id}>{n}</option>)}</select></Field><TextField label="电话" name="phone" value={modal.item?.phone}/><TextField label="微信" name="wechat" value={modal.item?.wechat}/><Field label="意向等级"><select name="intent" defaultValue={modal.item?.intent}>{Object.entries(intentText).map(([id,n])=><option value={id} key={id}>{n}</option>)}</select></Field><Field label="负责人"><select name="owner" defaultValue={modal.item?.owner}><option value="">未分配</option>{members.map(m=><option value={m.id} key={m.id} disabled={m.active===false}>{m.name}{m.active===false?'（已停用）':''}</option>)}</select></Field><TextField label="标签（逗号分隔）" name="tags" value={modal.item?.tags.join('，')}/><Area label="跟进备注" name="notes" value={modal.item?.notes}/></div></>}
      {modal.kind==='rule'&&<><TextField label="规则名称" name="name" value={modal.item?.name} required/><div className="g-form-grid"><Field label="触发事件"><select name="trigger" defaultValue={modal.item?.trigger||'incoming'}><option value="incoming">收到新消息</option><option value="high_intent">识别高意向</option><option value="silent">客户沉默</option></select></Field><Field label="渠道条件"><select name="channel" defaultValue={modal.item?.channel||'all'}><option value="all">全部渠道</option>{Object.entries(channelText).map(([id,n])=><option value={id} key={id}>{n}</option>)}</select></Field><TextField label="消息包含（留空不限）" name="keyword" value={modal.item?.keyword}/><TextField label="等待 / 提醒间隔（分钟）" name="minutes" type="number" value={modal.item?.minutes||30}/><Field label="执行动作"><select name="action" defaultValue={modal.item?.action||'followup'}><option value="followup">创建跟进待办</option><option value="tag">添加标签</option><option value="assign">分配负责人</option><option value="handoff">转人工</option></select></Field><Field label="负责人"><select name="owner" defaultValue={modal.item?.owner||'owner'}>{members.map(m=><option value={m.id} key={m.id} disabled={m.active===false}>{m.name}{m.active===false?'（已停用）':''}</option>)}</select></Field></div><TextField label="动作内容 / 标签 / 转接原因" name="value" value={modal.item?.value} required/><Toggle label="启用规则" name="enabled" checked={modal.item?.enabled??true}/></>}
      {modal.kind==='card'&&<><TextField label="卡片名称" name="name" value={modal.item?.name} required/><TextField label="卡片标题" name="title" value={modal.item?.title} required/><Area label="介绍" name="body" value={modal.item?.body}/><TextField label="跳转链接（可选）" name="url" value={modal.item?.url} type="url"/><TextField label="按钮文字" name="button" value={modal.item?.button||'了解详情'}/><Toggle label="启用" name="enabled" checked={modal.item?.enabled??true}/><h3>建议触发规则</h3><p className="g-hint">只生成待审核草稿。已完成、退订、停用或过期的建议不能采用；同一条消息不重复触发。</p><div className="g-form-grid"><Field label="触发条件"><select name="trigger" defaultValue={modal.item?.trigger||'manual'}><option value="manual">仅手动插入</option><option value="incoming">收到新消息</option><option value="high_intent">识别高意向</option></select></Field><Field label="适用渠道"><select name="channel" defaultValue={modal.item?.channel||'all'}><option value="all">全部渠道</option>{Object.entries(channelText).map(([id,n])=><option key={id} value={id}>{n}</option>)}</select></Field><Field label="关键词匹配"><select name="matchMode" defaultValue={modal.item?.matchMode||'any'}><option value="any">匹配任一</option><option value="all">全部匹配</option></select></Field><TextField label="关键词（逗号分隔，空为不限）" name="keywords" value={(modal.item?.keywords||[]).join('，')}/><TextField label="排除词（逗号分隔）" name="excludeKeywords" value={(modal.item?.excludeKeywords||[]).join('，')}/><TextField label="每位顾客最短间隔（分钟）" name="cooldownMinutes" type="number" value={modal.item?.cooldownMinutes||1440}/><TextField label="每位顾客 24 小时最多触发次数" name="dailyLimit" type="number" value={modal.item?.dailyLimit||3}/></div></>}
      <footer className="g-modal-actions"><button type="button" onClick={closeModal}>取消</button><button className="primary" disabled={busy}>{modal.kind==='sandbox'?'创建测试会话':'保存'}</button></footer>
    </form></Modal>}
  </div>
}
function Trend({data}:{data:any[]}){
  const max=Math.max(1,...data.map(d=>d.count))
  return <div className="g-trend">{data.map(d=><div key={d.date}><span>{d.count}</span><div><i style={{height:(d.count?Math.max(5,d.count/max*100):2)+'%'}}/></div><small>{d.date.slice(5)}</small></div>)}</div>
}
function Tasks({tasks,busy,onDone,onOpen}:{tasks:RecordData[];busy:boolean;onDone:(t:RecordData)=>void;onOpen:(id:string)=>void}){
  const pending=tasks.filter(t=>t.status==='pending').sort((a,b)=>a.dueAt-b.dueAt)
  return pending.length?<div className="g-tasks">{pending.map(t=><div key={t.id}><button className="g-task-check" aria-label={'完成 '+t.title} disabled={busy} onClick={()=>onDone(t)}><Icon name="check" size={14}/></button><div><strong>{t.title}</strong><small>{t.name} · {stamp(t.dueAt)}</small></div>{t.dueAt<Date.now()/1000&&<Badge tone="amber">已到期</Badge>}<button className="text" onClick={()=>onOpen(t.conversationId)}>查看会话 →</button></div>)}</div>:<div className="g-muted-pad">没有待办跟进，新的提醒会自动显示在这里。</div>
}

