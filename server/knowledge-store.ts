import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  KnowledgeItem,
  KnowledgeItemType,
  KnowledgeProposal,
  KnowledgeProposalApplyResult,
  KnowledgeProposalChange,
  KnowledgeProposalRiskClass,
  KnowledgeProposalStatus,
  KnowledgeSearchResult,
} from './types.js';

const KNOWLEDGE_TYPES = new Set<KnowledgeItemType>([
  'project',
  'preference',
  'service',
  'runbook',
  'decision',
  'session',
  'job',
  'commander_action',
  'note',
]);

type KnowledgeRow = {
  id: string;
  type: KnowledgeItemType;
  scope: string | null;
  title: string;
  text: string;
  project: string | null;
  repo: string | null;
  cwd: string | null;
  machine_id: string | null;
  tags_json: string;
  source: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};

type KnowledgeProposalRow = {
  id: string;
  local_id: string;
  status: KnowledgeProposalStatus;
  risk_class: KnowledgeProposalRiskClass;
  base_source_hash: string;
  reason: string;
  source_machine_id: string;
  source_session_id: string | null;
  changes_json: string;
  submitted_at: string;
  updated_at: string;
  apply_started_at: string | null;
  completed_at: string | null;
  rejected_reason: string | null;
  result_json: string | null;
  error: string | null;
};

export interface KnowledgeItemCreateInput {
  id?: string;
  type: KnowledgeItemType;
  scope?: string | null;
  title: string;
  text: string;
  project?: string | null;
  repo?: string | null;
  cwd?: string | null;
  machineId?: string | null;
  tags?: string[];
  source?: string | null;
  confidence?: number | null;
  lastVerifiedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type KnowledgeItemUpdateInput = Partial<Omit<KnowledgeItemCreateInput, 'id' | 'createdAt'>>;

export interface KnowledgeSearchInput {
  q?: string;
  type?: KnowledgeItemType | KnowledgeItemType[];
  project?: string;
  repo?: string;
  limit?: number;
}

export interface KnowledgeProposalCreateInput {
  id?: string;
  localId: string;
  riskClass: KnowledgeProposalRiskClass;
  baseSourceHash: string;
  reason: string;
  sourceMachineId: string;
  sourceSessionId?: string | null;
  changes: KnowledgeProposalChange[];
}

export interface KnowledgeProposalListInput {
  status?: KnowledgeProposalStatus;
  sourceMachineId?: string;
  limit?: number;
}

export function getKnowledgeDbPath(codexHome: string): string {
  return resolve(process.env.CURATOR_KNOWLEDGE_DB || join(codexHome, 'knowledge-index.sqlite'));
}

export function redactKnowledgeSecrets(value: string): string {
  return value.replace(/\b(?:sk|nvapi)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return redactKnowledgeSecrets(value.trim());
}

function cleanRequiredString(value: string, field: string): string {
  const clean = cleanString(value);
  if (!clean) throw new Error(`Knowledge item ${field} is required`);
  return clean;
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => cleanString(tag)).filter((tag): tag is string => Boolean(tag)))].slice(0, 100);
}

function assertKnowledgeType(type: KnowledgeItemType): void {
  if (!KNOWLEDGE_TYPES.has(type)) throw new Error(`Unsupported knowledge item type: ${type}`);
}

function cleanSearchTypes(type: KnowledgeItemType | KnowledgeItemType[] | undefined): KnowledgeItemType[] {
  const types = Array.isArray(type) ? type : type ? [type] : [];
  return [...new Set(types)].filter((item) => KNOWLEDGE_TYPES.has(item));
}

