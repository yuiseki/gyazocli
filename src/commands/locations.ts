/**
 * The `locations` ranking command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { warmDateCacheForLocations } from '../services/memory';
import {
  LocationRank,
  buildLocationsRankingFromCache,
  buildLocationsRankingFromHourlyCache,
} from '../services/analytics';

export function registerLocationsCommand(program: Command): void {
  program
    .command('locations')
    .description('Rank metadata locations for a specific date')
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

        let ranking: LocationRank[] = [];
        let totalWithLocation = 0;
        let totalImages = 0;

        if (useCache) {
          let cacheSummary = buildLocationsRankingFromHourlyCache(targetDate);
          if (cacheSummary.totalImages === 0) {
            await warmDateCacheForLocations(targetDate, maxPages, true);
            cacheSummary = buildLocationsRankingFromHourlyCache(targetDate);
          }
          ranking = cacheSummary.ranking;
          totalWithLocation = cacheSummary.imageCountWithLocations;
          totalImages = cacheSummary.totalImages;
        } else {
          const imageIds = await warmDateCacheForLocations(targetDate, maxPages, false);
          ranking = buildLocationsRankingFromCache(imageIds);
          totalWithLocation = ranking.reduce((sum, item) => sum + item.count, 0);
          totalImages = imageIds.length;
        }

        const displayedRanking = ranking.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({
            date: targetDate.dateKey,
            image_count: totalImages,
            location_image_count: totalWithLocation,
            total_locations: ranking.length,
            ranking: displayedRanking,
          }, null, 2));
          return;
        }

        if (ranking.length === 0) {
          console.log(`No location metadata found for ${targetDate.dateKey}.`);
          return;
        }

        console.log(`Locations on ${targetDate.dateKey}`);
        displayedRanking.forEach((item, index) => {
          console.log(`${index + 1}. ${item.location}: ${item.count}`);
        });
        console.log(`Total images with location metadata: ${totalWithLocation}`);
      } catch (error: any) {
        console.error('Error ranking locations:', error.message);
        process.exit(1);
      }
    });
}
