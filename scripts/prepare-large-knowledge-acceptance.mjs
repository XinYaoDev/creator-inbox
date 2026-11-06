// Real public corpus, not fabricated rows: Stanford SQuAD 2.0 training set.
// Redistribution and adaptation: CC BY-SA 4.0; retain question/context provenance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const directory=path.resolve('data/large-source-acceptance-20261018');
await fs.mkdir(directory,{recursive:true});
const raw=path.join(directory,'squad-train-v2.0.json');
try{await fs.access(raw);}catch{execFileSync('curl',['--fail','--location','--retry','2','--max-time','180','--output',raw,'https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v2.0.json'],{stdio:'inherit'});}
const bytes=await fs.readFile(raw),source=JSON.parse(bytes),filename=path.join(directory,'SQuAD2-公开问答全量.jsonl');
const file=await fs.open(filename,'wx'),hash=createHash('sha256');let count=0,size=0;
try{for(const article of source.data)for(const p of article.paragraphs)for(const q of p.qas){
  const entry={title:('SQuAD-'+q.id+' · '+q.question).slice(0,200),category:'公开验收 · SQuAD 2.0',body:`Question: ${q.question}\nContext: ${p.context}\n${q.is_impossible?'No supported answer in this paragraph.':'Annotated answers: '+q.answers.map(a=>a.text).join(' / ')}\nArticle: ${article.title}\nQuestion ID: ${q.id}\nSource: https://rajpurkar.github.io/SQuAD-explorer/\nLicense: CC BY-SA 4.0. Adapted to knowledge-entry JSONL for local import acceptance.`};
  const line=Buffer.from(JSON.stringify(entry)+'\n');await file.write(line);hash.update(line);size+=line.length;count++;
}}finally{await file.close();}
const result={source:'https://rajpurkar.github.io/SQuAD-explorer/dataset/train-v2.0.json',license:'CC BY-SA 4.0',rawBytes:bytes.length,rawSha256:createHash('sha256').update(bytes).digest('hex'),filename,count,bytes:size,sha256:hash.digest('hex')};
await fs.writeFile(path.join(directory,'corpus-manifest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
