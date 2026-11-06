export default function CrawlBudget({pages,depth,onPages,onDepth,renderMode='auto',onRenderMode,disabled=false}: {pages:number;depth:number;onPages:(v:number)=>void;onDepth:(v:number)=>void;renderMode?:string;onRenderMode?:(v:string)=>void;disabled?:boolean}) {
  return <fieldset className="g-form-grid g-permission" disabled={disabled}>
    <label className="g-field">页面预算<select aria-label="采集页面预算" value={pages} onChange={e=>onPages(Number(e.target.value))}>{[1,3,5,10,20].map(n=><option key={n} value={n}>最多 {n} 页</option>)}</select></label>
    <label className="g-field">链接深度<select aria-label="采集链接深度" value={depth} onChange={e=>onDepth(Number(e.target.value))}>{[0,1,2,3].map(n=><option key={n} value={n}>{n===0?'仅输入网址':`最多 ${n} 层同站链接`}</option>)}</select></label>
    {onRenderMode&&<label className="g-field wide">网页加载方式<select aria-label="网页加载方式" value={renderMode} onChange={e=>onRenderMode(e.target.value)}><option value="auto">自动识别：需要时运行 JavaScript</option><option value="javascript">动态网页：等待 JavaScript 正文</option><option value="static">仅静态正文：不运行 JavaScript</option></select></label>}
    <p className="g-hint wide">公开 HTML、JSON、纯文本和 PDF。总正文最多 600 KB；PDF 最多 16 MiB / 80 页，只提取文字层。链接不跨站、不带查询参数。{renderMode==='static'?'任务最长 90 秒。':'独立无登录态渲染，单页最多 60 秒 / 100 个资源 / 24 MiB，任务最长 180 秒；不点击按钮、不提交表单、不绕过验证码。'}未完整加载的页面会说明原因，不会自动覆盖旧知识。</p>
  </fieldset>
}
