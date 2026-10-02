/**
 * `gyazo restore <url...>`: resume distribution of pre-breach images.
 *
 * After the 2026-09-11 incident Gyazo set an incident-protection flag on
 * images uploaded before it, which stops them being delivered until the owner
 * confirms them. "配信を再開する" clears that flag. This does the same through
 * the internal endpoint, in batches, so a Cosense page's embedded Gyazo images
 * can be brought back from a `cosensecli list-gyazo` list in one pipe.
 *
 * The flag is separate from access_policy, so this never changes a capture's
 * public/private setting: a capture made only_me on purpose stays only_me.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import { csrfTokenForRun, resumeDistribution } from '../api';
import { ensureAccessToken } from '../credentials';
import { loadCookieHeader } from '../cookies';
import { normalizeImageId } from '../ids';
import { parsePositiveIntegerOption } from '../options';

function stateFile(name: string): string {
  const base =
    process.env.GYAZO_STATE_DIR ||
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'gyazocli', name);
}

function loadRecordedIds(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const ids = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => normalizeImageId(line.split('\t')[0].trim()))
    .filter((id): id is string => Boolean(id));
  return new Set(ids);
}

async function collectFromStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const lines: string[] = [];
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore [url...]')
    .description('Resume distribution of incident-protected captures (needs cookies)')
    .option('--cookies <path>', 'gyazo.com cookies')
    .option('--out <path>', 'file to record restored captures in')
    .option('--failed <path>', 'file to record failures in')
    .option('--batch-size <number>', 'image ids per request', '50')
    .option('--again', 'restore even captures already recorded')
    .action(async (urls: string[], options) => {
      await ensureAccessToken();

      const inputs = [...(urls || []), ...(await collectFromStdin())];
      if (inputs.length === 0) {
        console.error('Error: no URLs given.');
        console.error('Hint: cosensecli list-gyazo | gyazo restore');
        process.exit(1);
      }

      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: restore needs gyazo.com cookies, which were not found.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }

      const batchSize = parsePositiveIntegerOption(options.batchSize, '--batch-size');
      const outPath = options.out || stateFile('restored.txt');
      const failedPath = options.failed || stateFile('restore-failed.txt');

      // Noise (/search, /signup, other hosts) is dropped, not failed.
      // Duplicates collapse by image ID.
      const seen = new Set<string>();
      let ignored = 0;
      const ids: string[] = [];
      for (const input of inputs) {
        const imageId = normalizeImageId(input);
        if (!imageId) { ignored++; continue; }
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        ids.push(imageId);
      }

      const done = options.again ? new Set<string>() : loadRecordedIds(outPath);
      const skipped = ids.filter((id) => done.has(id)).length;
      const todo = ids.filter((id) => !done.has(id));

      if (todo.length === 0) {
        console.log(`Nothing to do: ${skipped} already done, ${ignored} non-image URLs ignored.`);
        return;
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.mkdirSync(path.dirname(failedPath), { recursive: true });

      let token: string;
      try {
        token = await csrfTokenForRun(cookieHeader);
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }

      let restored = 0;
      let failed = 0;
      for (const batch of chunk(todo, batchSize)) {
        try {
          await resumeDistribution(batch, cookieHeader, token);
          for (const id of batch) {
            fs.appendFileSync(outPath, `https://gyazo.com/${id}\n`, 'utf-8');
          }
          restored += batch.length;
          console.log(`restored ${batch.length}: ${batch[0].slice(0, 8)}...`);
        } catch (error: any) {
          const reason = (error.message || 'error').replace(/\s+/g, ' ');
          for (const id of batch) {
            fs.appendFileSync(failedPath, `https://gyazo.com/${id}\t${reason}\n`, 'utf-8');
          }
          failed += batch.length;
          console.error(`failed ${batch.length}: ${error.message}`);
        }
      }

      console.log(`\n${restored} restored, ${failed} failed, ${skipped} already done, ${ignored} ignored.`);
      console.log(`Restored recorded in ${outPath}`);
      if (failed > 0) {
        console.log(`Failures recorded in ${failedPath}`);
        process.exit(1);
      }
    });
}
