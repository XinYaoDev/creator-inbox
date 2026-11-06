import {mkdtempSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'

const root=fileURLToPath(new URL('../',import.meta.url))
if(!existsSync(join(root,'dist/index.html')))throw new Error('请先执行 npm run build')
const directory=process.env.GROWTH_PREVIEW_DIR?resolve(process.env.GROWTH_PREVIEW_DIR):mkdtempSync(join(tmpdir(),'creator-growth-preview-'))
const port=process.env.GROWTH_PREVIEW_PORT||'18877'
const env={...process.env,PORT:port,HOST:'127.0.0.1',DB_PATH:join(directory,'preview.db'),MEDIA_ROOT:join(directory,'media'),DISABLE_COLLECT:'1',GROWTH_DEMO:'1',AUTH_TOKEN:'',GROWTH_TEAM_TOKENS:'',COOKIE_FILE:join(directory,'no-cookie'),DY_COOKIE_FILE:join(directory,'no-dy-cookie')}
// Never inherit production API keys. Saved workspace keys remain usable;
// local Hermes is available only with explicit HERMES_CODEX_ENABLED=1 and a saved provider selection.
for(const name of ['NOTE_LLM_KEY','KIMI_API_KEY','MOONSHOT_API_KEY','DEEPSEEK_API_KEY','OPENAI_API_KEY','GROWTH_LLM_KEY','NOTE_IMAGE_KEY','FAL_KEY','SILICONFLOW_API_KEY','HERMES_IMAGE_TOKEN','HERMES_IMAGE_URL'])env[name]=''
console.log(`隔离验收地址：http://127.0.0.1:${port}\n数据目录：${directory}\n不使用生产客户数据，不继承环境模型密钥。在本空间保存密钥后会真实调用 API，可能产生费用。保留数据可用 GROWTH_PREVIEW_DIR 再次启动。`)
const child=spawn(process.execPath,['server/index.js'],{cwd:root,env,stdio:'inherit'})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
child.on('exit',code=>process.exit(code||0))
