/**
 * The `stats` command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { buildStatsDateRange } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { loadCookieHeader } from '../cookies';
import { fetchImageWebJson } from '../api';
import {
  countCache,
  sumCachedFileSizes,
  cachedImageIdsMissingFileSize,
  sampleCachedImageIds,
  setCachedFileSize,
  loadImageCache,
} from '../storage';

/**
 * Estimate a population total from a simple random sample of its members, with a
 * 95% confidence interval. Uses the finite population correction, since the
 * sample is drawn without replacement from a known, bounded population.
 */
function estimateTotalFromSample(
  sampleSizes: number[],
  populationN: number,
): {
  sampleN: number;
  meanBytes: number;
  stdevBytes: number;
  populationN: number;
  estimateBytes: number;
  ci95: [number, number];
  relativeMarginPct: number;
} {
  const n = sampleSizes.length;
  const mean = n > 0 ? sampleSizes.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 1 ? sampleSizes.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const estimate = populationN * mean;
  // SE of the total, with the finite population correction (1 - n/N).
  const fpc = populationN > 0 ? Math.max(0, 1 - n / populationN) : 1;
  const seTotal = populationN * (stdev / Math.sqrt(Math.max(1, n))) * Math.sqrt(fpc);
  const margin = 1.96 * seTotal;
  const relativeMarginPct = estimate > 0 ? (margin / estimate) * 100 : 0;
  return {
    sampleN: n,
    meanBytes: mean,
    stdevBytes: stdev,
    populationN,
    estimateBytes: estimate,
    ci95: [Math.max(0, estimate - margin), estimate + margin],
    relativeMarginPct,
  };
}

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

  // `stats size`: total the file_size of cached images. file_size is not in the
  // public API detail that fills the cache, so it is backfilled from the web
  // per-image JSON (gyazo.com/<id>.json) with --fetch, and then summed. Without
  // --fetch it just sums whatever sizes are already stored.
  stats
    .command('size')
    .description("Total the file size of cached images (backfill sizes with --fetch)")
    .option('--fetch', 'fetch missing sizes from gyazo.com/<id>.json and store them')
    .option('--max <number>', 'with --fetch, cap how many to fetch this run')
    .option('--random', 'with --fetch, sample ids at random to estimate the population total')
    .option('--cookies <path>', 'cookies, so a withheld image returns a size too')
    .option('-j, --json', 'output as JSON')
    .action(async (options) => {
      // The population the estimate is about: every cached image.
      const populationN = countCache().images;

      if (options.fetch) {
        const max = options.max
          ? parsePositiveIntegerOption(options.max, '--max')
          : undefined;
        const cookieHeader = loadCookieHeader(options.cookies) || undefined;
        if (!cookieHeader) {
          // A withheld image returns file_size null without a session cookie, so
          // those will stay unknown until a cookied run fills them in.
          console.error(
            'Warning: no cookies found. Withheld images return no size without them; ' +
              'pass --cookies <path> or put them in ~/.config/gyazo/cookie.json.',
          );
        }

        // --random draws a uniform sample across the whole cache (for an
        // estimate); the default walks the missing ones in order (to fill them
        // in). A size already stored is reused, not re-fetched.
        const targets = options.random
          ? sampleCachedImageIds(max ?? populationN)
          : cachedImageIdsMissingFileSize(max);

        const sampleSizes: number[] = [];
        let fetched = 0;
        let failed = 0;
        for (let i = 0; i < targets.length; i++) {
          const id = targets[i];
          const known = loadImageCache(id)?.file_size;
          if (typeof known === 'number') {
            sampleSizes.push(known);
            continue;
          }
          try {
            const record = await fetchImageWebJson(id, cookieHeader);
            if (typeof record?.file_size === 'number') {
              setCachedFileSize(id, record.file_size);
              sampleSizes.push(record.file_size);
              fetched += 1;
            } else {
              failed += 1;
            }
          } catch {
            failed += 1;
          }
          if ((i + 1) % 100 === 0) {
            process.stderr.write(`\rfetched ${fetched}/${targets.length} (${failed} without a size)`);
          }
        }
        if (targets.length >= 100) process.stderr.write('\n');
        console.error(`Backfilled ${fetched} size(s), ${failed} without one, of ${targets.length} target(s).`);

        if (options.random) {
          const est = estimateTotalFromSample(sampleSizes, populationN);
          if (options.json) {
            console.log(JSON.stringify(est, null, 2));
            return;
          }
          console.log(
            `Sampled ${est.sampleN.toLocaleString('en-US')} of ${populationN.toLocaleString('en-US')} images at random.`,
          );
          console.log(
            `Mean ${formatBytes(est.meanBytes)}/image, stdev ${formatBytes(est.stdevBytes)}.`,
          );
          console.log(
            `Estimated total: ${formatBytes(est.estimateBytes)} ` +
              `(95% CI ${formatBytes(est.ci95[0])}–${formatBytes(est.ci95[1])}, ` +
              `±${est.relativeMarginPct.toFixed(1)}%).`,
          );
          return;
        }
      }

      const summary = sumCachedFileSizes();
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }
      const pct = summary.images > 0 ? Math.round((summary.withSize / summary.images) * 100) : 0;
      console.log(`Total size: ${formatBytes(summary.totalBytes)} (${summary.totalBytes.toLocaleString('en-US')} bytes)`);
      console.log(`Known for ${summary.withSize.toLocaleString('en-US')} of ${summary.images.toLocaleString('en-US')} cached images (${pct}%)`);
      if (summary.withSize < summary.images) {
        console.log('Run `gyazo stats size --fetch` to fill in the rest.');
      }
    });
}
