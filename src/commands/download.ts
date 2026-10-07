/**
 * `gyazo download`: fetch the image bodies for the records already in the cache,
 * saving each as `<id>.<ext>` right next to its `<id>.json`.
 *
 * Gyazo may not stay up, and the JSON is only the description of a capture; this
 * is what keeps the capture itself. It works from the cache, not from Gyazo's
 * listing, so it needs no token, only the session cookie (i.gyazo.com answers
 * 503 to anyone without one). Where the files go follows GYAZO_CACHE_DIR, so
 * `GYAZO_CACHE_DIR=/big/disk/gyazo_data gyazo download` fills that tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { downloadImageBody, imageBodyCandidates } from '../api';
import { loadCookieHeader } from '../cookies';
import { formatBytes } from '../format';
import { parsePositiveIntegerOption } from '../options';
import { getCacheDir, planImageDownloads } from '../storage';

/** This many failures in a row means something systemic (expired cookies, a block), not bad luck. */
const MAX_CONSECUTIVE_FAILURES = 20;
const PROGRESS_EVERY = 200;

export function registerDownloadCommand(program: Command): void {
  program
    .command('download')
    .description('Download image files next to the cached JSON records (needs cookies)')
    .option('--jobs <number>', 'parallel downloads', '4')
    .option('--max <number>', 'stop after fetching this many images')
    .option('--year <yyyy>', 'only images created in this year')
    .option('--month <yyyy-mm>', 'only images created in this month')
    .option('--dry-run', 'count what would be fetched, fetch nothing')
    .option('--cookies <path>', 'gyazo.com cookies')
    .action(async (options) => {
      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: download needs gyazo.com cookies, which were not found.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }
      const jobs = Math.min(parsePositiveIntegerOption(options.jobs, '--jobs'), 16);
      const max = options.max ? parsePositiveIntegerOption(options.max, '--max') : undefined;
      if (options.year && options.month) {
        console.error('Error: use --year or --month, not both.');
        process.exit(1);
      }
      const prefix: string | undefined = options.month || options.year || undefined;

      const { present, items: planned } = planImageDownloads(prefix);
      const items = max ? planned.slice(0, max) : planned;
      const n = (v: number) => v.toLocaleString('en-US');

      if (options.dryRun) {
        const known = items.reduce((sum, item) => sum + (item.fileSize || 0), 0);
        const unknown = items.filter((item) => item.fileSize === null).length;
        console.log(
          `Dry run: ${n(items.length)} to download, ${n(present)} already present. ` +
            `Expected ${n(known)} bytes (${formatBytes(known)}), ${n(unknown)} of unknown size.`,
        );
        return;
      }

      let downloaded = 0;
      let bytes = 0;
      let gone = 0;
      let failed = 0;
      let consecutive = 0;
      let aborted = false;
      let finished = 0;
      const notes: string[] = [];

      const record = (id: string, reason: string) => notes.push(`${id}\t${reason}`);

      const handle = async (item: (typeof items)[number]) => {
        try {
          const result = await downloadImageBody({
            candidates: imageBodyCandidates(item.id, item.type, item.url),
            destBase: path.join(item.dir, item.id),
            ext: item.type,
            expectedBytes: item.fileSize,
            cookieHeader,
          });
          if (result.kind === 'ok') {
            downloaded += 1;
            bytes += result.bytes;
            consecutive = 0;
          } else if (result.kind === 'gone') {
            // Every URL answered 404: the body is not there to be had. Not a
            // failure of this run, but not silent either.
            gone += 1;
            record(item.id, 'gone');
          } else {
            failed += 1;
            consecutive += 1;
            record(item.id, `size mismatch: got ${result.got}, expected ${result.expected}`);
          }
        } catch (error: any) {
          failed += 1;
          consecutive += 1;
          record(item.id, (error?.message || 'error').replace(/\s+/g, ' '));
        }
        finished += 1;
        if (finished % PROGRESS_EVERY === 0) {
          process.stderr.write(
            `\r${n(finished)}/${n(items.length)}  downloaded ${n(downloaded)} (${formatBytes(bytes)}), ` +
              `gone ${n(gone)}, failed ${n(failed)}   `,
          );
        }
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) aborted = true;
      };

      let next = 0;
      const worker = async () => {
        while (!aborted) {
          const index = next++;
          if (index >= items.length) return;
          await handle(items[index]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(jobs, Math.max(items.length, 1)) }, worker));
      if (finished >= PROGRESS_EVERY) process.stderr.write('\n');

      const failuresFile = path.join(getCacheDir(), 'download-failed.tsv');
      if (notes.length > 0) fs.writeFileSync(failuresFile, notes.join('\n') + '\n', 'utf-8');
      else fs.rmSync(failuresFile, { force: true });

      console.log(
        `Downloaded ${n(downloaded)} (${formatBytes(bytes)}), ${n(present)} already present, ` +
          `${n(gone)} gone, ${n(failed)} failed.`,
      );
      if (notes.length > 0) console.log(`Details in ${failuresFile}`);
      if (aborted) {
        console.error(
          `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: the cookies may have ` +
            'expired, or Gyazo is refusing requests. Nothing partial was kept; run it again to resume.',
        );
        process.exit(1);
      }
      if (failed > 0) process.exit(1);
    });
}
