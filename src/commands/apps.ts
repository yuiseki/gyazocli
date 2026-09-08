/**
 * The `apps` ranking command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { warmDateCacheForApps } from '../services/memory';
import {
  AppRank,
  buildAppsRankingFromCache,
  buildAppsRankingFromHourlyCache,
} from '../services/analytics';

export function registerAppsCommand(program: Command): void {
  program
    .command('apps')
    .description('Rank metadata app names for a specific date')
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

        let ranking: AppRank[] = [];
        let totalWithApp = 0;
        let totalImages = 0;

        if (useCache) {
          let cacheSummary = buildAppsRankingFromHourlyCache(targetDate);
          if (cacheSummary.totalImages === 0) {
            await warmDateCacheForApps(targetDate, maxPages, true);
            cacheSummary = buildAppsRankingFromHourlyCache(targetDate);
          }
          ranking = cacheSummary.ranking;
          totalWithApp = cacheSummary.imageCountWithApps;
          totalImages = cacheSummary.totalImages;
        } else {
          const imageIds = await warmDateCacheForApps(targetDate, maxPages, false);
          ranking = buildAppsRankingFromCache(imageIds);
          totalWithApp = ranking.reduce((sum, item) => sum + item.count, 0);
          totalImages = imageIds.length;
        }

        const displayedRanking = ranking.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({
            date: targetDate.dateKey,
            image_count: totalImages,
            app_image_count: totalWithApp,
            total_apps: ranking.length,
            ranking: displayedRanking,
          }, null, 2));
          return;
        }

        if (ranking.length === 0) {
          console.log(`No app metadata found for ${targetDate.dateKey}.`);
          return;
        }

        console.log(`Apps on ${targetDate.dateKey}`);
        displayedRanking.forEach((item, index) => {
          console.log(`${index + 1}. ${item.app}: ${item.count}`);
        });
        console.log(`Total images with app metadata: ${totalWithApp}`);
      } catch (error: any) {
        console.error('Error ranking apps:', error.message);
        process.exit(1);
      }
    });
}
