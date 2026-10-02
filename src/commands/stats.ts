/**
 * The `stats` command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { buildStatsDateRange } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { loadCookieHeader } from '../cookies';
import { fetchImagesSummary } from '../api';
import {
  countCache,
  countCacheByMonth,
  sumCachedFileSizes,
} from '../storage';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}
import {
  warmDateCacheForApps,
  warmDateCacheForDomains,
  warmDateCacheForTags,
} from '../services/memory';
import {
  AppRank,
  DomainRank,
  TagRank,
  UploadTimeSummary,
  buildAppsRankingFromCache,
  buildAppsRankingFromHourlyCache,
  buildDomainsRankingFromCache,
  buildDomainsRankingFromHourlyCache,
  buildTagsRankingFromCache,
  buildTagsRankingFromHourlyCache,
  buildUploadTimeSummaryFromHourlyCache,
  buildUploadTimeSummaryFromImageCache,
  renderStatsMarkdown,
} from '../services/analytics';

export function registerStatsCommand(program: Command): void {
  const stats = program
    .command('stats')
    .description('Show weekly stats summary in Markdown')
    .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'window end date anchor (default: yesterday)')
    .option('--days <number>', 'window length in days', '7')
    .option('--top <number>', 'rows per section', '10')
    .option('--max-pages <number>', 'max pages to fetch when warming cache', '10')
    .option('--no-cache', 'force fetch from API')
    .action(async (options) => {
      await ensureAccessToken();
      try {
        const { range, days, startLabel, endLabel } = buildStatsDateRange(options.date, options.days || '7');
        const top = Math.min(parsePositiveIntegerOption(options.top, '--top'), 20);
        const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
        const useCache = options.cache !== false;

        let uploadTime: UploadTimeSummary;
        let apps: AppRank[] = [];
        let domains: DomainRank[] = [];
        let tags: TagRank[] = [];
        let totalUploads = 0;

        if (useCache) {
          uploadTime = buildUploadTimeSummaryFromHourlyCache(range);
          if (uploadTime.totalImages === 0) {
            await warmDateCacheForApps(range, maxPages, true);
            uploadTime = buildUploadTimeSummaryFromHourlyCache(range);
          }

          let appsSummary = buildAppsRankingFromHourlyCache(range);
          if (uploadTime.totalImages > 0 && appsSummary.totalImages === 0) {
            await warmDateCacheForApps(range, maxPages, true);
            appsSummary = buildAppsRankingFromHourlyCache(range);
          }

          let domainsSummary = buildDomainsRankingFromHourlyCache(range);
          if (uploadTime.totalImages > 0 && domainsSummary.totalImages === 0) {
            await warmDateCacheForDomains(range, maxPages, true);
            domainsSummary = buildDomainsRankingFromHourlyCache(range);
          }

          let tagsSummary = buildTagsRankingFromHourlyCache(range);
          if (uploadTime.totalImages > 0 && tagsSummary.totalImages === 0) {
            await warmDateCacheForTags(range, maxPages, true);
            tagsSummary = buildTagsRankingFromHourlyCache(range);
          }

          apps = appsSummary.ranking;
          domains = domainsSummary.ranking;
          tags = tagsSummary.ranking;
          totalUploads = uploadTime.totalImages;
        } else {
          const imageIds = await warmDateCacheForTags(range, maxPages, false);
          uploadTime = buildUploadTimeSummaryFromImageCache(imageIds, range);
          apps = buildAppsRankingFromCache(imageIds);
          domains = buildDomainsRankingFromCache(imageIds);
          tags = buildTagsRankingFromCache(imageIds).ranking;
          totalUploads = uploadTime.totalImages;
        }

        console.log(renderStatsMarkdown({
          startLabel,
          endLabel,
          days,
          totalUploads,
          uploadTime,
          apps,
          domains,
          tags,
          top,
        }));
      } catch (error: any) {
        console.error('Error building stats:', error.message);
        process.exit(1);
      }
    });

  // `stats cached`: how many images are in the local cache. Reads no token and
  // hits no network; it just counts files on disk.
  stats
    .command('cached')
    .description('Show how many images are in the local cache')
    .option('-j, --json', 'output as JSON')
    .action((options) => {
      const counts = countCache();
      if (options.json) {
        console.log(JSON.stringify(counts, null, 2));
        return;
      }
      const n = (value: number) => value.toLocaleString('en-US');
      console.log(`Cached images:     ${n(counts.images)}`);
      console.log(`Search-only cache: ${n(counts.searchImages)}`);
      console.log(`Hourly index files: ${n(counts.hourlyFiles)}`);
      console.log(`Cache dir: ${counts.cacheDir}`);
    });

  // `stats coverage`: how much of the account is actually cached, by year, from
  // the account's true monthly counts (images_summary) against what is on disk.
  // The listing and search cannot enumerate the whole account, so this is the
  // only honest picture of what is still only on Gyazo -- the salvage map.
  stats
    .command('coverage')
    .description("Cache coverage against the account's true counts (needs cookies)")
    .option('--cookies <path>', 'gyazo.com cookies')
    .option('-j, --json', 'output as JSON')
    .action(async (options) => {
      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: stats coverage needs gyazo.com cookies.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }
      let summary: any;
      try {
        summary = await fetchImagesSummary(cookieHeader);
      } catch (error: any) {
        console.error('Error fetching images_summary:', error.message);
        process.exit(1);
      }
      const monthly = summary?.monthly_counts || {};
      const { byMonth: cachedByMonth, sizedByMonth } = countCacheByMonth();

      const years = Array.from(
        new Set([...Object.keys(monthly), ...Object.keys(cachedByMonth)]),
      ).sort();
      let trueTotal = 0;
      let cachedTotal = 0;
      let sizedTotal = 0;
      const sumYear = (byMonth: Record<string, Record<string, number>>, year: string) =>
        Object.values(byMonth[year] || {}).reduce((a: number, b: number) => a + Number(b), 0);
      const rows = years.map((year) => {
        const trueYear = sumYear(monthly as any, year);
        const cachedYear = sumYear(cachedByMonth, year);
        const sizedYear = sumYear(sizedByMonth, year);
        trueTotal += trueYear;
        cachedTotal += cachedYear;
        sizedTotal += sizedYear;
        return {
          year,
          true: trueYear,
          cached: cachedYear,
          missing: Math.max(0, trueYear - cachedYear),
          withSize: sizedYear,
          sizeMissing: Math.max(0, trueYear - sizedYear),
        };
      });

      if (options.json) {
        console.log(JSON.stringify({
          trueTotal,
          cachedTotal,
          sizedTotal,
          missing: Math.max(0, trueTotal - cachedTotal),
          sizeMissing: Math.max(0, trueTotal - sizedTotal),
          years: rows,
        }, null, 2));
        return;
      }
      const n = (v: number) => v.toLocaleString('en-US');
      const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
      console.log(
        `True total: ${n(trueTotal)}   ` +
          `Cached: ${n(cachedTotal)} (${pct(cachedTotal, trueTotal)})   ` +
          `With size: ${n(sizedTotal)} (${pct(sizedTotal, trueTotal)})   ` +
          `Missing: ${n(Math.max(0, trueTotal - cachedTotal))}`,
      );
      console.log('');
      // Two coverages against the true count: metadata (cached) and file_size.
      console.log('year |     true |   cached | cov% |  missing | withSize | cov% |  missing');
      for (const r of rows) {
        console.log(
          `${r.year} | ${String(r.true).padStart(8)} | ${String(r.cached).padStart(8)} | ${pct(r.cached, r.true).padStart(4)} | ${String(r.missing).padStart(8)} | ` +
            `${String(r.withSize).padStart(8)} | ${pct(r.withSize, r.true).padStart(4)} | ${String(r.sizeMissing).padStart(8)}`,
        );
      }
    });

  // `stats size`: total the file_size of cached images that have one, and how
  // far that reaches. No estimate and no fetching: file sizes come in through
  // `gyazo sync --web`, this only reports what is on disk.
  stats
    .command('size')
    .description('Total the file size of cached images that have one')
    .action(() => {
      const summary = sumCachedFileSizes();
      const pct = summary.images > 0 ? Math.round((summary.withSize / summary.images) * 100) : 0;
      console.log(`Total size: ${formatBytes(summary.totalBytes)} (${summary.totalBytes.toLocaleString('en-US')} bytes)`);
      console.log(`Known for ${summary.withSize.toLocaleString('en-US')} of ${summary.images.toLocaleString('en-US')} cached images (${pct}%)`);
      if (summary.withSize < summary.images) {
        console.log('Run `gyazo sync --web` to fetch more file sizes.');
      }
    });
}
