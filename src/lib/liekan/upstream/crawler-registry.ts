import { randomUUID } from 'node:crypto';
import { ROLES } from '@/lib/constants';
import { aiTransaction, type AiTx } from './ai-db';
import { crawlerTransaction, type CrawlerActor } from './crawler-access';
import { LiekanError } from './errors';
import { query } from './server';
import { getBundledPublishedCatalog } from '../crawlers/catalog-seed';
import {
  catalogHash,
  CatalogValidationError,
  freezeCatalog,
  mergeCatalogSeed,
  previewCatalog,
  rollbackCatalog,
  validateCatalog,
} from '../crawlers/catalog-validation';
import {
  crawlerRegistryCommandSchema,
  crawlerRegistryCommandResponseSchema,
  registryDraftSchema,
  registryVersionSummarySchema,
  registryPreviewSchema,
  publishedCatalogSchema,
  type CatalogPayload,
  type PublishedCatalog,
  type CrawlerRegistryCommand,
  type CrawlerRegistryCommandResponse,
  type CrawlerRegistryResponse,
  type RegistryDraft,
} from '../contracts/crawler-registry';

export const CRAWLER_REGISTRY_CURRENT_TABLE = 'liekan_crawler_registry_current';
type Row = Record<string, any>;
const json = (value: unknown) => JSON.stringify(value);
const iso = (value: string | Date) => new Date(value).toISOString();
const conflict = (message = '目录版本已改变，请重新读取并预览') => new LiekanError(message, 409);

