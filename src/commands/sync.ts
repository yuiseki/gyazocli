/**
 * The `sync` command, which fills the cache.
 */
import type { Command } from 'commander';
import { listImages, searchImages, getImageDetail } from '../api';
import {
  saveImageCache,
  loadImageCache,
  saveHourlyCache,
  loadHourlyCache,
  loadSyncState,
  saveSyncState,
} from '../storage';
import { ensureAccessToken } from '../credentials';
import { parseDateOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Sync images from yesterday back to N days')
    .option('--days <number>', 'number of days to sync (used when --date is omitted)')
    .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'sync only this date/month/year range')
    .option('--max-pages <number>', 'max pages to fetch', '10')
    .option('--query <query>', 'fill the cache from a search instead of the listing')
    .option('--refresh', 'fetch every capture again, even one already cached')
    .option('--continue', 'resume the last walk of this query instead of starting at the top')
    .action(async (options) => {
      await ensureAccessToken();
      if (options.date && options.days) {
        console.error('Error: --date and --days cannot be used together.');
        process.exit(1);
      }
      if (options.query && (options.date || options.days)) {
        // Search results are not ordered the same way for every query: a plain
        // query comes back newest first, while a `date:` one starts at the
        // beginning of its range. Nothing here can bound a walk by date
        // safely, and the query language can: put the range in the query.
        console.error('Error: --query cannot be used with --date or --days.');
        console.error('Hint: bound the range inside the query, as');
        console.error('  --query "has:exif date:2026-08"');
        console.error('  --query "has:exif since:2026-08-01 until:2026-08-31"');
        process.exit(1);
      }

      if (options.continue && !options.query) {
        console.error('Error: --continue needs --query, because it resumes a query.');
        process.exit(1);
      }

      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');

      /** The day part of an instant, in local time, as the operators want it. */
      const dayOf = (date: Date): string => {
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      };

      let query: string | undefined = options.query;
      if (options.continue) {
        if (/\b(date|since|until):/i.test(query as string)) {
          console.error('Error: --continue cannot resume a query that bounds its own dates.');
          console.error('Hint: drop date:, since: and until: from --query, or drop --continue.');
          process.exit(1);
        }
        const state = loadSyncState(query as string);
        if (state) {
          query = `${query} until:${state.oldestDay}`;
          console.log(`Resuming from ${state.oldestDay} (walked ${state.updatedAt}).`);
        } else {
          console.log('Nothing walked for this query yet; starting at the top.');
        }
      }

      let startDate: Date;
      let endDate: Date;

      if (options.date) {
        const parsed = parseDateOption(options.date);
        startDate = parsed.start;
        endDate = parsed.end;
      } else {
        const days = options.days ? parsePositiveIntegerOption(options.days, '--days') : 1;
        const now = new Date();
        endDate = new Date(now);
        endDate.setDate(endDate.getDate() - 1);
        endDate.setHours(23, 59, 59, 999);

        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - days - 1);
        startDate.setHours(0, 0, 0, 0);
      }

      if (query) {
        console.log(`Syncing images matching ${JSON.stringify(query)}...`);
      } else {
        console.log(`Syncing images between ${startDate.toISOString()} and ${endDate.toISOString()}...`);
      }

      const hourlyIndices: Map<string, Set<string>> = new Map();
      let oldestSeen: Date | null = null;

      for (let page = 1; page <= maxPages; page++) {
        const images = query
          ? await searchImages(query, page, 100)
          : await listImages(page, 100);
        if (images.length === 0) break;

        let reachedLimit = false;
        for (const img of images) {
          const createdAt = new Date(img.created_at);

          // A query says for itself what it covers, and the results are not
          // ordered predictably enough to stop early on a date.
          if (!query && createdAt > endDate) {
            // Skip images newer than target range.
            continue;
          }

          if (!query && createdAt < startDate) {
            reachedLimit = true;
            break;
          }

          if (!oldestSeen || createdAt < oldestSeen) {
            oldestSeen = createdAt;
          }

          // Add to hourly index
          const y = createdAt.getFullYear().toString();
          const m = (createdAt.getMonth() + 1).toString().padStart(2, '0');
          const d = createdAt.getDate().toString().padStart(2, '0');
          const h = createdAt.getHours().toString().padStart(2, '0');
          const key = `${y}-${m}-${d}-${h}`;
          if (!hourlyIndices.has(key)) hourlyIndices.set(key, new Set());
          hourlyIndices.get(key)?.add(img.image_id);

          // Already fetched is already fetched. This used to test `cached.ocr`,
          // which is null in every response the API returns -- the OCR text
          // lives under `metadata` -- so the check never fired and every sync
          // re-fetched everything it had. On an API with undocumented rate
          // limits that is the expensive kind of mistake.
          const cached = options.refresh ? null : loadImageCache(img.image_id);
          if (cached) {
            process.stdout.write(`s`);
            continue;
          }

          process.stdout.write(`.`);
          try {
            const detail = await getImageDetail(img.image_id);
            saveImageCache(img.image_id, detail);
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (e) {
            process.stdout.write(`x`);
          }
        }

        console.log(`\nPage ${page} processed.`);
        if (reachedLimit) break;

        // A breath between pages. The rate limits here are real and
        // undocumented, and a walk of a hundred pages is exactly the shape
        // that finds them.
        if (page < maxPages) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Save hourly indices
      console.log(`Updating hourly indices...`);
      for (const [key, ids] of hourlyIndices.entries()) {
        const [y, m, d, h] = key.split('-');
        const existing = loadHourlyCache(y, m, d, h) || [];
        const merged = Array.from(new Set([...existing, ...ids]));
        saveHourlyCache(y, m, d, h, merged);
      }
      // Remember how far back this query got, so a later --continue can pick
      // up there rather than walking the same pages again. Only for a query
      // the caller did not bound itself: a bounded one says what it covers.
      if (options.query && oldestSeen && !/\b(date|since|until):/i.test(options.query)) {
        saveSyncState({
          query: options.query,
          oldestDay: dayOf(oldestSeen),
          updatedAt: new Date().toISOString(),
        });
      }

      console.log(`Sync complete.`);
    });
}
