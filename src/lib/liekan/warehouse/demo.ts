import { createHash, createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { v5 } from 'uuid';
import type { ClickHouseClient } from '@clickhouse/client';
import { sourceFingerprint } from './catalog';
import { recordKey, rowDigest } from './codec';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { factInput, warehouseTime } from './fact-input';
import { MigrationPages, MIGRATION_TRANSFORM_VERSION } from './migration-page';
import type { MigrationRow } from './migration-source';
import { verifyBoundWarehouse } from './installation-identity';

// The fixture remains the existing signed, explicitly named demonstration.
// Stream pages directly to CH; no temporary PG facts or production-like seed.
export async function seedWarehouseDemo(db: ControlDatabase, ch: ClickHouseClient, options: {
  secret: string; now?: number; signal?: AbortSignal; progress?: (value: unknown) => void;
}) {
  if (!options.secret) throw new Error('warehouse-demo-secret-required');
  const fixture = await import(pathToFileURL(resolve('scripts/liekan-demo.mjs')).href);
  const manifest = await fixture.readDemoManifest(), site = fixture.DEFAULT_DEMO_ID;
  await verifyBoundWarehouse(db, ch);
  const owner = randomUUID(), source = `official-demo-v1:${manifest.sha256}`;
  const secretProof = createHmac('sha256', options.secret).update('liekan-demo-seed-identity').digest('hex');
  const setup = await db.transaction(async tx => {
    const [installation] = (await tx.query<any>('SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE')).rows;
    if (installation?.authority !== 'clickhouse' ||
      (await tx.query("SELECT 1 FROM liekan_warehouse_transition WHERE state<>'closed' UNION ALL SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen')")).rowCount)
      throw new WarehouseConflict('warehouse-demo-requires-final-clickhouse');
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('liekan-default-demo'))::text");
    const [existing] = (await tx.query<any>('SELECT w.name,w.domain,w.deleted_at,s.is_demo FROM website w LEFT JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1 FOR UPDATE OF w',[site])).rows;
    if (existing && (existing.name!==fixture.DEFAULT_DEMO_NAME || existing.domain!==fixture.DEFAULT_DEMO_DOMAIN || existing.is_demo!==true))
      throw new Error('warehouse-demo-identity-conflict');
    const [prior] = (await tx.query<any>('SELECT * FROM liekan_warehouse_migration WHERE source_identity=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[source])).rows;
    if(existing?.deleted_at || (!existing && (await tx.query("SELECT 1 FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1",[site])).rowCount))
      return {done:'deleted'};
    if(existing && (!prior || prior.phase==='exited')) return {done:'existing'};
    if(prior && prior.boundary.demo.secretProof!==secretProof) throw new Error('warehouse-demo-resume-secret-changed');
    if(prior && prior.lease_until && new Date(prior.lease_until).getTime()>Date.now()) throw new WarehouseConflict('warehouse-demo-owned');
    const [admin] = (await tx.query<{id:string}>("SELECT user_id AS id FROM \"user\" WHERE role='admin' AND deleted_at IS NULL ORDER BY created_at,user_id LIMIT 1")).rows;
    if(!admin)throw new Error('warehouse-demo-administrator-required');
    const anchor=prior?.boundary.demo.anchor ?? (options.now??Date.now())-300000;
    const imported=v5(`import:${manifest.sha256}`,site);
    if(!existing){
      await tx.query('INSERT INTO website(website_id,name,domain,user_id,created_by) VALUES($1,$2,$3,$4,$4)',[site,fixture.DEFAULT_DEMO_NAME,fixture.DEFAULT_DEMO_DOMAIN,admin.id]);
      await tx.query('INSERT INTO liekan_setting(website_id,is_demo,rules) VALUES($1,true,$2::jsonb)',[site,JSON.stringify(manifest.rules)]);
      await tx.query('INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1,$2,$3,0,0)',[imported,site,manifest.sha256]);
      await tx.query("UPDATE liekan_warehouse_site SET state='frozen' WHERE website_id=$1",[site]);
    }
    const [current]=(await tx.query<any>('SELECT epoch,state FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',[site])).rows;
    if(current?.state!=='frozen'||(prior&&prior.boundary.sites[site]!==current.epoch))throw new WarehouseConflict('warehouse-demo-site-changed');
    const id=prior?.migration_id??randomUUID();
    if(!prior)await tx.query(`INSERT INTO liekan_warehouse_migration(migration_id,source_identity,source_fingerprint,source_snapshot,transform_version,phase,boundary)
      VALUES($1,$2,$3,$4,$5,'prepared',$6::jsonb)`,[id,source,sourceFingerprint,manifest.sha256,MIGRATION_TRANSFORM_VERSION,JSON.stringify({sites:{[site]:current.epoch},demo:{anchor,secretProof}})]);
    await tx.query("UPDATE liekan_warehouse_migration SET owner_id=$2,lease_until=clock_timestamp()+interval '90 seconds' WHERE migration_id=$1",[id,owner]);
    return {id,epoch:current.epoch,anchor,imported,admin:admin.id};
  });
  if(setup.done)return {websiteId:site,status:setup.done,inserted:false};
  const pages=new MigrationPages(db,ch),counts:Record<string,number>={session:0,event:0,log:0,catalog:0,report:0};
  const buffers=new Map<string,MigrationRow[]>(), cursors=new Map<string,string[]|null>(), totals=new Map<string,number>();
  let failed:unknown;
  const heartbeat=setInterval(()=>db.read("UPDATE liekan_warehouse_migration SET lease_until=clock_timestamp()+interval '90 seconds' WHERE migration_id=$1 AND owner_id=$2 AND lease_until>clock_timestamp() RETURNING migration_id",[setup.id,owner]).then(rows=>{if(!rows.length)failed=new Error('warehouse-demo-lease-lost');}).catch(e=>{failed=e;}),15000);
  async function flush(family:string){
    options.signal?.throwIfAborted();if(failed)throw failed;
    const rows=buffers.get(family)??[];if(!rows.length)return;
    const before=cursors.get(family)??null, after=[String((totals.get(family)??0)+rows.length)];
    const digest=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const page={family,before,after,rows,digest};
    await pages.apply(setup.id,page);await pages.verifyPage(setup.id,page);
    cursors.set(family,after);totals.set(family,Number(after[0]));buffers.set(family,[]);
    options.progress?.({family,rows:after[0],stage:'demo'});
  }
  async function fact(family:string,values:Record<string,unknown>,time:string,sessionId:string|null=null,visitId:string|null=null){
    const row=factInput(family,{...values,website_id:site});
    const records=buffers.get(family)??[];
    records.push({row,key:recordKey(family,row),hash:rowDigest(family,row),websiteId:site,sessionId,visitId,
      recordTime:warehouseTime(time),
      ...(family==='website_event'?{hostnameProof:{sourceHash:createHash('sha256').update(fixture.DEFAULT_DEMO_DOMAIN).digest('hex'),normalized:fixture.DEFAULT_DEMO_DOMAIN}}:{}),
      ...(family==='liekan_log'?{logScopeProof:{present:true,repairScopeId:null}}:{})});
    buffers.set(family,records);if(records.length>=2000)await flush(family);
  }
  try{
    let metadata=false;
    for await(const raw of fixture.readDemoRecords()){
      const kind=raw[0];if(kind==='metadata'){if(metadata||raw[1].websiteId!==site||raw[1].isDemo!==true)throw new Error('warehouse-demo-invalid-metadata');metadata=true;continue;}
      if(!metadata||!(kind in counts))throw new Error('warehouse-demo-invalid-kind');
      const r=fixture.demoRecord(kind,raw,counts[kind]++,setup.anchor,options.secret);
      if(kind==='session')await fact('session',{session_id:r.id,browser:r.browser,os:r.os,device:r.device,screen:r.screen,language:r.language,country:r.country,region:r.region,city:r.city,created_at:r.time},r.time,r.id);
      else if(kind==='event')await fact('website_event',{event_id:r.id,session_id:r.session,visit_id:r.visit,created_at:r.time,url_path:r.path,hostname:fixture.DEFAULT_DEMO_DOMAIN,referrer_domain:r.referrer,event_type:r.type,event_name:r.name,utm_source:r.source,utm_medium:r.medium,utm_campaign:r.campaign,utm_term:r.term,utm_content:r.content,cls:r.cls,fcp:r.fcp,inp:r.inp,lcp:r.lcp,ttfb:r.ttfb},r.time,r.session,r.visit);
      else if(kind==='log'){
        await fact('liekan_log',{id:r.id,import_id:setup.imported,created_at:r.time,path:r.path,method:r.method,status:r.status,bytes:r.bytes,ip_masked:'203.0.113.*',ip_hash:r.ipHash,user_agent:r.agent,location:'示例位置',bot:r.bot,vendor:r.vendor,bot_type:r.type,verification:'unverified'},r.time);
        await fact('liekan_crawler_evidence',{log_id:r.id,classification_version:r.version,crawler_id:r.crawler},r.time);
      }else if(kind==='catalog')await db.read(`INSERT INTO liekan_catalog(website_id,path,title,content_type,word_count,published_at,structured,structure_score,content_updated_at,link_depth,evidence_source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'随代码分发的示例内容目录') ON CONFLICT DO NOTHING`,[site,r.path,r.title,r.type,r.words,r.published,r.structured,r.score,r.updated,r.depth]);
      else await db.read('INSERT INTO report(report_id,user_id,website_id,type,name,description,parameters) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',[r.id,setup.admin,site,r.type,r.name,r.description,JSON.stringify(r.parameters)]);
    }
    for(const family of buffers.keys())await flush(family);
    if(Object.keys(counts).some(k=>counts[k]!==manifest.counts[k]))throw new Error('warehouse-demo-count-mismatch');
    await db.transaction(async tx=>{
      await tx.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE',[site]);
      const [current]=(await tx.query<any>('SELECT epoch,state FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',[site])).rows;
      if(current?.state!=='frozen'||current.epoch!==setup.epoch)throw new WarehouseConflict('warehouse-demo-site-changed');
      const updated=await tx.query("UPDATE liekan_warehouse_migration SET phase='exited',verified_digest=$3,owner_id=NULL,lease_until=NULL WHERE migration_id=$1 AND owner_id=$2 AND lease_until>clock_timestamp() RETURNING migration_id",[setup.id,owner,createHash('sha256').update(JSON.stringify([...totals])).digest('hex')]);
      if(!updated.rowCount)throw new WarehouseConflict('warehouse-demo-lease-lost');
      await tx.query("UPDATE liekan_warehouse_migration_family SET status='verified' WHERE migration_id=$1",[setup.id]);
      await tx.query('UPDATE liekan_import SET accepted=$2 WHERE id=$1',[setup.imported,counts.log]);
      await tx.query("UPDATE liekan_warehouse_site SET state='active' WHERE website_id=$1",[site]);
      await tx.query('INSERT INTO liekan_log_state(website_id,data_revision) VALUES($1,1) ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1',[site]);
      await tx.query("INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision) VALUES('website',$1,1) ON CONFLICT(resource_type,resource_id) DO UPDATE SET revision=liekan_analytics_revision.revision+1",[site]);
    });
    return {websiteId:site,status:'created',inserted:true,counts};
  }finally{
    clearInterval(heartbeat);
    await db.read('UPDATE liekan_warehouse_migration SET owner_id=NULL,lease_until=NULL WHERE migration_id=$1 AND owner_id=$2',[setup.id,owner]);
  }
}
