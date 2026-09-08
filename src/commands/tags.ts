/**
 * The `tags` ranking command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { warmDateCacheForTags } from '../services/memory';
import {
  TagRankingSummary,
  buildTagsRankingFromCache,
  buildTagsRankingFromHourlyCache,
} from '../services/analytics';

export function registerTagsCommand(program: Command): void {
  program
    .command('tags')
    .description('Rank metadata tags for a specific date')
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

        let summary: TagRankingSummary;
        let totalImages = 0;

        if (useCache) {
          let cacheSummary = buildTagsRankingFromHourlyCache(targetDate);
          if (cacheSummary.totalImages === 0) {
            await warmDateCacheForTags(targetDate, maxPages, true);
            cacheSummary = buildTagsRankingFromHourlyCache(targetDate);
          }
          summary = cacheSummary;
          totalImages = cacheSummary.totalImages;
        } else {
          const imageIds = await warmDateCacheForTags(targetDate, maxPages, false);
          summary = buildTagsRankingFromCache(imageIds);
          totalImages = imageIds.length;
        }

        const displayedRanking = summary.ranking.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({
            date: targetDate.dateKey,
            image_count: totalImages,
            image_count_with_tags: summary.imageCountWithTags,
            total_tag_assignments: summary.totalTagAssignments,
            total_tags: summary.ranking.length,
            ranking: displayedRanking,
          }, null, 2));
          return;
        }

        if (summary.ranking.length === 0) {
          console.log(`No tag metadata found for ${targetDate.dateKey}.`);
          return;
        }

        console.log(`Tags on ${targetDate.dateKey}`);
        displayedRanking.forEach((item, index) => {
          console.log(`${index + 1}. #${item.tag}: ${item.count}`);
        });
        console.log(`Total images with tag metadata: ${summary.imageCountWithTags}`);
      } catch (error: any) {
        console.error('Error ranking tags:', error.message);
        process.exit(1);
      }
    });
}
