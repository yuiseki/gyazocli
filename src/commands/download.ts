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
import { captureMetadataMissing, downloadImageBody, imageBodyCandidates, imageMp4Candidates } from '../api';
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
    .option('--mp4', 'also fetch the mp4 of a gif that has one (a video-only capture always gets its mp4)')
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

      const { present, items: planned } = planImageDownloads(prefix, { withMp4: Boolean(options.mp4) });
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
      let differs = 0;
      let consecutive = 0;
      let aborted = false;
      let finished = 0;
      let noted = 0;

      // Failures are written the moment they happen, not at the end: a run can
      // last hours, and the reasons should be readable while it goes, and survive
      // it being stopped.
      const failuresFile = path.join(getCacheDir(), 'download-report.tsv');
      fs.writeFileSync(failuresFile, '', 'utf-8');
      const record = (id: string, reason: string) => {
        noted += 1;
        fs.appendFileSync(failuresFile, `${id}\t${reason}\n`, 'utf-8');
      };

      /** Fetch one file and fold its outcome into the counters. */
      const fetchOne = async (
        id: string,
        label: string,
        args: Parameters<typeof downloadImageBody>[0],
      ): Promise<'ok' | 'gone' | 'failed'> => {
        try {
          const result = await downloadImageBody(args);
          if (result.kind === 'ok') {
            downloaded += 1;
            bytes += result.bytes;
            consecutive = 0;
            if (result.sizeDiffers) {
              // Kept: the transfer was whole. But say so, since it is not what
              // the record promised.
              differs += 1;
              record(id, `size differs from file_size: got ${result.bytes}, file_size ${result.sizeDiffers.expected} (kept)`);
            }
            return 'ok';
          }
          if (result.kind === 'gone') {
            // Every URL answered 404: the body is not there to be had. Not a
            // failure of this run, but not silent either.
            gone += 1;
            record(id, `gone${label}`);
            return 'gone';
          }
          failed += 1;
          consecutive += 1;
          record(id, `size mismatch: got ${result.got}, expected ${result.expected}`);
          return 'failed';
        } catch (error: any) {
          const reason = (error?.message || 'error').replace(/\s+/g, ' ');
          // A body that 5xxs through every retry is either an outage or a deleted
          // capture (Gyazo answers 503 for those, not 404). Its metadata says
          // which: still there means a real failure, a 404 means deleted.
          if (/HTTP 5\d\d/.test(reason) && (await captureMetadataMissing(id, cookieHeader))) {
            gone += 1;
            record(id, `gone${label} (deleted: its metadata 404s too)`);
            return 'gone';
          }
          failed += 1;
          consecutive += 1;
          record(id, reason);
          return 'failed';
        }
      };

      const handle = async (item: (typeof items)[number]) => {
        if (item.needBody) {
          await fetchOne(item.id, '', {
            candidates: imageBodyCandidates(item.id, item.type, item.url),
            destBase: path.join(item.dir, item.id),
            ext: item.type,
            expectedBytes: item.fileSize,
            cookieHeader,
          });
        }
        if (item.needMp4) {
          // No file_size to check an mp4 against: the server's Content-Length has
          // to agree with what arrived, which downloadImageBody already insists on.
          await fetchOne(item.id, ' (mp4)', {
            candidates: imageMp4Candidates(item.id, item.mp4Url),
            destBase: path.join(item.dir, item.id),
            ext: 'mp4',
            expectedBytes: null,
            cookieHeader,
          });
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

      if (noted === 0) fs.rmSync(failuresFile, { force: true });

      console.log(
        `Downloaded ${n(downloaded)} (${formatBytes(bytes)}), ${n(present)} already present, ` +
          `${n(gone)} gone, ${n(failed)} failed.` +
          (differs > 0 ? ` ${n(differs)} differ from the recorded file_size (kept).` : ''),
      );
      if (noted > 0) console.log(`Details in ${failuresFile}`);
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
