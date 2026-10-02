/**
 * The `sync` command, which fills the cache.
 */
import type { Command } from 'commander';
import { listImages, searchImages, getImageDetail, fetchImageWebJson } from '../api';
import {
  saveImageCache,
  loadImageCache,
  saveHourlyCache,
  loadHourlyCache,
  loadSyncState,
  saveSyncState,
} from '../storage';
import { ensureAccessToken } from '../credentials';
import { loadCookieHeader } from '../cookies';
import { parseDateOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';

type SyncSource = 'api' | 'web' | 'web-and-api';

/**
 * Combine an API record with a web (`<id>.json`) one. The API record is the base
 * for analytics: it carries metadata.exif_address (addresses), metadata.url
 * (domains) and localized_object_annotations (objects) that the web record lacks.
 * The web record contributes file_size (absent from the API) and its extra
 * metadata (raw exif, hashtags). On overlapping keys the API wins.
 */
function mergeApiAndWeb(api: any, web: any): any {
  if (!web) return api;
  if (!api) return web;
  return {
    ...web,
    ...api,
    metadata: { ...(web.metadata || {}), ...(api.metadata || {}) },
  };
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Sync images from yesterday back to N days')
    .option('--days <number>', 'number of days to sync (used when --date is omitted)')
    .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'sync only this date/month/year range')
    .option('--max-pages <number>', 'max pages to fetch', '10')
    .option('--all-pages', 'fetch every page (for a bounded query like month:YYYY-MM)')
    .option('--query <query>', 'fill the cache from a search instead of the listing')
    .option('--refresh', 'fetch every capture again, even one already cached')
    .option('--continue', 'resume the last walk of this query instead of starting at the top')
    .option('--web', 'fetch detail from gyazo.com/<id>.json only (has file_size)')
    .option('--api', 'fetch detail from the OAuth API only (no file_size)')
    .option('--web-and-api', 'fetch from both and merge (full metadata + file_size)')
    .option('--cookies <path>', 'gyazo.com cookies for the web source')
    .action(async (options) => {
      await ensureAccessToken();

      const sourceFlags = [options.web, options.api, options.webAndApi].filter(Boolean);
      if (sourceFlags.length > 1) {
        console.error('Error: use only one of --web, --api, --web-and-api.');
        process.exit(1);
      }
      const cookieHeader = loadCookieHeader(options.cookies) || undefined;
      // Default: with cookies, the web source alone -- fast, carries file_size,
      // and spares the rate-limited OAuth API -- for a quick whole-picture pass;
      // run `sync --api` afterwards to fill in addresses/domains/objects. Without
      // cookies the web source is unavailable, so fall back to the API.
      const source: SyncSource = options.web
        ? 'web'
        : options.api
          ? 'api'
          : options.webAndApi
            ? 'web-and-api'
            : cookieHeader
              ? 'web'
              : 'api';
      if ((source === 'web' || source === 'web-and-api') && !cookieHeader) {
        // The web source still answers for public images without a cookie; only
        // withheld ones come back without a size. Warn, do not abort.
        console.error(
          'Warning: no cookies found. Withheld images return no file_size without them; ' +
            'pass --cookies <path> or put them in ~/.config/gyazo/cookie.json.',
        );
      }
      console.log(`Detail source: ${source}.`);
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

      // --all-pages lifts the cap: the walk then runs until a page comes back
      // empty. Safe for a bounded query (month:YYYY-MM); an unbounded one would
      // try to page the whole account.
      const maxPages = options.allPages
        ? Number.MAX_SAFE_INTEGER
        : parsePositiveIntegerOption(options.maxPages, '--max-pages');

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

          // Decide per source by whether the fields that source provides are
          // already in the cache, not by a marker -- so a record cached by an
          // earlier API-only sync is recognised as API-complete and not fetched
          // again. web contributes file_size; api contributes metadata the web
          // JSON never carries, of which original_url is present on every API
          // record (and on no web one). The passes merge, never clobber: this is
          // the "web first for the whole picture, api later to fill in
          // addresses/domains" workflow.
          const cached = loadImageCache(img.image_id);
          const haveWeb = typeof cached?.file_size === 'number';
          const haveApi = cached?.metadata?.original_url !== undefined;
          const wantWeb = source === 'web' || source === 'web-and-api';
          const wantApi = source === 'api' || source === 'web-and-api';
          const needWeb = wantWeb && (options.refresh || !haveWeb);
          const needApi = wantApi && (options.refresh || !haveApi);
          if (!needWeb && !needApi) {
            process.stdout.write(`s`);
            continue;
          }

          process.stdout.write(`.`);
          try {
            let apiRec: any = null;
            let webRec: any = null;
            if (needApi) apiRec = await getImageDetail(img.image_id);
            if (needWeb) webRec = await fetchImageWebJson(img.image_id, cookieHeader);
            const fetched =
              needApi && needWeb ? mergeApiAndWeb(apiRec, webRec) : apiRec || webRec;
            // Merge over what is already cached so the other source's exclusive
            // fields (file_size, or exif_address/url/objects) survive.
            const merged = cached
              ? { ...cached, ...fetched, metadata: { ...(cached.metadata || {}), ...(fetched.metadata || {}) } }
              : fetched;
            saveImageCache(img.image_id, merged);
            // The OAuth API is the rate-limited one; a web-only pass can breathe
            // more lightly.
            await new Promise((resolve) => setTimeout(resolve, needApi ? 200 : 50));
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
