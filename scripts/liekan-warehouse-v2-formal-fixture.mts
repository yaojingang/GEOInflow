import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Client } from 'pg';

export const DAY = 86_400_000;
export const HOST = 's0.invalid';
export const PREFLIGHT = process.env.BENCH_PREFLIGHT === '1';
export const HISTORY = { logs: PREFLIGHT ? 9600 : 5_700_000, pv: 181_300, uv: 96_000, paths: 8192 };
export const lanePath = (lane: number) => '/article/' + String(lane).padStart(4, '0');

export async function seedSite(
  pg: Client,
  ch: ClickHouseClient,
  admin: string,
  phase: string,
  anchor: number,
) {
  const site = randomUUID();
  const source = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await pg.query('BEGIN');
  try {
    const owner = await pg.query(
      'SELECT user_id FROM "user" WHERE username=$1 AND role=\'admin\' AND deleted_at IS NULL',
      [admin],
    );
    if (owner.rowCount !== 1) throw new Error('Isolated administrator missing');
    const user = owner.rows[0].user_id;
    await pg.query(
      'INSERT INTO website(website_id,name,domain,user_id,created_at) VALUES ($1,$2,$3,$4,now())',
      [site, '102 synthetic acceptance ' + phase, HOST, user],
    );
    await pg.query(
      'INSERT INTO liekan_log_state(website_id,epoch,policy_revision,data_revision) VALUES ($1,1,1,1) ON CONFLICT DO NOTHING',
      [site],
    );
    await pg.query(
      'INSERT INTO liekan_collection_policy(website_id,allowed_hostnames,revision) VALUES ($1,$2,1) ON CONFLICT DO NOTHING',
      [site, [HOST]],
    );
    await pg.query(
      `INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state,credential_hash,credential_version,requested_policy_revision)
      VALUES ($1,$2,'server',$3,$4,$4,'active',$5,1,1)`,
      [source, site, HOST, user, hash],
    );
    await pg.query(
      "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES ($1,$2,$3,now()-interval '30 days')",
      [randomUUID(), site, source],
    );
    await pg.query(
      `INSERT INTO liekan_catalog(website_id,path,title,content_type,updated_at)
      SELECT $1,'/article/'||lpad(n::text,4,'0'),'102 synthetic','article',now()
      FROM generate_series(0,8191) n`,
      [site],
    );
    await pg.query('COMMIT');
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
  // Keep the seed inside rolling 24h and 7d HTTP windows throughout both timed runs.
  // The first hour contains traffic in its last 15 min. Later hours retain their full allocation.
  // Seven Asia/Shanghai calendar dates each have 25,900 PV and 24,000 UV.
  // Yesterday ends just before the rolling 24h cutoff. Today ends at anchor.
  const today = Math.floor((anchor + 8 * 3600000) / DAY) * DAY - 8 * 3600000;
  const firstOffset = Math.max(0, anchor - 7 * DAY + 45 * 60000 - (today - 6 * DAY));
  const params = { site, source, host: HOST, anchor, today, firstOffset, logCount: HISTORY.logs };
  const options = {
    query_params: params,
    clickhouse_settings: { max_insert_threads: '1', max_insert_block_size: '250000' },
  };
  await ch.command({
    ...options,
    query: `INSERT INTO ch_v2_logs
    (website_id,epoch,id,source_id,created_at,path,human_path,method,status,bytes,request_host,host_basis,
     content_type_state,content_type_value,source_config_version,source_interval_version,sampling_rate,
     recognition_state,is_unknown_crawler,bot,bot_type,ai_eligible,verification,_ver,_deleted)
    WITH intDiv(number * 24,{logCount:UInt64}) AS h, intDiv(number * 86400000,{logCount:UInt64}) % 3600000 AS within_hour,
      if(h=0,2700000 + intDiv(within_hour,4),within_hour) AS shifted,
      concat('/article/',leftPad(toString(number%8192),4,'0')) AS p
    SELECT {site:UUID},1,concat('seed-',toString(number)),{source:UUID},
      fromUnixTimestamp64Milli(toInt64({anchor:Int64}-86400000+h*3600000+shifted),'UTC'),p,p,'GET',
      if(number%50=0,404,200),1024,{host:String},'request_host','present','text/html','fixture','fixture',1,
      'recognized',number%5!=0,if(number%5=0,'GPTBot',''),if(number%5=0,'ai','other'),number%5=0,'unverified',1,0
    FROM numbers({logCount:UInt64})`,
  });
  await ch.command({
    ...options,
    query: `INSERT INTO ch_v2_browser_events
    (website_id,epoch,event_id,session_id,visit_id,created_at,received_at,session_created_at,event_type,url_path,
     hostname,normalized_hostname,origin_hostname,browser,collection_source,classification,quality_reasons,
     rule_version,is_eligible,identity_scope,identity_available,identity_version,has_observation,obs_version,
     obs_features,obs_mask,is_risk_flagged,_ver,_deleted)
    WITH intDiv(number,25900) AS d, number%25900 AS i,
      if(d IN (0,6),{firstOffset:Int64},0) AS offset_ms,
      if(d>=5,{anchor:Int64}-{today:Int64},86400000)-offset_ms AS duration_ms,
      fromUnixTimestamp64Milli(toInt64({today:Int64}-518400000+d*86400000+offset_ms+intDiv(i*duration_ms,25900)),'UTC') AS ts,
      (d*12000+i%24000)%96000 AS sid
    SELECT {site:UUID},1,reinterpretAsUUID(MD5(concat('e',toString(number)))),
      reinterpretAsUUID(MD5(concat('s',toString(sid)))),reinterpretAsUUID(MD5(concat('v',toString(d),'-',toString(sid)))),
      ts,ts,ts,1,concat('/article/',leftPad(toString(i%8192),4,'0')),{host:String},{host:String},{host:String},
      if(number%2=0,'chrome','safari'),'browser','browser',[],'fixture',true,'browser',true,'fixture',
      false,'','{}',0,false,1,0 FROM numbers(181300)`,
  });
  return { site, source, token };
}