function rowToItem(row: KnowledgeRow): KnowledgeItem {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    tags = [];
  }

  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    title: row.title,
    text: row.text,
    project: row.project,
    repo: row.repo,
    cwd: row.cwd,
    machineId: row.machine_id,
    tags,
    source: row.source,
    confidence: row.confidence,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProposal(row: KnowledgeProposalRow): KnowledgeProposal {
  return {
    id: row.id,
    localId: row.local_id,
    status: row.status,
    riskClass: row.risk_class,
    baseSourceHash: row.base_source_hash,
    reason: row.reason,
    sourceMachineId: row.source_machine_id,
    sourceSessionId: row.source_session_id,
    changes: JSON.parse(row.changes_json) as KnowledgeProposalChange[],
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    applyStartedAt: row.apply_started_at,
    completedAt: row.completed_at,
    rejectedReason: row.rejected_reason,
    result: row.result_json ? JSON.parse(row.result_json) as KnowledgeProposalApplyResult : null,
    error: row.error,
  };
}

function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.trim().replace(/^"+|"+$/g, '').replace(/"/g, '""'))
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(' OR ');
}

export class KnowledgeStore {
  private db: DatabaseSync;
  private ftsAvailable = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  hasFts(): boolean {
    return this.ftsAvailable;
  }

