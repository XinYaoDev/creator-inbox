'use strict';
const {timingSafeEqual}=require('node:crypto');
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

function createAccess({adminToken='',teamJson=''}={}){
  let team=[];
  if(teamJson){
    try{team=JSON.parse(teamJson);}catch{throw new Error('GROWTH_TEAM_TOKENS 必须是 JSON 数组');}
    if(!Array.isArray(team)||team.some(t=>typeof t.token!=='string'||t.token.length<24||!t.name||!['operator','viewer'].includes(t.role)))throw new Error('团队令牌需至少 24 字符，角色为 operator 或 viewer');
    if(!adminToken)throw new Error('使用团队令牌时必须同时设置 AUTH_TOKEN 管理员令牌');
    if(new Set(team.map(t=>t.token)).size!==team.length||team.some(t=>same(t.token,adminToken)))throw new Error('团队令牌不能重复或与管理员令牌相同');
  }
  function identity(req,url){
    if(!adminToken&&!team.length)return {name:'本地管理员',role:'admin',memberId:'owner',secured:false};
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'')||url.searchParams.get('token')||'';
    if(token&&same(token,adminToken))return {name:'管理员',role:'admin',memberId:'owner',secured:true};
    const member=team.find(t=>same(token,t.token));
    return member?{name:String(member.name),role:member.role,memberId:String(member.memberId||''),secured:true}:null;
  }
  function allowed(identity,method,path){
    if(!identity)return false;
    if(identity.workspaceId&&identity.workspaceId!=='default'&&!path.startsWith('/api/growth/'))return false;
    if(identity.role==='admin')return true;
    if(!path.startsWith('/api/growth/'))return false; // Legacy account cookies and publishing are admin-only.
    if(method==='GET')return !path.endsWith('.csv')||identity.role==='operator';
    if(identity.role==='viewer')return false;
    return (method==='PATCH'&&/^\/api\/growth\/(conversations|leads|tasks)\/[^/]+$/.test(path))||
      (method==='POST'&&(/^\/api\/growth\/conversations\/[^/]+\/(reply|note|suggest|task|sales-reset)$/.test(path)||/^\/api\/growth\/conversations\/[^/]+\/cards\/[^/]+\/(adopt|dismiss)$/.test(path)));
  }
  return {identity,allowed};
}
module.exports={createAccess};
