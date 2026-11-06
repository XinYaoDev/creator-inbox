import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {createRequire} from 'node:module'

// Ship PDF character maps/fonts locally; importing customer PDFs needs no CDN.
const require=createRequire(import.meta.url)
const pdfRoot=dirname(require.resolve('pdfjs-dist/package.json'))
const pdfAssets=new Map<string,Buffer>()
const buildId=new Date().toISOString()
for(const directory of ['cmaps','standard_fonts']){
  for(const file of readdirSync(join(pdfRoot,directory))){
    pdfAssets.set('pdfjs/'+directory+'/'+file,readFileSync(join(pdfRoot,directory,file)))
  }
}
const ocrRoot=dirname(require.resolve('tesseract.js/package.json'))
pdfAssets.set('ocr/LICENSE_TESSERACT_JS',readFileSync(join(ocrRoot,'LICENSE.md')))
pdfAssets.set('ocr/worker.min.js',readFileSync(join(ocrRoot,'dist/worker.min.js')))
const coreRoot=dirname(require.resolve('tesseract.js-core/package.json'))
pdfAssets.set('ocr/LICENSE_TESSERACT_CORE',readFileSync(join(coreRoot,'LICENSE')))
pdfAssets.set('ocr/LICENSE_TESSDATA',readFileSync(join(coreRoot,'LICENSE')))
pdfAssets.set('ocr/THIRD_PARTY_NOTICES.txt',Buffer.from('Tesseract.js and Tesseract.js Core: Apache-2.0.\nBundled chi_sim and eng traineddata from https://github.com/naptha/tessdata (upstream LICENSE: Apache-2.0).\nNPM data package metadata is retained below; package metadata declares MIT while the upstream traineddata repository ships Apache-2.0.\nThe traineddata binaries are unmodified.\n'))
for(const file of readdirSync(coreRoot).filter(f=>/-lstm\.wasm\.js$/.test(f)))pdfAssets.set('ocr/core/'+file,readFileSync(join(coreRoot,file)))
for(const language of ['chi_sim','eng']){
  const root=dirname(require.resolve('@tesseract.js-data/'+language+'/package.json'))
  pdfAssets.set('ocr/lang/'+language+'.package.json',readFileSync(join(root,'package.json')))
  pdfAssets.set('ocr/lang/'+language+'.traineddata.gz',readFileSync(join(root,'4.0.0_best_int',language+'.traineddata.gz')))
}

export default defineConfig({
  define:{__APP_BUILD__:JSON.stringify(buildId)},
  plugins: [react(),{
    name:'local-pdf-assets',
    generateBundle(){
      this.emitFile({type:'asset',fileName:'build.json',source:JSON.stringify({id:buildId})})
      for(const [fileName,source] of pdfAssets)this.emitFile({type:'asset',fileName,source})
    },
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const path=new URL(req.url||'/', 'http://localhost').pathname.slice(1)
      const data=pdfAssets.get(path)
      if(!data)return next()
      res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':'application/octet-stream')
      res.end(data)
    })},
  }],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8877' },
  },
})
