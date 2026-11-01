import { lockRobotsState, type RobotsStateTransaction } from './robots-draft';

export async function invalidateRobotsWebsite(tx: RobotsStateTransaction, websiteId: string) {
  const [available] = (await tx.$queryRawUnsafe(
    "SELECT to_regclass('liekan_robots_state') IS NOT NULL AS present",
  )) as { present: boolean }[];
  if (!available?.present || !(await lockRobotsState(tx, websiteId)).length) return;
  // Preserve the binding identity and credential hash for late read-only evidence and receipts.
  await tx.$executeRawUnsafe(
    'UPDATE liekan_robots_state SET agent_enabled=false,agent_context=NULL,pair_hash=NULL,pair_expires=NULL,pair_actor=NULL,pair_context=NULL,monitor=false,monitor_actor=NULL,context=NULL,hostname=NULL,check_lease=NULL,checking_until=NULL WHERE website_id=$1::uuid',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_robots_deployment SET state='cancelled',error_code='website-changed' WHERE website_id=$1::uuid AND state IN ('preview','queued')",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_robots_deployment SET state='unknown',error_code='website-changed',lease_until=now() WHERE website_id=$1::uuid AND state='leased'",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_robots_deployment SET state='verification_failed',error_code='authority-changed',verify_after=NULL WHERE website_id=$1::uuid AND state='applied'",
    websiteId,
  );
}