export function registryCatalogFromRow(row: Row): PublishedCatalog {
  const payload = validateCatalog(row.payload);
  if (catalogHash(payload) !== row.content_hash)
    throw new Error('Crawler catalog content hash mismatch');
  return freezeCatalog(
    publishedCatalogSchema.parse({
      version: row.version,
      revision: String(row.revision),
      contentHash: row.content_hash,
      publishedAt: iso(row.published_at),
      payload,
      state: 'published',
    }),
  );
}
function draftFromRow(row: Row): RegistryDraft {
  return registryDraftSchema.parse({
    id: row.id,
    title: row.title,
    revision: String(row.revision),
    baseVersion: row.base_version,
    baseRevision: String(row.base_revision),
    status: row.status,
    payload: row.payload,
    conflicts: row.conflicts,
    preview: row.preview,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}
async function authorize(tx: AiTx, actor: CrawlerActor, admin: boolean) {
  const [live] = await tx.query(
    'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
    actor.id,
  );
  if (!live) throw new LiekanError('当前登录已失效', 401);
  if (admin && live.role !== ROLES.admin) throw new LiekanError('此操作需要平台管理员权限', 403);
}

async function initialize(tx: AiTx) {
  // Serializes initial creation and software-seed upgrades before a pointer exists.
  await tx.query(
    "SELECT true AS acquired FROM pg_advisory_xact_lock(hashtextextended('liekan-crawler-registry-initialize',0))",
  );
  const seed = getBundledPublishedCatalog();
  const [pointer] = await tx.query(
    'SELECT * FROM liekan_crawler_registry_current WHERE id=1 FOR UPDATE',
  );
  if (!pointer) {
    await tx.execute(
      `INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action,published_at)
      VALUES($1::uuid,1,$2,$3::jsonb,'seed',$4::timestamptz)`,
      seed.version,
      seed.contentHash,
      json(seed.payload),
      seed.publishedAt,
    );
    await tx.execute(
      `INSERT INTO liekan_crawler_registry_current(id,version,revision,seed_hash,seed_payload)
      VALUES(1,$1::uuid,1,$2,$3::jsonb)`,
      seed.version,
      seed.contentHash,
      json(seed.payload),
    );
    return;
  }
  if (pointer.seed_hash === seed.contentHash) return;
  const [current] = await tx.query(
    'SELECT payload FROM liekan_crawler_registry_version WHERE version=$1::uuid',
    pointer.version,
  );
  const merged = mergeCatalogSeed(
    validateCatalog(pointer.seed_payload),
    validateCatalog(current.payload),
    seed.payload,
  );
  // Seed candidates may contain explicit field conflicts and require an administrator's update/preview.
  try {
    validateCatalog(merged.payload, current.payload);
  } catch (error) {
    if (!(error instanceof CatalogValidationError)) throw error;
    merged.conflicts.push(...error.issues);
  }
  await tx.execute(
    `INSERT INTO liekan_crawler_registry_draft(id,title,base_version,base_revision,payload,conflicts,seed_hash,seed_payload)
    VALUES($1::uuid,$2,$3::uuid,$4::bigint,$5::jsonb,$6::jsonb,$7,$8::jsonb) ON CONFLICT(seed_hash) DO NOTHING`,
    randomUUID(),
    'Software catalog update',
    pointer.version,
    String(pointer.revision),
    json(merged.payload),
    json(merged.conflicts),
    seed.contentHash,
    json(seed.payload),
  );
}
/** Initial seed is published once. Later software seeds only create durable pending drafts. */
export async function initializeCrawlerRegistry() {
  return aiTransaction(initialize, { timeout: 15000 });
}
export async function registryVersionIsCurrent(tx: AiTx, version: string): Promise<boolean> {
  const [pointer] = await tx.query(
    'SELECT version FROM liekan_crawler_registry_current WHERE id=1 FOR SHARE',
  );
  return pointer?.version === version;
}
export async function readCrawlerRegistryPointer(): Promise<{ version: string; revision: string }> {
  const [row] = await query(
    'SELECT version,revision FROM liekan_crawler_registry_current WHERE id=1',
  );
  if (!row) throw new LiekanError('目录版本不存在', 404);
  return { version: row.version, revision: String(row.revision) };
}
export async function readPublishedRegistry(version?: string): Promise<PublishedCatalog> {
  return aiTransaction(
    async tx => {
      const [row] = version
        ? await tx.query(
            'SELECT * FROM liekan_crawler_registry_version WHERE version=$1::uuid',
            version,
          )
        : await tx.query(`SELECT v.* FROM liekan_crawler_registry_current c
          JOIN liekan_crawler_registry_version v ON v.version=c.version AND v.revision=c.revision WHERE c.id=1`);
      if (!row) throw new LiekanError('目录版本不存在', 404);
      return registryCatalogFromRow(row);
    },
    { readOnly: true },
  );
}
export async function crawlerRegistry(actor: CrawlerActor): Promise<CrawlerRegistryResponse> {
  return crawlerTransaction(
    async tx => {
      await authorize(tx, actor, true);
      const [current] = await tx.query(`SELECT v.* FROM liekan_crawler_registry_current c
      JOIN liekan_crawler_registry_version v ON v.version=c.version AND v.revision=c.revision WHERE c.id=1`);
      if (!current) throw new LiekanError('目录正在初始化', 503);
      const drafts = await tx.query(
        "SELECT * FROM liekan_crawler_registry_draft WHERE status='draft' ORDER BY updated_at DESC,id LIMIT 50",
      );
      const history = await tx.query(
        'SELECT version,revision,content_hash,published_at,actor_id,action FROM liekan_crawler_registry_version ORDER BY revision DESC LIMIT 100',
      );
      return {
        current: registryCatalogFromRow(current),
        drafts: drafts.map(draftFromRow),
        history: history.map(row =>
          registryVersionSummarySchema.parse({
            version: row.version,
            revision: String(row.revision),
            contentHash: row.content_hash,
            publishedAt: iso(row.published_at),
            actorId: row.actor_id,
            action: row.action,
          }),
        ),
      };
    },
    { repeatableRead: true },
  );
}
export async function authorizeCrawlerRegistryReader(actor: CrawlerActor) {
  return crawlerTransaction(tx => authorize(tx, actor, false));
}

/** All commands share pointer serialization and an immutable operation receipt. */
export async function executeCrawlerRegistryCommand(
  tx: AiTx,
  actor: CrawlerActor,
  command: CrawlerRegistryCommand,
): Promise<CrawlerRegistryCommandResponse> {
  await authorize(tx, actor, true);
  const fingerprint = catalogHash({ actorId: actor.id, command });
  const [pointer] = await tx.query(
    'SELECT * FROM liekan_crawler_registry_current WHERE id=1 FOR UPDATE',
  );
  if (!pointer) throw new LiekanError('目录正在初始化', 503);
  const [receipt] = await tx.query(
    'SELECT fingerprint,response FROM liekan_crawler_registry_operation WHERE operation_id=$1::uuid',
    command.operationId,
  );
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw conflict('操作标识已用于不同的请求');
    return crawlerRegistryCommandResponseSchema.parse(receipt.response);
  }
  const [currentRow] = await tx.query(
    'SELECT * FROM liekan_crawler_registry_version WHERE version=$1::uuid',
    pointer.version,
  );
  const current = registryCatalogFromRow(currentRow);
  let response: CrawlerRegistryCommandResponse;
  if (command.action === 'createDraft' || command.action === 'rollbackDraft') {
    const sourceVersion = command.sourceVersion ?? current.version;
    const [source] = await tx.query(
      'SELECT * FROM liekan_crawler_registry_version WHERE version=$1::uuid',
      sourceVersion,
    );
    if (!source) throw new LiekanError('目录版本不存在', 404);
    const payload = rollbackCatalog(registryCatalogFromRow(source).payload, current.payload);
    const conflicts: string[] = [];
    try {
      validateCatalog(payload, current.payload);
    } catch (error) {
      if (!(error instanceof CatalogValidationError)) throw error;
      conflicts.push(...error.issues);
    }
    const [row] = await tx.query(
      `INSERT INTO liekan_crawler_registry_draft(id,title,base_version,base_revision,payload,source_action,source_version,created_by,updated_by,conflicts)
      VALUES($1::uuid,$2,$3::uuid,$4::bigint,$5::jsonb,$6,$7::uuid,$8::uuid,$8::uuid,$9::jsonb) RETURNING *`,
      randomUUID(),
      command.title ?? (command.action === 'rollbackDraft' ? 'Rollback catalog' : 'Catalog draft'),
      current.version,
      current.revision,
      json(payload),
      command.action === 'rollbackDraft' ? 'rollback' : 'publish',
      sourceVersion,
      actor.id,
      json(conflicts),
    );
    response = { action: command.action, draft: draftFromRow(row) };
  } else {
    let [draft] = await tx.query(
      'SELECT * FROM liekan_crawler_registry_draft WHERE id=$1::uuid FOR UPDATE',
      command.draftId,
    );
    if (!draft) throw new LiekanError('目录草稿不存在', 404);
    if (draft.status !== 'draft' || String(draft.revision) !== command.expectedDraftRevision)
      throw conflict('草稿已改变，请重新读取');
    const staleBase =
      draft.base_version !== current.version || String(draft.base_revision) !== current.revision;
    if (staleBase && (command.action !== 'preview' || draft.source_action === 'rollback'))
      throw new LiekanError(
        draft.source_action === 'rollback'
          ? '发布目录已变化，请创建新的回滚草稿。'
          : '发布目录已变化，请先重新生成预览以合并最新版本。',
        409,
        'crawler-draft-base-changed',
      );
    if (command.action === 'updateDraft') {
      const payload = validateCatalog(command.payload, current.payload);
      const [row] = await tx.query(
        `UPDATE liekan_crawler_registry_draft SET payload=$2::jsonb,revision=revision+1,
        preview=NULL,conflicts='[]'::jsonb,updated_by=$3::uuid,updated_at=clock_timestamp() WHERE id=$1::uuid RETURNING *`,
        draft.id,
        json(payload),
        actor.id,
      );
      response = { action: command.action, draft: draftFromRow(row) };
    } else if (command.action === 'preview') {
      let validRebase = true;
      if (staleBase) {
        const [base] = await tx.query(
          'SELECT * FROM liekan_crawler_registry_version WHERE version=$1::uuid',
          draft.base_version,
        );
        if (!base) throw conflict('草稿基线暂不可用');
        const merged = mergeCatalogSeed(
          registryCatalogFromRow(base).payload,
          draft.payload,
          current.payload,
        );
        const conflicts = [...draft.conflicts, ...merged.conflicts];
        try {
          validateCatalog(merged.payload, current.payload);
        } catch (error) {
          if (!(error instanceof CatalogValidationError)) throw error;
          conflicts.push(...error.issues);
          validRebase = false;
        }
        // Keep seed adoption metadata and draft edits while moving only the review baseline.
        [draft] = await tx.query(
          `UPDATE liekan_crawler_registry_draft SET payload=$2::jsonb,conflicts=$3::jsonb,
          base_version=$4::uuid,base_revision=$5::bigint,revision=revision+1,preview=NULL,
          updated_by=$6::uuid,updated_at=clock_timestamp() WHERE id=$1::uuid RETURNING *`,
          draft.id,
          json(merged.payload),
          json([...new Set(conflicts)]),
          current.version,
          current.revision,
          actor.id,
        );
      }
      if (!validRebase) {
        response = { action: command.action, draft: draftFromRow(draft) };
      } else {
        const preview = previewCatalog(
          current.payload,
          draft.payload,
          current.revision,
          String(draft.revision),
          command.samples?.map(sample => ({ ...sample, expectedId: sample.expectedId ?? null })),
        );
        preview.conflicts.push(...draft.conflicts);
        const { hash: ignored, ...content } = preview;
        preview.hash = catalogHash(content);
        const [row] = await tx.query(
          `UPDATE liekan_crawler_registry_draft SET preview=$2::jsonb,updated_by=$3::uuid,
        updated_at=clock_timestamp() WHERE id=$1::uuid RETURNING *`,
          draft.id,
          json(preview),
          actor.id,
        );
        response = { action: command.action, draft: draftFromRow(row), preview };
      }
    } else {
      if (current.revision !== command.expectedCurrentRevision) throw conflict();
      const preview = registryPreviewSchema.safeParse(draft.preview);
      if (
        !preview.success ||
        preview.data.hash !== command.previewHash ||
        preview.data.currentRevision !== current.revision ||
        preview.data.draftRevision !== String(draft.revision) ||
        preview.data.conflicts.length ||
        draft.conflicts.length
      )
        throw conflict('预览已失效或仍有冲突');
      const payload = validateCatalog(draft.payload, current.payload);
      const recomputed = previewCatalog(
        current.payload,
        payload,
        current.revision,
        String(draft.revision),
        preview.data.samples.map(({ userAgent, expectedId }) => ({ userAgent, expectedId })),
      );
      if (
        recomputed.hash !== preview.data.hash ||
        recomputed.contentHash !== preview.data.contentHash
      )
        throw conflict('预览内容已改变');
      const version = randomUUID();
      const revision = (BigInt(current.revision) + 1n).toString();
      const [published] = await tx.query(
        `INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,actor_id,action,operation_id,source_version)
        VALUES($1::uuid,$2::bigint,$3,$4::jsonb,$5::uuid,$6,$7::uuid,$8::uuid) RETURNING *`,
        version,
        revision,
        recomputed.contentHash,
        json(payload),
        actor.id,
        draft.source_action,
        command.operationId,
        draft.source_version,
      );
      await tx.execute(
        'UPDATE liekan_crawler_registry_current SET version=$1::uuid,revision=$2::bigint WHERE id=1',
        version,
        revision,
      );
      await tx.execute(
        "UPDATE liekan_crawler_registry_draft SET status='published',updated_by=$2::uuid,updated_at=clock_timestamp() WHERE id=$1::uuid",
        draft.id,
        actor.id,
      );
      if (draft.seed_hash && draft.seed_payload)
        await tx.execute(
          'UPDATE liekan_crawler_registry_current SET seed_hash=$1,seed_payload=$2::jsonb WHERE id=1',
          draft.seed_hash,
          json(draft.seed_payload),
        );
      response = { action: command.action, current: registryCatalogFromRow(published) };
    }
  }
  await tx.execute(
    `INSERT INTO liekan_crawler_registry_operation(operation_id,actor_id,action,fingerprint,response)
    VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb)`,
    command.operationId,
    actor.id,
    command.action,
    fingerprint,
    json(response),
  );
  return response;
}
export async function mutateCrawlerRegistry(actor: CrawlerActor, input: unknown) {
  const command = crawlerRegistryCommandSchema.safeParse(input);
  if (!command.success) throw new LiekanError('目录请求格式无效', 400);
  try {
    return await crawlerTransaction(tx => executeCrawlerRegistryCommand(tx, actor, command.data), {
      timeout: 15000,
    });
  } catch (error) {
    if (error instanceof CatalogValidationError)
      throw new LiekanError(`目录校验失败：${error.message}`, 400);
    throw error;
  }
}
