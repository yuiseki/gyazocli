/**
 * The `domains` ranking command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { warmDateCacheForDomains } from '../services/memory';
import {
  DomainRank,
  buildDomainsRankingFromCache,
  buildDomainsRankingFromHourlyCache,
} from '../services/analytics';

export function registerDomainsCommand(program: Command): void {
  program
    .command('domains')
    .description('Rank metadata URL domains for a specific date')
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

        let ranking: DomainRank[] = [];
        let totalWithDomain = 0;
        let totalImages = 0;

        if (useCache) {
          let cacheSummary = buildDomainsRankingFromHourlyCache(targetDate);
          if (cacheSummary.totalImages === 0) {
            await warmDateCacheForDomains(targetDate, maxPages, true);
            cacheSummary = buildDomainsRankingFromHourlyCache(targetDate);
          }
          ranking = cacheSummary.ranking;
          totalWithDomain = cacheSummary.imageCountWithDomains;
          totalImages = cacheSummary.totalImages;
        } else {
          const imageIds = await warmDateCacheForDomains(targetDate, maxPages, false);
          ranking = buildDomainsRankingFromCache(imageIds);
          totalWithDomain = ranking.reduce((sum, item) => sum + item.count, 0);
          totalImages = imageIds.length;
        }

        const displayedRanking = ranking.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({
            date: targetDate.dateKey,
            image_count: totalImages,
            domain_image_count: totalWithDomain,
            total_domains: ranking.length,
            ranking: displayedRanking,
          }, null, 2));
          return;
        }

        if (ranking.length === 0) {
          console.log(`No domain metadata found for ${targetDate.dateKey}.`);
          return;
        }

        console.log(`Domains on ${targetDate.dateKey}`);
        displayedRanking.forEach((item, index) => {
          console.log(`${index + 1}. ${item.domain}: ${item.count}`);
        });
        console.log(`Total images with domain metadata: ${totalWithDomain}`);
      } catch (error: any) {
        console.error('Error ranking domains:', error.message);
        process.exit(1);
      }
    });
}
