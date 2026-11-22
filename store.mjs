import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { redact, summarize } from './metrics.mjs';

export class Store {
  constructor(dir, secrets=[]) {
    mkdirSync(dir,{recursive:true,mode:0o700}); this.secrets=secrets;
    this.db=new DatabaseSync(path.join(dir,'lab.sqlite')); chmodSync(path.join(dir,'lab.sqlite'),0o600);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));');
    this.db.exec("CREATE INDEX IF NOT EXISTS records_run_idx ON records(kind,json_extract(data,'$.runId'));");
  }
  put(kind, value) { const safe=redact(value,this.secrets);this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,safe.id,JSON.stringify(safe));return safe; }
  get(kind,id) { const row=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return row ? JSON.parse(row.data):null; }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r=>JSON.parse(r.data)); }
  patch(kind,id,changes) { const old=this.get(kind,id);return old?this.put(kind,{...old,...changes}):null; }
  forRun(kind,id) { return this.db.prepare("SELECT data FROM records WHERE kind=? AND json_extract(data,'$.runId')=? ORDER BY rowid").all(kind,id).map(r=>JSON.parse(r.data)); }
  run(id) { const run=this.get('run',id);if(!run)return null;const calls=this.forRun('call',id).filter(c=>c.scope!=='background').sort((a,b)=>a.startedAt.localeCompare(b.startedAt));return {...run,calls,summary:summarize(calls),events:this.forRun('event',id).filter(e=>!e.context?.sessionKey?.includes(':cron:')).sort((a,b)=>a.at.localeCompare(b.at))}; }
  runs() {
    const rows=this.db.prepare("SELECT json_object('id',id,'label',json_extract(data,'$.label'),'status',json_extract(data,'$.status'),'startedAt',json_extract(data,'$.startedAt'),'endedAt',json_extract(data,'$.endedAt'),'strategy',json_extract(data,'$.strategy'),'model',json_extract(data,'$.model')) AS data FROM records WHERE kind='run' AND COALESCE(json_extract(data,'$.scope'),'experiment') != 'background' ORDER BY rowid DESC").all();
    return rows.map(row=>{const r=JSON.parse(row.data);const calls=this.db.prepare("SELECT json_object('status',json_extract(data,'$.status'),'tps',json_extract(data,'$.tps'),'usage',json_extract(data,'$.usage'),'timing',json_extract(data,'$.timing')) AS data FROM records WHERE kind='call' AND json_extract(data,'$.runId')=? AND COALESCE(json_extract(data,'$.scope'),'experiment') != 'background'").all(r.id).map(c=>JSON.parse(c.data));return {...r,summary:summarize(calls)};});
  }
  close() { this.db.close(); }
}