  async createItem(input: KnowledgeItemCreateInput): Promise<KnowledgeItem> {
    assertKnowledgeType(input.type);
    const now = new Date().toISOString();
    const item: KnowledgeItem = {
      id: cleanRequiredString(input.id ?? randomUUID(), 'id'),
      type: input.type,
      scope: cleanString(input.scope),
      title: cleanRequiredString(input.title, 'title'),
      text: cleanRequiredString(input.text, 'text'),
      project: cleanString(input.project),
      repo: cleanString(input.repo),
      cwd: cleanString(input.cwd),
      machineId: cleanString(input.machineId),
      tags: cleanTags(input.tags),
      source: cleanString(input.source),
      confidence: typeof input.confidence === 'number' ? input.confidence : null,
      lastVerifiedAt: cleanString(input.lastVerifiedAt),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };

    this.db.exec('BEGIN');
    try {
      this.insertItem(item);
      this.upsertFts(item);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return item;
  }

  async updateItem(id: string, patch: KnowledgeItemUpdateInput): Promise<KnowledgeItem | null> {
    const existing = await this.getItem(id);
    if (!existing) return null;
    const next: KnowledgeItem = {
      ...existing,
      type: patch.type ?? existing.type,
      scope: patch.scope === undefined ? existing.scope : cleanString(patch.scope),
      title: patch.title === undefined ? existing.title : cleanRequiredString(patch.title, 'title'),
      text: patch.text === undefined ? existing.text : cleanRequiredString(patch.text, 'text'),
      project: patch.project === undefined ? existing.project : cleanString(patch.project),
      repo: patch.repo === undefined ? existing.repo : cleanString(patch.repo),
      cwd: patch.cwd === undefined ? existing.cwd : cleanString(patch.cwd),
      machineId: patch.machineId === undefined ? existing.machineId : cleanString(patch.machineId),
      tags: patch.tags === undefined ? existing.tags : cleanTags(patch.tags),
      source: patch.source === undefined ? existing.source : cleanString(patch.source),
      confidence: patch.confidence === undefined ? existing.confidence : patch.confidence,
      lastVerifiedAt: patch.lastVerifiedAt === undefined ? existing.lastVerifiedAt : cleanString(patch.lastVerifiedAt),
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    assertKnowledgeType(next.type);

    this.db.exec('BEGIN');
    try {
      this.updateStoredItem(next);
      this.upsertFts(next);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }

  async getItem(id: string): Promise<KnowledgeItem | null> {
    const row = this.db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as KnowledgeRow | undefined;
    return row ? rowToItem(row) : null;
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    const limit = input.limit ?? 20;
    const query = input.q?.trim() ?? '';
    if (this.ftsAvailable && query) return this.searchFts({ ...input, q: query, limit });
    return this.searchLike({ ...input, q: query, limit });
  }

  async createProposal(input: KnowledgeProposalCreateInput): Promise<KnowledgeProposal> {
    const now = new Date().toISOString();
    const proposal: KnowledgeProposal = {
      id: input.id ?? randomUUID(),
      localId: input.localId,
      status: 'pending',
      riskClass: input.riskClass,
      baseSourceHash: input.baseSourceHash,
      reason: input.reason,
      sourceMachineId: input.sourceMachineId,
      sourceSessionId: input.sourceSessionId ?? null,
      changes: input.changes,
      submittedAt: now,
      updatedAt: now,
      applyStartedAt: null,
      completedAt: null,
      rejectedReason: null,
      result: null,
      error: null,
    };
    this.db.prepare(
      `INSERT INTO knowledge_proposals (
        id, local_id, status, risk_class, base_source_hash, reason,
        source_machine_id, source_session_id, changes_json, submitted_at,
        updated_at, apply_started_at, completed_at, rejected_reason, result_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      proposal.id,
      proposal.localId,
      proposal.status,
      proposal.riskClass,
      proposal.baseSourceHash,
      proposal.reason,
      proposal.sourceMachineId,
      proposal.sourceSessionId,
      JSON.stringify(proposal.changes),
      proposal.submittedAt,
      proposal.updatedAt,
      proposal.applyStartedAt,
      proposal.completedAt,
      proposal.rejectedReason,
      null,
      proposal.error,
    );
    return proposal;
  }

  async getProposal(id: string): Promise<KnowledgeProposal | null> {
    const row = this.db.prepare('SELECT * FROM knowledge_proposals WHERE id = ?').get(id) as KnowledgeProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async getProposalBySourceLocalId(sourceMachineId: string, localId: string): Promise<KnowledgeProposal | null> {
    const row = this.db
      .prepare('SELECT * FROM knowledge_proposals WHERE source_machine_id = ? AND local_id = ?')
      .get(sourceMachineId, localId) as KnowledgeProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async listProposals(input: KnowledgeProposalListInput = {}): Promise<KnowledgeProposal[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.status) {
      where.push('status = ?');
      params.push(input.status);
    }
    if (input.sourceMachineId) {
      where.push('source_machine_id = ?');
      params.push(input.sourceMachineId);
    }
    params.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
    const rows = this.db.prepare(
      `SELECT * FROM knowledge_proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY submitted_at DESC LIMIT ?`
    ).all(...params) as KnowledgeProposalRow[];
    return rows.map(rowToProposal);
  }

  async claimProposalForApply(id: string): Promise<KnowledgeProposal | null> {
    const now = new Date().toISOString();
    const outcome = this.db.prepare(
      `UPDATE knowledge_proposals
       SET status = 'applying', apply_started_at = ?, updated_at = ?, completed_at = NULL,
           result_json = NULL, error = NULL
       WHERE id = ? AND status = 'pending'`
    ).run(now, now, id);
    if (Number(outcome.changes) !== 1) return null;
    return this.getProposal(id);
  }

  async finishProposalApply(
    id: string,
    status: Extract<KnowledgeProposalStatus, 'applied' | 'conflict' | 'failed'>,
    result: KnowledgeProposalApplyResult | null,
    error: string | null,
  ): Promise<KnowledgeProposal | null> {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE knowledge_proposals
       SET status = ?, result_json = ?, error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'applying'`
    ).run(status, result ? JSON.stringify(result) : null, error, now, now, id);
    return this.getProposal(id);
  }

  async rejectProposal(id: string, reason: string): Promise<KnowledgeProposal | null> {
    const now = new Date().toISOString();
    const outcome = this.db.prepare(
      `UPDATE knowledge_proposals
       SET status = 'rejected', rejected_reason = ?, completed_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status IN ('pending', 'conflict', 'failed')`
    ).run(reason, now, now, id);
    if (Number(outcome.changes) !== 1) return null;
    return this.getProposal(id);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        project TEXT,
        repo TEXT,
        cwd TEXT,
        machine_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source TEXT,
        confidence REAL,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_type ON knowledge_items(type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_project ON knowledge_items(project);
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_repo ON knowledge_items(repo);
      CREATE INDEX IF NOT EXISTS idx_knowledge_items_updated_at ON knowledge_items(updated_at);

      CREATE TABLE IF NOT EXISTS knowledge_proposals (
        id TEXT PRIMARY KEY,
        local_id TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        base_source_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_machine_id TEXT NOT NULL,
        source_session_id TEXT,
        changes_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        apply_started_at TEXT,
        completed_at TEXT,
        rejected_reason TEXT,
        result_json TEXT,
        error TEXT,
        UNIQUE(source_machine_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposals_status ON knowledge_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposals_submitted_at ON knowledge_proposals(submitted_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposals_source_machine ON knowledge_proposals(source_machine_id);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
          id UNINDEXED,
          title,
          text,
          tags,
          source
        );
      `);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private insertItem(item: KnowledgeItem): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_items (
          id, type, scope, title, text, project, repo, cwd, machine_id, tags_json,
          source, confidence, last_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.type,
        item.scope,
        item.title,
        item.text,
        item.project,
        item.repo,
        item.cwd,
        item.machineId,
        JSON.stringify(item.tags),
        item.source,
        item.confidence,
        item.lastVerifiedAt,
        item.createdAt,
        item.updatedAt
      );
  }

  private updateStoredItem(item: KnowledgeItem): void {
    this.db
      .prepare(
        `UPDATE knowledge_items SET
          type = ?, scope = ?, title = ?, text = ?, project = ?, repo = ?, cwd = ?,
          machine_id = ?, tags_json = ?, source = ?, confidence = ?, last_verified_at = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        item.type,
        item.scope,
        item.title,
        item.text,
        item.project,
        item.repo,
        item.cwd,
        item.machineId,
        JSON.stringify(item.tags),
        item.source,
        item.confidence,
        item.lastVerifiedAt,
        item.updatedAt,
        item.id
      );
  }

  private upsertFts(item: KnowledgeItem): void {
    if (!this.ftsAvailable) return;
    this.db.prepare('DELETE FROM knowledge_items_fts WHERE id = ?').run(item.id);
    this.db
      .prepare('INSERT INTO knowledge_items_fts (id, title, text, tags, source) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, item.title, item.text, item.tags.join(' '), item.source ?? '');
  }

  private searchFts(input: Required<Pick<KnowledgeSearchInput, 'q' | 'limit'>> & KnowledgeSearchInput): KnowledgeSearchResult[] {
    const where = ['knowledge_items_fts MATCH ?'];
    const params: Array<string | number> = [ftsQuery(input.q)];
    const types = cleanSearchTypes(input.type);
    if (types.length) {
      where.push(`knowledge_items.type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (input.project) {
      where.push('knowledge_items.project = ?');
      params.push(input.project);
    }
    if (input.repo) {
      where.push('knowledge_items.repo = ?');
      params.push(input.repo);
    }
    params.push(input.limit);

    const rows = this.db
      .prepare(
        `SELECT knowledge_items.*, bm25(knowledge_items_fts) AS rank
         FROM knowledge_items_fts
         JOIN knowledge_items ON knowledge_items.id = knowledge_items_fts.id
         WHERE ${where.join(' AND ')}
         ORDER BY rank, knowledge_items.updated_at DESC
         LIMIT ?`
      )
      .all(...params) as Array<KnowledgeRow & { rank: number }>;
    return rows.map((row) => ({
      score: row.rank < 0 ? -row.rank : 1 / (1 + row.rank),
      item: rowToItem(row),
    }));
  }

  private searchLike(input: Required<Pick<KnowledgeSearchInput, 'q' | 'limit'>> & KnowledgeSearchInput): KnowledgeSearchResult[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.q) {
      const like = `%${input.q.toLowerCase()}%`;
      where.push('(lower(title) LIKE ? OR lower(text) LIKE ? OR lower(tags_json) LIKE ? OR lower(source) LIKE ?)');
      params.push(like, like, like, like);
    }
    const types = cleanSearchTypes(input.type);
    if (types.length) {
      where.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (input.project) {
      where.push('project = ?');
      params.push(input.project);
    }
    if (input.repo) {
      where.push('repo = ?');
      params.push(input.repo);
    }
    params.push(input.limit);

    const rows = this.db
      .prepare(`SELECT * FROM knowledge_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as KnowledgeRow[];
    return rows.map((row) => ({ score: input.q ? 1 : 0, item: rowToItem(row) }));
  }
}
