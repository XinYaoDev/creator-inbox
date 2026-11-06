import {useEffect,useState} from 'react'

export default function UpdateNotice(){
  const [available,setAvailable]=useState(false)
  useEffect(()=>{
    let active=true
    const check=async()=>{try{const r=await fetch('/build.json',{cache:'no-store'});if(!r.ok)return;const data=await r.json();if(active&&data.id&&data.id!==__APP_BUILD__)setAvailable(true)}catch{/* Offline checks never interrupt work. */}}
    const timer=setInterval(check,60000)
    window.addEventListener('focus',check);void check()
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',check)}
  },[])
  return available?<div className="g-update-notice" role="status"><span><strong>新界面已就绪</strong> 保存当前编辑后重新载入，即可使用最新功能。</span><button onClick={()=>location.reload()}>载入新版本</button></div>:null
}
