import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getCodexHome } from './file-ops.js';

export interface AnalysisRunRecord {
  timestamp: string;
  provider: string;
  model: string;
  baseUrl: string;
  status: 'ok' | 'failed';
  durationMs: number;
  httpStatus: number | null;
  error: string | null;
}

export interface AnalysisStats {
  provider: string;
  model: string;
  baseUrl: string;
  rpmLimit: number;
  concurrency: number;
  records: AnalysisRunRecord[];
  lastMinute: number;
  lastHour: number;
  successLastHour: number;
  failedLastHour: number;
}

export function getAnalysisLogPath(): string {
  return resolve(process.env.CURATOR_ANALYSIS_LOG || `${getCodexHome()}/session-curator-analysis.jsonl`);
}

export async function recordAnalysisRun(record: AnalysisRunRecord): Promise<void> {
  const path = getAnalysisLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readAnalysisRuns(limit = 120): Promise<AnalysisRunRecord[]> {
  let raw: string;
  try {
    raw = await readFile(getAnalysisLogPath(), 'utf8');
  } catch {
    return [];
  }

  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(500, limit)))
    .map((line) => {
      try {
        return JSON.parse(line) as AnalysisRunRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is AnalysisRunRecord => Boolean(record));
}
