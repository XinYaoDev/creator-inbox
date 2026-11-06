export type FlowNode={id:string;type:string;value:string;next:string;otherwise:string;field:string;operator:string;minutes:number;position?:{x:number;y:number}}
export type Workflow={id?:string;version?:number;name:string;enabled:boolean;trigger:string;channel:string;cancelOnReply:boolean;nodes:FlowNode[]}
export const nodeTypes:Record<string,string>={condition:'条件分支',tag:'添加标签',assign:'分配负责人',task:'创建跟进',note:'内部备注',reply:'发送回复',wait:'等待',handoff:'转人工',end:'结束'}
export const makeNode=(type='tag'):FlowNode=>({id:crypto.randomUUID(),type,value:'',next:'',otherwise:'',field:'text',operator:'contains',minutes:5})
export function graphIssues(nodes:FlowNode[]){
  const issues:string[]=[],ids=new Set(nodes.map(n=>n.id)),seen=new Set<string>(),visiting=new Set<string>()
  const visit=(id:string)=>{if(!id)return;if(visiting.has(id)){issues.push('存在循环连线');return}if(seen.has(id))return;const n=nodes.find(n=>n.id===id);if(!n){issues.push('连线目标不存在');return}visiting.add(id);if(!['end','handoff'].includes(n.type)){visit(n.next);if(n.type==='condition')visit(n.otherwise)}visiting.delete(id);seen.add(id)}
  if(!nodes.length)issues.push('至少添加一个节点');else visit(nodes[0].id)
  if([...ids].some(id=>!seen.has(id)))issues.push('有节点未连接到入口')
  nodes.forEach((n,i)=>{if(['tag','assign','task','note','reply','handoff'].includes(n.type)&&!n.value.trim())issues.push(`节点 ${i+1} 缺少动作内容`);if(n.type==='condition'&&n.operator!=='exists'&&!n.value.trim())issues.push(`节点 ${i+1} 缺少比较值`)})
  return [...new Set(issues)]
}
export function canConnect(nodes:FlowNode[],source:string,target:string,port:string){
  const from=nodes.find(n=>n.id===source)
  if(!from||!nodes.some(n=>n.id===target)||source===target||['end','handoff'].includes(from.type)||(port==='otherwise'&&from.type!=='condition'))return false
  const proposed=nodes.map(n=>n.id===source?{...n,[port]:target}:n),seen=new Set<string>()
  const reaches=(id:string):boolean=>{if(id===source)return true;if(!id||seen.has(id))return false;seen.add(id);const n=proposed.find(n=>n.id===id);return !!n&&(reaches(n.next)||(n.type==='condition'&&reaches(n.otherwise)))}
  return !reaches(target)
}
export function autoLayout(nodes:FlowNode[]){
  const levels=new Map<string,number>(),visiting=new Set<string>()
  const visit=(id:string,depth:number)=>{if(!id||visiting.has(id)||depth>30)return;if((levels.get(id)??-1)>=depth)return;levels.set(id,depth);visiting.add(id);const n=nodes.find(n=>n.id===id);if(n&&!['end','handoff'].includes(n.type)){visit(n.next,depth+1);if(n.type==='condition')visit(n.otherwise,depth+1)}visiting.delete(id)}
  if(nodes.length)visit(nodes[0].id,0)
  const rows=new Map<number,number>()
  return nodes.map(n=>{const row=levels.get(n.id)??0,col=rows.get(row)||0;rows.set(row,col+1);return {...n,position:{x:50+col*290,y:50+row*200}}})
}
export function starter(template='lead'):Workflow{
  let nodes:FlowNode[]=[]
  if(template==='web'){
    const a=makeNode('condition'),b=makeNode('reply'),c=makeNode('wait'),d=makeNode('reply'),e=makeNode('handoff');a.value='预约';a.next=b.id;a.otherwise=e.id;b.value='已收到预约咨询，请告诉我方便的时间。';b.next=c.id;c.minutes=1;c.next=d.id;d.value='也可以自愿留下联系方式，方便同事继续确认。';e.value='非预约问题交给人工确认';nodes=[a,b,c,d,e]
  }else if(template==='blank')nodes=[makeNode('end')]
  else{const a=makeNode('condition'),b=makeNode('tag'),c=makeNode('task');a.value='预约';a.next=b.id;b.value='预约咨询';b.next=c.id;c.value='人工确认预约需求';nodes=[a,b,c]}
  return {name:template==='web'?'网页预约与延时跟进':template==='blank'?'新的智能任务':'预约线索跟进',enabled:false,trigger:'incoming',channel:template==='web'?'web':'all',cancelOnReply:true,nodes:autoLayout(nodes)}
}
