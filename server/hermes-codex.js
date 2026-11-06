'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
function createHermesCodex({env=process.env,spawnProcess=spawn}={}) {
  const root=env.HERMES_CODEX_ROOT||path.join(os.homedir(),'.hermes/hermes-agent');
  const tools=path.join(os.homedir(),'.hermes/tools');
  const candidates=fs.existsSync(tools)?fs.readdirSync(tools).filter(n=>n.startsWith('python-')).sort().reverse().map(n=>path.join(tools,n,'bin/python3')):[];
  const python=env.HERMES_CODEX_PYTHON||candidates.find(p=>fs.existsSync(p))||'';
  const available=()=>env.HERMES_CODEX_ENABLED==='1'&&!!python&&fs.existsSync(python)&&fs.existsSync(path.join(root,'hermes_bootstrap.py'));
  let active=0;
  async function call(action,payload){
    if(!available())throw new Error('本机 Hermes 连接未启用或运行环境不存在，请由服务器管理员配置');
    if(active>=2)throw new Error('本机模型已有两个请求在处理，请稍后重试');
    const input=JSON.stringify({action,payload,hermesRoot:root});
    if(Buffer.byteLength(input)>8_500_000)throw new Error('模型输入过大，请减少图片或上下文');
    active++;
    try{return await new Promise((resolve,reject)=>{
      const child=spawnProcess(python,['-I',path.join(__dirname,'hermes-codex.py')],{stdio:['pipe','pipe','pipe'],env:{...env,PYTHONUNBUFFERED:'1'}});
      let output='',finished=false;
      const finish=(error,data)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(data);};
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Codex 请求超时，未发送任何部分回复'));},action==='status'?20000:180000);
      child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>1_000_000){child.kill('SIGKILL');finish(new Error('模型输出超出大小限制'));}});
      child.stderr.resume(); // Never log auth helper diagnostics or credential-bearing exceptions.
      child.on('error',()=>finish(new Error('无法启动本机 Hermes 模型连接')));
      child.on('close',code=>{if(finished)return;try{const data=JSON.parse(output);if(code!==0||!data.ok)throw new Error(data.error||'Codex 未完成请求');finish(null,data);}catch(e){finish(new Error(e instanceof SyntaxError?'本机模型连接返回无效数据':e.message));}});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });}finally{active--;}
  }
  return {available,status:()=>call('status'),complete:payload=>call('complete',payload)};
}
module.exports={createHermesCodex};
