import { createDatabasePool, createDb } from './db';
import { repairChatAliases } from './chatIdentity';

/** Maintenance command: previews by default; writes require explicit offline confirmation. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[args.indexOf('--instance') + 1];
  const apply = args.includes('--apply');
  if (!args.includes('--instance') || !name || name.startsWith('--') ||
      args.some((arg, index) => !['--instance', '--apply', '--dry-run', '--offline'].includes(arg) && args[index - 1] !== '--instance') ||
      (apply && (!args.includes('--offline') || args.includes('--dry-run')))) {
    throw new Error('Usage: repairChatAliases --instance NAME [--dry-run | --apply --offline]. Stop all writers before --apply.');
  }
  const pool = createDatabasePool();
  try {
    const db = createDb(pool);
    const instance = await db.instanceRecord.findUnique({ where: { name }, select: { id: true } });
    if (!instance) throw new Error('Instance not found');
    const plans = await repairChatAliases(db, instance.id, apply);
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', instance: name, plans }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Chat identity repair failed');
  process.exitCode = 1;
});
