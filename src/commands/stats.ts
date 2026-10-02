/**
 * The `stats` command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { buildStatsDateRange } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { countCache } from '../storage';
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
}
