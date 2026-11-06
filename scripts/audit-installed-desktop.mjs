import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const phase=process.argv[2];if(!['before','after'].includes(phase))throw Error('Use before or after');
const directory=path.resolve('data/large-source-acceptance-20261018'),home='/Users/xinjiang/Library/Application Support/com.yuejing.laike';
const db=new DatabaseSync(path.join(home,'data/inbox.db'),{readOnly:true});
const counts=db.prepare('SELECT kind,count(*) n FROM growth_records GROUP BY kind ORDER BY kind').all();
const recordHashes={};for(const {kind} of counts){if(kind==='knowledgeIndexJob')continue;const hash=crypto.createHash('sha256');for(const row of db.prepare('SELECT * FROM growth_records WHERE kind=? ORDER BY id').iterate(kind))hash.update(JSON.stringify(row));recordHashes[kind]=hash.digest('hex');}
const modelHash=crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM team_model_settings ORDER BY workspaceId').all())).digest('hex');
const metaRows=db.prepare("SELECT * FROM growth_records WHERE kind='meta' ORDER BY id").all();
db.close();
const report={checkedAt:new Date().toISOString(),counts,recordHashes,modelHash,state:JSON.parse(await fs.readFile(path.join(home,'desktop-state.json'),'utf8'))};
if(phase==='after'){
  const before=JSON.parse(await fs.readFile(path.join(directory,'installed-before.json'),'utf8'));
  report.modelsUnchanged=modelHash===before.modelHash;
  report.businessUnchanged=JSON.stringify(recordHashes)===JSON.stringify(before.recordHashes);
  // This acceptance baseline predates the source scheduler's periodic marker.
  // Verify the entire original hash with only that known timestamp restored;
  // never ignore arbitrary metadata or business changes.
  const normalized=metaRows.map(row=>row.id==='source-sync'?{...row,updated:1792328685}:row),metaHash=crypto.createHash('sha256');
  for(const row of normalized)metaHash.update(JSON.stringify(row));
  report.onlySchedulerTimestampChanged=metaHash.digest('hex')===before.recordHashes.meta&&Object.keys(before.recordHashes).every(kind=>kind==='meta'||recordHashes[kind]===before.recordHashes[kind]);
  report.businessContentUnchanged=report.businessUnchanged||report.onlySchedulerTimestampChanged;
  if(report.onlySchedulerTimestampChanged)report.volatileChange={record:'meta/source-sync',field:'updated',baseline:1792328685,current:metaRows.find(row=>row.id==='source-sync')?.updated};
  if(!report.modelsUnchanged||!report.businessContentUnchanged)process.exitCode=1;
}
await fs.writeFile(path.join(directory,'installed-'+phase+'.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({phase,counts,modelsUnchanged:report.modelsUnchanged,businessUnchanged:report.businessUnchanged,businessContentUnchanged:report.businessContentUnchanged,volatileChange:report.volatileChange,state:report.state}));
