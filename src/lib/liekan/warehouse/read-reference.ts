import { randomUUID } from 'node:crypto';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import type { ReadBoundary } from './read';

/** A report pins a publication while it reads. Expired ownership never silently
 * becomes a successful result: renewal failure aborts all associated queries. */
export class WarehouseReadReferences {
  private readonly owner = randomUUID();
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private renewing?: Promise<void>;
  private readonly sites = new Set<string>();
  private closed = false;
  readonly signal = this.controller.signal;
  constructor(
    private db: ControlDatabase,
    private seconds = 120,
  ) {}
  async pin(boundary: ReadBoundary) {
    if (this.closed || this.signal.aborted)
      throw new WarehouseConflict('warehouse-read-reference-lost');
    if (this.sites.has(boundary.websiteId)) return;
    await this.db.transaction(async tx => {
      const found = await tx.query(
        "SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1 AND epoch=$2 AND publication>=$3 AND deletion_revision=$4 AND state='active' FOR SHARE",
        [boundary.websiteId, boundary.epoch, boundary.publication, boundary.deletionRevision],
      );
      if (!found.rowCount) throw new WarehouseConflict('warehouse-read-boundary-changed');
      await tx.query(
        `INSERT INTO liekan_warehouse_reference(reference_id,website_id,epoch,publication,kind,owner_id,expires_at)
        VALUES($1,$2,$3,$4,'query',$5,clock_timestamp()+$6*interval '1 second')`,
        [
          randomUUID(),
          boundary.websiteId,
          boundary.epoch,
          boundary.publication,
          this.owner,
          this.seconds,
        ],
      );
    });
    this.sites.add(boundary.websiteId);
    this.schedule();
  }
  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.renewing = this.verify(true)
          .catch(() => this.controller.abort())
          .finally(() => {
            this.renewing = undefined;
            if (!this.signal.aborted) this.schedule();
          });
      },
      Math.max(1000, (this.seconds * 1000) / 4),
    );
    this.timer.unref();
  }
  async verify(renew = false) {
    if (this.signal.aborted) throw new WarehouseConflict('warehouse-read-reference-lost');
    if (!this.sites.size) return;
    const sites = [...this.sites];
    const rows = renew
      ? await this.db.read(
          `UPDATE liekan_warehouse_reference SET expires_at=clock_timestamp()+$2*interval '1 second'
      WHERE owner_id=$1 AND kind='query' AND website_id=ANY($3::uuid[]) AND expires_at>clock_timestamp() RETURNING reference_id`,
          [this.owner, this.seconds, sites],
        )
      : await this.db.read(
          "SELECT reference_id FROM liekan_warehouse_reference WHERE owner_id=$1 AND kind='query' AND website_id=ANY($2::uuid[]) AND expires_at>clock_timestamp()",
          [this.owner, sites],
        );
    if (rows.length !== sites.length) {
      this.controller.abort();
      throw new WarehouseConflict('warehouse-read-reference-lost');
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.renewing;
    if (this.sites.size)
      await this.db
        .read("DELETE FROM liekan_warehouse_reference WHERE owner_id=$1 AND kind='query'", [
          this.owner,
        ])
        .catch(() => {});
  }
}
