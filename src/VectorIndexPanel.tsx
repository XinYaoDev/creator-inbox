import {useEffect,useState} from 'react'
type Props={index:any;busy:boolean;request:(p:string,b?:unknown,m?:string)=>Promise<any>;action:(fn:()=>Promise<unknown>,success?:string)=>Promise<void>}
const labels:Record<string,string>={running:'后台处理中',pausing:'正在暂停',paused:'已暂停',interrupted:'服务中断，可继续',failed:'处理失败，可重试',completed:'已完成'}
export default function VectorIndexPanel({index,busy,request,action}:Props){
  const [progress,setProgress]=useState<any>(null),[error,setError]=useState('')
  useEffect(()=>{setProgress(index)},[index])
  const data=progress||index,job=data?.job,running=['running','pausing'].includes(job?.status)
  const refreshing=running||!!data?.preparing;
  useEffect(()=>{if(!refreshing)return;let active=true;const timer=setInterval(()=>{request('/knowledge/index').then(d=>{if(active){setProgress(d);setError('')}}).catch(()=>{if(active)setError('进度读取失败；任务可能仍在后台运行，请稍后刷新。')})},1500);return()=>{active=false;clearInterval(timer)}},[refreshing,request])
  const control=(operation:string)=>action(async()=>setProgress(await request('/knowledge/index-jobs',{action:operation})))
  return <div className="g-context-note g-vector-status"><strong>{data?.enabled?`${data.provider==='local'?'本地中文向量':'API 向量'}：${data.ready}/${data.total} 个片段就绪`:'当前使用关键词检索'}</strong><p>{data?.enabled?data.model:'可在模型设置启用无需密钥的本地中文向量检索。'}</p>
    {data?.strategy==='disk-exact'&&<p>大规模模式：正文与索引按批从磁盘读取。倒排召回 + 分批精确向量扫描，不是近似 ANN。{data.preparing>0?`正在整理 ${data.preparing.toLocaleString()} 条知识；完成前检索结果可能不完整。`:'检索目录已就绪。'}{data.preparationError&&`整理异常：${data.preparationError}`}</p>}
    {data?.enabled&&<><p>{data.provider==='local'?'仅在本机计算。首次下载模型需要网络，缓存后可离线检索。':'建立索引会向所配置的 API 发送启用的知识片段，可能产生费用。'} 后台每批处理 32 个片段，离开页面会继续；服务重启后可手动续建，不重复计算已完成的内容。</p><progress aria-label="知识索引进度" value={data.ready} max={Math.max(1,data.total)}/><div className="g-actions">{!running&&<button disabled={busy||!data.pending} onClick={()=>control(job&&job.status!=='completed'?'resume':'start')}>{job&&job.status!=='completed'?'继续建立索引':`建立待处理索引（${data.pending}）`}</button>}{running&&<button disabled={busy||job.status==='pausing'} onClick={()=>control('pause')}>本批完成后暂停</button>}</div></>}
    {job&&<p role="status">{labels[job.status]||job.status} · 上次任务 {job.indexed} 个片段 / {job.batches} 批<br/>{job.status==='completed'&&data.pending?'知识或检索配置已更新，仍有待处理内容，请建立待处理索引。':job.message}</p>}
    {running&&<p>{data.local?.message||'正在生成向量…'}</p>}{error&&<p role="alert">{error}</p>}
  </div>
}
