// Build a native-restorable, isolated full-vector acceptance snapshot. Never
// copies credentials or changes the installed customer's workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createSnapshot,verifySnapshot} from '/Users/xinjiang/wechat-inbox-app/desktop/backup.mjs';
const require=createRequire(import.meta.url),{createModelSettings}=require('../server/model-settings.js');
const directory=path.resolve(process.argv[2]||'');
if(!directory.includes('large-source-acceptance-20261018/full-vectors-'))throw Error('Expected isolated full-vector acceptance directory');
const build=JSON.parse(await fs.readFile(path.join(directory,'build-report.json'),'utf8'));
const search=JSON.parse(await fs.readFile(path.join(directory,'search-report.json'),'utf8'));
if(build.records!==130319||build.index.ready!==300374||build.index.pending||search.groups['original-question']?.passed!==200||search.results.some(r=>!r.pass&&r.kind!=='paraphrase-diagnostic'))throw Error('Finish full HTTP acceptance before preparing desktop data');
const staging=await fs.mkdtemp(path.join(path.dirname(directory),'desktop-full-')),data=path.join(staging,'data');
await fs.mkdir(data,{mode:0o700});
const source=new DatabaseSync(path.join(directory,'inbox.db'));source.exec('PRAGMA wal_checkpoint(TRUNCATE)');source.close();
await fs.copyFile(path.join(directory,'inbox.db'),path.join(data,'inbox.db'),fs.constants.COPYFILE_FICLONE);
const db=new DatabaseSync(path.join(data,'inbox.db'));
createModelSettings({db,keyPath:path.join(data,'.model-key'),env:{}}).save('default',{provider:'api',embeddingProvider:'local',embeddingMinScore:.4,clearKey:true});
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
const snapshot=await createSnapshot(staging,'0.6.0-full-vectors-130319'),qa='/Users/xinjiang/Library/Application Support/com.yuejing.laike.acceptance';
await fs.mkdir(path.join(qa,'snapshots'),{recursive:true,mode:0o700});
// Both directories are on this machine's data volume. Move the completed
// snapshot atomically instead of making a third multi-gigabyte database copy.
await fs.rename(snapshot.path,path.join(qa,'snapshots',snapshot.id));
const verified=await verifySnapshot(qa,snapshot.id);
const report={staging,snapshotId:snapshot.id,bytes:verified.bytes,records:130319,vectors:300374,credentials:'No model keys or login credentials copied',createdAt:new Date().toISOString()};
await fs.writeFile(path.join(directory,'desktop-snapshot.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
