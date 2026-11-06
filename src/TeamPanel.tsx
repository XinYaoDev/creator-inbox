import {useEffect, useState, type FormEvent} from 'react'
import {api, setToken, setWorkspace} from './api'

type Identity = {id?:string;name:string;role:string;secured:boolean;session?:boolean;platformAdmin?:boolean;workspaceId:string;workspaceName:string}
type User = {id:string;username:string;name:string;role:string;active:boolean}
type TeamState = {identity:Identity;configured:boolean;users:User[];workspaces:{id:string;name:string}[];audit:{id:number;actor:string;action:string;detail:string;ts:number}[]}
const roleNames:Record<string,string> = {admin:'管理员',operator:'接待员',viewer:'只读成员'}
async function teamRequest(path:string, body?:unknown, method=body===undefined?'GET':'POST') {
  const r=await api('/api/team'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
  const data=await r.json()
  if(!r.ok)throw new Error(data.error||'团队操作失败')
  return data
}
function restartIdentity(workspace='default') {
  setWorkspace(workspace)
  location.hash='overview'
  location.reload()
}
export async function logout() {
  await teamRequest('/logout',{})
  setToken('');setWorkspace('default');location.reload()
}

export function LoginPanel() {
  const [mode,setMode]=useState('password'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const form=new FormData(e.currentTarget);setBusy(true);setError('')
    try {
      setWorkspace('default')
      if(mode==='token') {
        setToken(String(form.get('token')||''))
        const data=await teamRequest('/state');restartIdentity(data.identity.workspaceId)
      } else {
        setToken('')
        const data=await teamRequest('/login',Object.fromEntries(form));restartIdentity(data.user.workspaceId)
      }
    } catch(e) {setError((e as Error).message);setBusy(false)}
  }
  return <div className="g-login"><section className="g-panel"><span className="g-logo">来</span><h1>登录来客 AI</h1><p>连接你的团队，继续每一次有价值的对话。</p><div className="g-segment"><button className={mode==='password'?'active':''} onClick={()=>setMode('password')}>成员账户</button><button className={mode==='token'?'active':''} onClick={()=>setMode('token')}>服务器令牌</button></div><form onSubmit={submit} key={mode}>
    {mode==='password'?<><label className="g-field"><span>登录名</span><input name="username" autoComplete="username" required maxLength={80}/></label><label className="g-field"><span>密码</span><input type="password" name="password" autoComplete="current-password" required maxLength={128}/></label></>:<label className="g-field"><span>管理员 / 团队访问令牌</span><input name="token" type="password" required autoComplete="off"/></label>}
    {error&&<p className="g-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'正在验证…':'登录工作台'}</button><p className="g-hint">成员账户由团队管理员创建。登录后仅能访问分配的工作空间。</p></form></section></div>
}

export default function TeamPanel({onRefresh}:{onRefresh:()=>Promise<unknown>}) {
  const [state,setState]=useState<TeamState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[success,setSuccess]=useState('')
  const [editing,setEditing]=useState<User|null>(null)
  const load=async()=>setState(await teamRequest('/state'))
  useEffect(()=>{load().catch(e=>setError(e.message))},[])
  async function perform(fn:()=>Promise<unknown>,message:string) {
    setBusy(true);setError('');setSuccess('')
    try {await fn();await load();await onRefresh();setSuccess(message)}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  const identity=state?.identity
  function createMember(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();const form=e.currentTarget,b=Object.fromEntries(new FormData(form))
    void perform(async()=>{
      await teamRequest('/users',b)
      if(!state?.configured&&!identity?.secured) {
        const data=await teamRequest('/login',{username:b.username,password:b.password});restartIdentity(data.user.workspaceId)
      }
      form.reset()
    },'成员已创建。请通过安全方式向本人交付登录名和初始密码。')
  }
  return <section className="g-panel g-team"><div className="g-panel-head"><h3>团队与账户</h3><span>{identity?.name} · {roleNames[identity?.role||'']}</span></div>
    {error&&<p className="g-error" role="alert">{error}</p>}{success&&<p className="g-context-note" role="status">{success}</p>}
    {state&&<div className="g-team-body">
      <div className="g-team-identity"><div><strong>{identity!.workspaceName}</strong><p>{identity!.secured?'已启用身份验证':'本机开放模式 · 建议创建管理员账户'}</p></div><button disabled={busy} onClick={()=>perform(logout,'')}>退出 / 切换身份</button></div>
      {identity!.platformAdmin&&<div className="g-form-grid"><label className="g-field"><span>切换工作空间</span><select value={identity!.workspaceId} onChange={e=>restartIdentity(e.target.value)}>{state.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><form className="g-inline-form" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const name=String(new FormData(form).get('name'));void perform(async()=>{await teamRequest('/workspaces',{name});form.reset()},'工作空间已创建，可切换后添加管理员')}}><label className="g-field"><span>新建隔离空间</span><input name="name" required maxLength={80} placeholder="例如：上海门店"/></label><button disabled={busy||!identity!.secured} title={!identity!.secured?'请先设置 AUTH_TOKEN 服务器管理员令牌':''}>创建</button></form></div>}
      {identity!.role==='admin'&&<>
        <form className="g-inline-form" onSubmit={e=>{e.preventDefault();void perform(()=>teamRequest('/workspace',Object.fromEntries(new FormData(e.currentTarget)),'PATCH'),'工作空间名称已更新')}}><label className="g-field"><span>空间名称</span><input key={identity!.workspaceName} name="name" defaultValue={identity!.workspaceName} maxLength={80} required/></label><button disabled={busy}>保存名称</button></form>
        {!state.configured&&<p className="g-context-note">首次创建管理员账户后，将关闭匿名访问。本机创建成功后会自动登录。请妥善保存密码。</p>}
        <h4>登录账户</h4><p className="g-hint">管理员：配置系统与管理团队；接待员：回复、备注与管理顾客；只读成员：查看接待与报表，不可修改或导出。修改账户会立即注销该成员的旧登录。</p>
        <div className="g-table-wrap"><table className="g-table"><thead><tr><th>成员 / 登录名</th><th>权限</th><th>状态</th><th>管理</th></tr></thead><tbody>{state.users.map(u=><tr key={u.id}><td><strong>{u.name}</strong><small>{u.username}</small></td><td>{roleNames[u.role]}</td><td>{u.active?'已启用':'已停用'}</td><td><button onClick={()=>setEditing(u)}>编辑账户</button></td></tr>)}</tbody></table>{!state.users.length&&<p className="g-muted-pad">尚无个人账户。负责人名录不等于登录账户。</p>}</div>
        {editing&&<form key={editing.id} className="g-team-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),b:any=Object.fromEntries(f);b.active=f.has('active');if(!b.password)delete b.password;void perform(async()=>{await teamRequest('/users/'+editing.id,b,'PATCH');setEditing(null)},'账户已更新，旧登录已失效')}}><h4>编辑 {editing.username}</h4><div className="g-form-grid"><label className="g-field"><span>姓名</span><input name="name" defaultValue={editing.name} required maxLength={80}/></label><RoleSelect value={editing.role}/><label className="g-field"><span>重置密码（留空不变）</span><input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password"/></label><label className="g-toggle"><span>启用账户</span><input name="active" type="checkbox" defaultChecked={editing.active}/></label></div><div className="g-actions"><button type="button" onClick={()=>setEditing(null)}>取消</button><button className="primary" disabled={busy}>保存账户</button></div></form>}
        <form className="g-team-form" onSubmit={createMember}><h4>添加成员</h4><div className="g-form-grid"><label className="g-field"><span>姓名</span><input name="name" required maxLength={80}/></label><label className="g-field"><span>登录名（全服务唯一）</span><input name="username" required minLength={3} maxLength={80} pattern="[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}" autoComplete="off"/></label><RoleSelect value={state.users.some(u=>u.active&&u.role==='admin')?'operator':'admin'}/><label className="g-field"><span>初始密码（至少 12 个字符）</span><input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password"/></label></div><button className="primary" disabled={busy}>创建登录账户</button></form>
      </>}
      {identity!.session&&<form className="g-team-form" onSubmit={e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.currentTarget));void perform(async()=>{await teamRequest('/password',b);setToken('');restartIdentity()},'')}}><h4>修改我的密码</h4><div className="g-form-grid"><label className="g-field"><span>原密码</span><input type="password" name="currentPassword" required autoComplete="current-password"/></label><label className="g-field"><span>新密码</span><input type="password" name="password" minLength={12} maxLength={128} required autoComplete="new-password"/></label></div><button disabled={busy}>更新密码并重新登录</button></form>}
      {identity!.role==='admin'&&<details><summary>账户操作审计（最近 100 条）</summary><div className="g-table-wrap"><table className="g-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>详情</th></tr></thead><tbody>{state.audit.map(a=><tr key={a.id}><td>{new Date(a.ts*1000).toLocaleString('zh-CN')}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.detail}</td></tr>)}</tbody></table></div></details>}
    </div>}
  </section>
}
function RoleSelect({value}:{value:string}) {return <label className="g-field"><span>权限角色</span><select name="role" defaultValue={value}>{Object.entries(roleNames).map(([r,n])=><option key={r} value={r}>{n}</option>)}</select></label>}
