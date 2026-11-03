import { crawlerTransaction } from '../upstream/crawler-access';
import { pauseRobotsForRestore } from '../upstream/robots-management';

// Run with application and workers stopped after restoring a database, before restarting services.
export async function pauseRestoredCrawlerControl() {
  return crawlerTransaction(async tx => {
    await tx.query('SELECT id FROM liekan_crawler_instance WHERE singleton=true FOR UPDATE');
    await tx.execute('UPDATE liekan_crawler_instance SET control_paused=true WHERE singleton=true');
    const cancelled = await tx.execute(
      "UPDATE liekan_crawler_deployment SET state='failed',error_code='restore-confirmation-required',completed_at=now(),updated_at=now(),lease_until=NULL WHERE state='queued' OR (state='running' AND target->>'mode'='adopt')",
    );
    const unknown = await tx.execute(
      "UPDATE liekan_crawler_deployment SET state='unknown',error_code='restore-readback-required',updated_at=now(),lease_until=NULL WHERE state='running'",
    );
    await tx.execute('UPDATE liekan_crawler_preview SET expires_at=LEAST(expires_at,now())');
    await pauseRobotsForRestore(tx);
    return { controlPaused: true, cancelled, unknown };
  });
}
