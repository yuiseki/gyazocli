/**
 * `gyazo touch <url...>`: cycle a public capture's access policy to bring it
 * back.
 *
 * After the 2026-09-11 incident some public images stopped being delivered.
 * Flipping one to only_me and back to anyone re-materialises it. This does that
 * cycle, leaving the capture public, so a Cosense page's embedded Gyazo images
 * can be restored. Pipe a list in from `cosensecli list-gyazo`.
 *
 * It refuses a capture that is already only_me: cycling that would end at
 * anyone and expose something meant to stay private.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import { getImageDetail, touchAccessPolicy } from '../api';
import { ensureAccessToken } from '../credentials';
import { loadCookieHeader } from '../cookies';
import { normalizeImageId } from '../ids';

/** Where the record of touched captures lives, unless --out says otherwise. */
function defaultLedgerPath(): string {
  const base =
    process.env.GYAZO_STATE_DIR ||
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'gyazocli', 'touched.txt');
}

/** The image IDs already recorded as touched, for skipping on a re-run. */
function loadTouched(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const ids = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => normalizeImageId(line.trim()))
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

export function registerTouchCommand(program: Command): void {
  program
    .command('touch [url...]')
    .description('Cycle a public capture only_me→anyone to restore it (needs cookies)')
    .option('--cookies <path>', 'gyazo.com cookies')
    .option('--out <path>', 'file to record touched captures in')
    .option('--again', 'touch even captures already recorded')
    .action(async (urls: string[], options) => {
      await ensureAccessToken();

      const inputs = [...(urls || []), ...(await collectFromStdin())];
      if (inputs.length === 0) {
        console.error('Error: no URLs given.');
        console.error('Hint: gyazo touch https://gyazo.com/<id>');
        console.error('      cosensecli list-gyazo | gyazo touch');
        process.exit(1);
      }

      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: touch needs gyazo.com cookies, which were not found.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }

      // A list from `cosensecli list-gyazo` is full of things that are not
      // captures: /search/... , /signup, other hosts. Those are noise, not
      // failures, so they are dropped before anything is attempted and never
      // reach the exit code. Duplicates (the same capture as a permalink and
      // as an i.gyazo.com URL) collapse to one.
      const seen = new Set<string>();
      const imageIds: string[] = [];
      let ignored = 0;
      for (const input of inputs) {
        const imageId = normalizeImageId(input);
        if (!imageId) {
          ignored++;
          continue;
        }
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        imageIds.push(imageId);
      }

      const ledgerPath = options.out || defaultLedgerPath();
      const alreadyDone = options.again ? new Set<string>() : loadTouched(ledgerPath);
      const skippedAsDone = imageIds.filter((id) => alreadyDone.has(id)).length;
      const todo = imageIds.filter((id) => !alreadyDone.has(id));

      if (todo.length === 0) {
        console.log(
          `Nothing to do: ${skippedAsDone} already touched, ${ignored} non-image URLs ignored.`,
        );
        return;
      }

      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

      let touched = 0;
      let failed = 0;
      for (const imageId of todo) {
        try {
          const image = await getImageDetail(imageId);
          // Never turn a deliberately private capture public.
          if (image?.access_policy === 'only_me') {
            console.error(`skip: ${imageId} is only_me; refusing to make it public`);
            failed++;
            continue;
          }
          await touchAccessPolicy(imageId, cookieHeader);
          const link = `https://gyazo.com/${imageId}`;
          // Recorded only after it actually succeeds, so the file is a list of
          // what is done, not what was attempted.
          fs.appendFileSync(ledgerPath, `${link}\n`, 'utf-8');
          console.log(`touched: ${link}`);
          touched++;
        } catch (error: any) {
          console.error(`failed: ${imageId}: ${error.message}`);
          failed++;
        }
      }

      console.log(
        `\n${touched} touched, ${failed} failed, ` +
          `${skippedAsDone} already done, ${ignored} ignored.`,
      );
      console.log(`Recorded in ${ledgerPath}`);
      // Only a real capture that could not be touched is an error; noise is not.
      if (failed > 0) process.exit(1);
    });
}
