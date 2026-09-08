/**
 * The `summary` command.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { resolveRankingRangeOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { buildSummary, renderSummaryText, toSummaryJson } from '../services/analytics';

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

        const dailySummaries = await buildSummary({ targetDate, maxPages, useCache });

        if (options.json) {
          console.log(JSON.stringify(toSummaryJson(targetDate.dateKey, dailySummaries, limit), null, 2));
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
