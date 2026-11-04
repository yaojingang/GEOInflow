// Container entry point: derive local migration DSNs without putting credentials
// in shell history, command arguments, status output or a copied URL.
import 'dotenv/config';
if (process.argv[2] && !['help', '--help', '-h'].includes(process.argv[2])) {
  if (!process.env.DATABASE_URL) throw new Error('warehouse-database-unavailable');
  process.env.LIEKAN_MIGRATION_ADMIN_URL ??= process.env.DATABASE_URL;
  if (!process.env.LIEKAN_MIGRATION_SOURCE_URL) {
    let source;
    try {
      source = new URL(process.env.DATABASE_URL);
    } catch {
      // Node's URL error includes its input, which may contain credentials.
      throw new Error('warehouse-invalid-database-url');
    }
    if (process.env.LIEKAN_MIGRATION_CLONE) {
      if (!/^liekan_snapshot_[a-z0-9_]+$/.test(process.env.LIEKAN_MIGRATION_CLONE))
        throw new Error('warehouse-invalid-clone-name');
      source.pathname = `/${process.env.LIEKAN_MIGRATION_CLONE}`;
    }
    process.env.LIEKAN_MIGRATION_SOURCE_URL = source.toString();
  }
}
await import('../dist/liekan-warehouse-command.mjs');
