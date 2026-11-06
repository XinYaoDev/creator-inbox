import {useEffect,useState} from 'react'
export default function KnowledgeScope({items,agent,request}:{items:any[];agent:any;request:(path:string)=>Promise<any>}){
  const [query,setQuery]=useState(''),[ids,setIds]=useState<string[]>(agent.knowledgeIds||[]),[categories,setCategories]=useState<string[]>(agent.knowledgeCategories||[])
  const [listing,setListing]=useState<any>({list:items.slice(0,50),total:items.length,categories:[...new Set(items.map(k=>k.category))]}),[error,setError]=useState('')
  useEffect(()=>{let active=true;const timer=setTimeout(()=>{request('/knowledge/list?'+new URLSearchParams({q:query,limit:'50'})).then(r=>{if(active){setListing(r);setError('')}}).catch(e=>{if(active)setError(e.message)})},180);return()=>{active=false;clearTimeout(timer)}},[query,request])
  const visible=listing.list
  return <div className="g-knowledge-scope">
    {ids.map(id=><input key={id} type="hidden" name="knowledgeIds" value={id}/>)}{categories.map(c=><input key={c} type="hidden" name="knowledgeCategories" value={c}/>)}
    <p className="g-hint">不选使用全部启用知识。分类与条目同时选择时取交集；按分类限定会自动包含该分类今后启用的新知识。</p>
    <div className="g-checks">{listing.categories.map((c:string)=><label key={c}><input type="checkbox" checked={categories.includes(c)} onChange={e=>setCategories(e.target.checked?[...categories,c]:categories.filter(x=>x!==c))}/>{c}</label>)}</div>
    <input aria-label="搜索员工知识范围" placeholder="搜索标题或分类，最多显示 50 条" value={query} onChange={e=>setQuery(e.target.value)}/>
    <p className="g-hint">已选 {categories.length} 个分类、{ids.length} 条知识 · 匹配 {listing.total} 条（搜索覆盖完整知识库）</p><button type="button" onClick={()=>{setIds([]);setCategories([])}}>清除范围限制</button>
    {error&&<p role="alert">{error}</p>}<div className="g-checks">{visible.map((k:any)=><label key={k.id}><input type="checkbox" checked={ids.includes(k.id)} disabled={!ids.includes(k.id)&&ids.length>=500} onChange={e=>setIds(e.target.checked?[...ids,k.id]:ids.filter(id=>id!==k.id))}/>{k.title}{!k.enabled?'（停用）':''}</label>)}</div>
    {!listing.total&&<p>没有匹配的知识，请修改搜索或添加资料。</p>}
  </div>
}
