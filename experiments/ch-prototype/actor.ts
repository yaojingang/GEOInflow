import { Prototype } from './core.ts';

const [run, command, arg] = process.argv.slice(2);
const p = new Prototype(run);
try {
  await p.connect();
  if (command === 'process') await p.process(await p.claim());
  else if (command === 'derive') await p.derive();
  else if (command === 'relay') await p.relay(arg ? Number(arg) : undefined);
  else if (command === 'delete') await p.activateDelete(arg);
  else if (command === 'close') await p.finalizeClose();
  else throw new Error('unknown prototype actor action');
} catch (error) {
  // Synthetic errors only; do not dump connection configuration.
  console.error(error instanceof Error ? error.message : 'actor failed');
  process.exitCode = 1;
} finally {
  await p.disconnect();
}
