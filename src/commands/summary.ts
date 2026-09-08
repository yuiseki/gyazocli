/**
 * The `summary` command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import {
  warmDateCacheForTags,
  warmDateCacheForLocations,
} from '../services/memory';
import {
  DailySummary,
  buildDailySummariesFromImageCache,
  renderSummaryText,
} from '../services/analytics';

export function registerSummaryCommand(program: Command): void {
  program
    .command('summary')
    .description('Show weekly summary with daily uploads and metadata rankings')
    .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
    .option('--today', 'target today only (overrides default weekly range)')
    .option('-l, --limit <number>', 'maximum ranking rows (max: 10)', '10')
    .option('--max-pages <number>', 'max pages to scan before stopping', '10')
    .option('-j, --json', 'output as JSON')
    .option('--no-cache', 'force fetch from API')
    .action(async (options) => {
      await ensureAccessToken();
      try {
        const targetDate = resolveRankingRangeOption(options);
        const requestedLimit = parsePositiveIntegerOption(options.limit, '--limit');
        const limit = Math.min(requestedLimit, 10);
        const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
        const useCache = options.cache !== false;

        let dailySummaries: DailySummary[] = [];

        if (useCache) {
          dailySummaries = buildDailySummariesFromImageCache(targetDate);
          const totalUploads = dailySummaries.reduce((sum, day) => sum + day.imageCount, 0);
          if (totalUploads === 0) {
            await warmDateCacheForTags(targetDate, maxPages, true);
            await warmDateCacheForLocations(targetDate, maxPages, true);
            dailySummaries = buildDailySummariesFromImageCache(targetDate);
          } else {
            const hasMetadata = dailySummaries.some(day =>
              day.apps.length > 0 || day.domains.length > 0 || day.tags.length > 0 || day.locations.length > 0,
            );
            if (!hasMetadata) {
              await warmDateCacheForTags(targetDate, maxPages, true);
              await warmDateCacheForLocations(targetDate, maxPages, true);
              dailySummaries = buildDailySummariesFromImageCache(targetDate);
            }
          }
        } else {
          await warmDateCacheForTags(targetDate, maxPages, false);
          await warmDateCacheForLocations(targetDate, maxPages, false);
          dailySummaries = buildDailySummariesFromImageCache(targetDate);
        }

        if (options.json) {
          console.log(JSON.stringify({
            date: targetDate.dateKey,
            days: dailySummaries.map(day => ({
              date: day.date,
              image_count: day.imageCount,
              apps: day.apps.slice(0, limit),
              domains: day.domains.slice(0, limit),
              tags: day.tags.slice(0, limit),
              locations: day.locations.slice(0, limit),
            })),
          }, null, 2));
          return;
        }

        console.log(renderSummaryText({
          dateKey: targetDate.dateKey,
          dailySummaries,
          limit,
        }));
      } catch (error: any) {
        console.error('Error building summary:', error.message);
        process.exit(1);
      }
    });
}
