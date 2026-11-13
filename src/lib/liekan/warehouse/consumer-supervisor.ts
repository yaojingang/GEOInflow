import type { WarehouseConsumer } from './consumer';
import { WarehouseConflict } from './control-db';

type Authority = 'postgres' | 'clickhouse';

// Called serially by the worker's bounded health loop. KafkaJS retries only
// retriable errors; a fencing/control exception needs a fresh consumer even
// when the persisted authority and revision have not changed.
export class WarehouseConsumerSupervisor {
  private worker?: WarehouseConsumer;
  private mode?: string;
  private revision?: string;

  constructor(
    private readonly installation: () => Promise<
      { authority: string; revision: string } | undefined
    >,
    private readonly create: (authority: Authority) => WarehouseConsumer,
    private readonly verify: () => Promise<unknown>,
  ) {}

  get authority() {
    return this.mode;
  }

  isOperational() {
    return this.mode === 'frozen' || Boolean(this.worker?.isOperational());
  }

  async refresh() {
    const installation = await this.installation();
    if (!installation) throw new WarehouseConflict('warehouse-installation-unavailable');
    if (
      this.mode === installation.authority &&
      this.revision === installation.revision &&
      !this.worker?.needsRestart()
    )
      return;
    await this.close();
    if (!['postgres', 'clickhouse', 'frozen'].includes(installation.authority))
      throw new WarehouseConflict('warehouse-invalid-authority');
    if (installation.authority !== 'frozen') {
      if (installation.authority === 'clickhouse') await this.verify();
      this.worker = this.create(installation.authority as Authority);
      await this.worker.start();
    }
    this.mode = installation.authority;
    this.revision = installation.revision;
  }

  async close() {
    await this.worker?.close();
    this.worker = undefined;
    this.mode = undefined;
    this.revision = undefined;
  }
}
