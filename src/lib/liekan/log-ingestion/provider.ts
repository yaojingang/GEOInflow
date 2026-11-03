import { transaction, LiekanError } from '../upstream/server';
import { maintainCloudflare } from './cloudflare';

export async function maintainProvider(
  sourceId: string,
  action: 'configure' | 'disconnect' | 'health',
  workerId: string,
) {
  // A database lease also fences periodic reconciliation against queued retries and other workers.
  const claim = await transaction<any[]>(tx =>
    tx.$queryRawUnsafe(
      "UPDATE liekan_log_source SET provider_lease=$2::uuid,provider_lease_until=now()+interval '5 minutes',last_maintenance_at=now() WHERE id=$1::uuid AND (provider_lease_until IS NULL OR provider_lease_until<now()) RETURNING id",
      sourceId,
      workerId,
    ),
  );
  if (!claim.length) return;
  try {
    await maintainCloudflare(sourceId, action);
  } catch (error) {
    const code =
      error instanceof LiekanError &&
      ['provider-not-entitled', 'provider-permission-denied'].includes(error.code)
        ? error.code
        : error instanceof LiekanError && [401, 403, 404].includes(error.status)
          ? 'reauthorization-required'
          : error instanceof LiekanError && error.status === 409
            ? 'confirmation-required'
            : 'provider-unavailable';
    await transaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM website WHERE website_id=(SELECT website_id FROM liekan_log_source WHERE id=$1::uuid) FOR UPDATE',
        sourceId,
      );
      // Preserve a durable retry state; credentials are never included in diagnostics.
      await tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET error_code=$2 WHERE id=$1::uuid',
        sourceId,
        code,
      );
      if (
        [
          'reauthorization-required',
          'confirmation-required',
          'provider-not-entitled',
          'provider-permission-denied',
        ].includes(code)
      ) {
        const changed = await tx.$executeRawUnsafe(
          code === 'reauthorization-required'
            ? "UPDATE liekan_log_source SET state='error',credential_hash=NULL WHERE id=$1::uuid AND state!='disconnected' AND credential_hash IS NOT NULL"
            : "UPDATE liekan_log_source SET state='paused' WHERE id=$1::uuid AND state!='disconnected' AND credential_hash IS NOT NULL",
          sourceId,
        );
        const closed =
          changed &&
          (await tx.$executeRawUnsafe(
            'UPDATE liekan_log_interval SET ends_at=clock_timestamp() WHERE source_id=$1::uuid AND ends_at IS NULL',
            sourceId,
          ));
        if (closed)
          await tx.$executeRawUnsafe(
            'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=(SELECT website_id FROM liekan_log_source WHERE id=$1::uuid)',
            sourceId,
          );
      }
    });
    if (code === 'provider-unavailable') throw new Error('Provider temporarily unavailable');
  } finally {
    await transaction(tx =>
      tx.$executeRawUnsafe(
        'UPDATE liekan_log_source SET provider_lease=NULL,provider_lease_until=NULL WHERE id=$1::uuid AND provider_lease=$2::uuid',
        sourceId,
        workerId,
      ),
    );
  }
}
