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

      const { present, items: planned } = planImageDownloads(prefix, {
        withMp4: Boolean(options.mp4),
        cleanStale: !options.dryRun,
      });
      const items = max ? planned.slice(0, max) : planned;
      const n = (v: number) => v.toLocaleString('en-US');

      if (options.dryRun) {
        // A record's file_size is the size of its image/gif body, so it only counts
        // for the items that still need that body. An mp4 has no recorded size.
        const bodies = items.filter((item) => item.needBody);
        const known = bodies.reduce((sum, item) => sum + (item.fileSize || 0), 0);
        const unknown = bodies.filter((item) => item.fileSize === null).length;
        const mp4s = items.filter((item) => item.needMp4).length;
        console.log(
          `Dry run: ${n(items.length)} to download, ${n(present)} already present. ` +
            `Expected ${n(known)} bytes (${formatBytes(known)}), ${n(unknown)} of unknown size.` +
            (mp4s > 0 ? ` Plus ${n(mp4s)} mp4 file(s) of unknown size.` : ''),
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
      let lateSkipped = 0;
      let viaMp4 = 0;

      // Notes are written the moment they happen, not at the end: a run can last
      // hours, and the reasons should be readable while it goes, and survive it
      // being stopped. The file is only ever appended to, one section per run, so a
      // second run (a targeted slice beside the long batch) never wipes what the
      // other has recorded. Lines starting with # are the section headers.
      const failuresFile = path.join(getCacheDir(), 'download-report.tsv');
      fs.appendFileSync(
        failuresFile,
        `# ${new Date().toISOString()} download ${process.argv.slice(3).join(' ')} (pid ${process.pid})\n`,
        'utf-8',
      );
      const record = (id: string, reason: string) => {
        noted += 1;
        fs.appendFileSync(failuresFile, `${id}\t${reason}\n`, 'utf-8');
      };

      type Attempt = { outcome: 'ok' | 'gone' | 'failed'; goneNote?: string };

      /**
       * Fetch one file. An ok or a failure is counted here; a gone is only
       * reported back, since whether it is lost depends on what else the capture
       * has (a gif that 404s is fine if its mp4 is there).
       */
      const attempt = async (
        id: string,
        args: Parameters<typeof downloadImageBody>[0],
      ): Promise<Attempt> => {
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
            return { outcome: 'ok' };
          }
          if (result.kind === 'gone') return { outcome: 'gone' };
          failed += 1;
          consecutive += 1;
          record(id, `size mismatch: got ${result.got}, expected ${result.expected}`);
          return { outcome: 'failed' };
        } catch (error: any) {
          const reason = (error?.message || 'error').replace(/\s+/g, ' ');
          // A body that 5xxs through every retry is either an outage or a deleted
          // capture (Gyazo answers 503 for those, not 404). Its metadata says
          // which: still there means a real failure, a 404 means deleted.
          if (/HTTP 5\d\d/.test(reason) && (await captureMetadataMissing(id, cookieHeader))) {
            return { outcome: 'gone', goneNote: 'deleted: its metadata 404s too' };
          }
          failed += 1;
          consecutive += 1;
          record(id, reason);
          return { outcome: 'failed' };
        }
      };

      const markGone = (id: string, label: string, note?: string) => {
        gone += 1;
        record(id, `gone${label}${note ? ` (${note})` : ''}`);
      };

      const handle = async (item: (typeof items)[number]) => {
        const dest = path.join(item.dir, item.id);
        // Another run may have fetched it since the plan was made (the long batch
        // and a targeted slice overlap): look again just before asking Gyazo.
        if (item.needBody && item.type && fs.existsSync(`${dest}.${item.type}`)) {
          lateSkipped += 1;
          item = { ...item, needBody: false };
        }
        const haveMp4 = item.haveMp4 || fs.existsSync(`${dest}.mp4`);
        if (item.needMp4 && haveMp4) {
          lateSkipped += 1;
          item = { ...item, needMp4: false };
        }

        // The body first. A has_mp4 record's recorded file_size is no guide to
        // whether its gif exists, so the gif is always tried.
        let primary: Attempt | null = null;
        if (item.needBody) {
          primary = await attempt(item.id, {
            candidates: imageBodyCandidates(item.id, item.type, item.url),
            destBase: dest,
            ext: item.type,
            expectedBytes: item.fileSize,
            cookieHeader,
          });
        }

        // The mp4: as the derivative --mp4 asks for, or as the body itself when the
        // gif turned out not to exist.
        const standIn = primary?.outcome === 'gone' && item.hasMp4;
        let mp4: Attempt | null = null;
        if ((item.needMp4 || standIn) && !haveMp4) {
          // No file_size to check an mp4 against: the server's Content-Length has
          // to agree with what arrived, which downloadImageBody already insists on.
          mp4 = await attempt(item.id, {
            candidates: imageMp4Candidates(item.id, item.mp4Url),
            destBase: dest,
            ext: 'mp4',
            expectedBytes: null,
            cookieHeader,
          });
        }

        if (primary?.outcome === 'gone') {
          if (standIn && (haveMp4 || mp4?.outcome === 'ok')) {
            if (haveMp4 && !mp4) viaMp4 += 1; // settled by an mp4 already on disk
          } else if (standIn && mp4?.outcome === 'gone') {
            markGone(item.id, '', 'no gif and no mp4');
          } else if (!standIn) {
            markGone(item.id, '', primary.goneNote);
          }
          // (a stand-in mp4 that failed is already counted as a failure)
        }
        if (mp4?.outcome === 'gone' && primary?.outcome !== 'gone') {
          markGone(item.id, ' (mp4)', mp4.goneNote);
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


      console.log(
        `Downloaded ${n(downloaded)} (${formatBytes(bytes)}), ${n(present + lateSkipped + viaMp4)} already present, ` +
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
