import {useEffect,useMemo,useState} from 'react'
import {ReactFlow,Background as FlowBackground,Controls,MiniMap,Handle,Position,MarkerType,applyNodeChanges,useNodesInitialized,useReactFlow,type Node,type NodeProps,type Connection,type ReactFlowInstance} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {autoLayout,canConnect,nodeTypes,type FlowNode} from './workflowGraph'
type CardData={step:FlowNode;number:number;entry:boolean;state:string;[key:string]:unknown}
function FlowCard({data,selected}:NodeProps<Node<CardData>>){
  const n=data.step
  return <div className={'g-flow-card '+n.type+(selected?' selected':'')+' '+data.state}>
    <Handle type="target" position={Position.Top} id="input" aria-label={'连接到节点 '+data.number}/>
    <header><span>{String(data.number).padStart(2,'0')}</span><strong>{nodeTypes[n.type]}</strong>{data.entry&&<small>入口</small>}</header>
    <p>{n.type==='wait'?`等待 ${n.minutes} 分钟`:n.type==='end'?'完成此条执行路径':n.value||'点击填写内容'}</p>
    {data.state&&<div className="g-flow-state">{data.state==='executed'?'✓ 已执行':data.state==='current'?'● 当前节点':'未执行'}</div>}
    {!['end','handoff'].includes(n.type)&&<><footer>{n.type==='condition'?<><span>满足</span><span>不满足</span></>:<span>继续</span>}</footer><Handle type="source" position={Position.Bottom} id="next" style={{left:n.type==='condition'?'25%':'50%'}} aria-label={'节点 '+data.number+' '+(n.type==='condition'?'满足':'继续')}/>{n.type==='condition'&&<Handle type="source" position={Position.Bottom} id="otherwise" style={{left:'75%'}} aria-label={'节点 '+data.number+' 不满足'}/>}</>}
  </div>
}
const types={step:FlowCard}
// This child runs inside the canvas provider, after node measurements are ready.
function Background({gap,color}:{gap:number;color:string}){
  const ready=useNodesInitialized(),flow=useReactFlow()
  useEffect(()=>{if(ready)void flow.fitView({padding:0.12,maxZoom:1,minZoom:0.5})},[ready,flow])
  return <FlowBackground gap={gap} color={color}/>
}
export default function WorkflowCanvas({nodes,selected,onSelect,onChange,readOnly=false,run,onCheckpoint}: {nodes:FlowNode[];selected:string;onSelect:(id:string)=>void;onChange:(nodes:FlowNode[],record?:boolean)=>void;readOnly?:boolean;run?:any;onCheckpoint:()=>void}){
  const [instance,setInstance]=useState<ReactFlowInstance<Node<CardData>>|null>(null),[message,setMessage]=useState('')
  const [measurements,setMeasurements]=useState<Record<string,{width:number;height:number}>>({})
  // Controlled nodes must retain React Flow's measured dimensions. Dropping them
  // on each render breaks fitView/handles and makes the minimap appear empty.
  const flowNodes=useMemo<Node<CardData>[]>(()=>{
    const fallback=autoLayout(nodes),done=new Set<string>((run?.steps||[]).map((s:any)=>s.nodeId))
    return nodes.map((n,i)=>({id:n.id,type:'step',position:n.position||fallback[i].position!,measured:measurements[n.id],selected:n.id===selected,data:{step:n,number:i+1,entry:i===0,state:run?(done.has(n.id)?'executed':run.cursor===n.id?'current':'pending'):''}}))
  },[nodes,selected,run,measurements])
  const edges=nodes.flatMap(n=>['end','handoff'].includes(n.type)?[]:(['next',...(n.type==='condition'?['otherwise']:[])] as ('next'|'otherwise')[]).flatMap(port=>n[port]?[{id:n.id+':'+port,source:n.id,sourceHandle:port,target:n[port],targetHandle:'input',label:n.type==='condition'?(port==='next'?'满足':'不满足'):undefined,markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:run?.steps?.some((s:any)=>s.nodeId===n.id&&s.next===n[port])?'#176b54':'#788b82',strokeWidth:2},ariaLabel:`${nodes.indexOf(n)+1} ${port==='otherwise'?'不满足':'继续'} → ${(nodes.findIndex(x=>x.id===n[port]))+1}`}]:[]))
  const connect=(c:Connection)=>{if(!c.source||!c.target||!canConnect(nodes,c.source,c.target,c.sourceHandle||'next')){setMessage('不能连接：请避免自连、循环或结束节点外连');return}onChange(nodes.map(n=>n.id===c.source?{...n,[c.sourceHandle||'next']:c.target}:n));setMessage('连线已更新，保存任务后生效')}
  return <div className="g-flow-wrap"><div className="g-flow-tools"><span>拖动节点调整布局 · 点选端口连线</span><button type="button" disabled={readOnly} onClick={()=>{onChange(autoLayout(nodes));requestAnimationFrame(()=>requestAnimationFrame(()=>void instance?.fitView({padding:0.12,maxZoom:1})))}}>自动排版</button><button type="button" onClick={()=>void instance?.fitView({padding:0.12,maxZoom:1})}>适应画布</button><button type="button" onClick={()=>void instance?.zoomTo(1)}>100%</button></div>
    <div className="g-flow-surface" aria-label="可视化工作流画布"><ReactFlow<Node<CardData>> nodes={flowNodes} edges={edges} nodeTypes={types} onInit={setInstance} onNodeClick={(_e,n)=>onSelect(n.id)} onNodeDragStart={()=>onCheckpoint()} onNodesChange={changes=>{const dimensions=changes.filter(c=>c.type==='dimensions');if(dimensions.length)setMeasurements(previous=>{const next={...previous};let changed=false;for(const c of dimensions)if(c.dimensions&&(next[c.id]?.width!==c.dimensions.width||next[c.id]?.height!==c.dimensions.height)){next[c.id]=c.dimensions;changed=true}return changed?next:previous});const positions=changes.filter(c=>c.type==='position');if(readOnly||!positions.length)return;const next=applyNodeChanges(positions,flowNodes);onChange(nodes.map(n=>({...n,position:next.find(x=>x.id===n.id)!.position})),false)}} onConnect={connect} isValidConnection={c=>canConnect(nodes,c.source,c.target,c.sourceHandle||'next')} onEdgesDelete={deleted=>{if(!readOnly)onChange(nodes.map(n=>({...n,next:deleted.some(e=>e.source===n.id&&e.sourceHandle==='next')?'':n.next,otherwise:deleted.some(e=>e.source===n.id&&e.sourceHandle==='otherwise')?'':n.otherwise})))}} onNodesDelete={()=>{}} nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable={!readOnly} deleteKeyCode={null} zoomOnScroll={false} preventScrolling={false} fitView fitViewOptions={{padding:0.12,maxZoom:1,minZoom:0.5}} minZoom={0.15} maxZoom={1.6} ariaLabelConfig={{'controls.zoomIn.ariaLabel':'放大画布','controls.zoomOut.ariaLabel':'缩小画布','controls.fitView.ariaLabel':'适应画布','minimap.ariaLabel':'流程缩略图'}}><Background gap={20} color="#c6d3ca"/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#c3d8c9"/></ReactFlow></div>{message&&<p className="g-hint" role="status">{message}</p>}
  </div>
}
