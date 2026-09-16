/**
 * What was decided about a capture, and where that is kept.
 *
 * Deliberately not under the cache: the cache holds copies of things Gyazo can
 * send again, and can be deleted to reclaim disk. A judgement cannot be
 * fetched again, so it lives in the state directory and survives `rm -rf
 * ~/.cache/gyazocli`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type Verdict = 'safe' | 'unsafe';

export interface TriageEntry {
  image_id: string;
  verdict: Verdict;
  at: string;
  query?: string;
}

export function getTriageLedgerPath(): string {
  const base =
    process.env.GYAZO_STATE_DIR ||
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), '.local', 'state');
  const dir = path.join(base, 'gyazocli');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'triage.jsonl');
}

export function loadTriageEntries(): TriageEntry[] {
  const file = getTriageLedgerPath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as TriageEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TriageEntry => entry !== null);
}

/** The latest verdict for each capture, since the file is append-only. */
export function loadTriageVerdicts(): Map<string, TriageEntry> {
  const byImage = new Map<string, TriageEntry>();
  for (const entry of loadTriageEntries()) {
    byImage.set(entry.image_id, entry);
  }
  return byImage;
}

export function appendTriageEntry(entry: TriageEntry): void {
  fs.appendFileSync(getTriageLedgerPath(), `${JSON.stringify(entry)}\n`, 'utf-8');
}
