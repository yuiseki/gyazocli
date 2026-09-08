/**
 * The `list` command, which is also `ls`.
 */
import type { Command } from 'commander';
import { ensureAccessToken } from '../credentials';
import { parseDateOption, parseHourOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import { listCaptures, type CaptureAlias } from '../services/memory';
import { prepareImagesForDisplay, printListImages } from '../services/images';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List recent images')
    .option('-p, --page <number>', 'page number', '1')
    .option('-l, --limit <number>', 'items per page', '20')
    .option('-j, --json', 'output as JSON')
    .option('-H, --hour <yyyy-mm-dd-hh>', 'target hour')
    .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'target date/range')
    .option('--today', 'target today only')
    .option('--max-pages <number>', 'max pages to scan for --date/--today mode', '100')
    .option('--photos', 'alias of search "has:location"')
    .option('--uploaded', 'alias of search "gyazocli_uploads"')
    .option('--no-cache', 'force fetch from API')
    .action(async (options) => {
      await ensureAccessToken();
      try {
        const useCache = options.cache !== false;
        const page = parsePositiveIntegerOption(options.page, '--page');
        const limit = parsePositiveIntegerOption(options.limit, '--limit');
        const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');
        const hasDateRange = Boolean(options.date || options.today);

        if (options.photos && options.uploaded) {
          console.error('Error: --photos and --uploaded cannot be used together.');
          process.exit(1);
        }
        if (options.today && options.date) {
          console.error('Error: --today and --date cannot be used together.');
          process.exit(1);
        }
        if ((options.photos || options.uploaded) && options.hour) {
          console.error('Error: --photos/--uploaded and --hour cannot be used together.');
          process.exit(1);
        }
        if (options.hour && hasDateRange) {
          console.error('Error: --hour and --date/--today cannot be used together.');
          process.exit(1);
        }

        const targetDate = hasDateRange
          ? options.today
            ? parseDateOption()
            : parseDateOption(options.date)
          : undefined;

        let hour: ReturnType<typeof parseHourOption> = null;
        if (options.hour) {
          hour = parseHourOption(options.hour);
          if (!hour) {
            console.error('Error: hour format must be yyyy-mm-dd-hh');
            process.exit(1);
          }
        }

        const alias: CaptureAlias | undefined = options.photos
          ? 'photos'
          : options.uploaded
            ? 'uploaded'
            : undefined;

        const { images, empty } = await listCaptures({
          page,
          limit,
          maxPages,
          useCache,
          date: targetDate,
          hour: hour || undefined,
          alias,
        });

        if (empty === 'date' && targetDate) {
          console.log(`No images found for ${targetDate.dateKey}.`);
          return;
        }
        if (empty === 'hour') {
          console.log(`No images found for ${options.hour} in cache.`);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(images, null, 2));
          return;
        }

        // A search result carries less than a listing does, so the alias paths
        // ask for their results to be cached as they are shown.
        const imagesForDisplay = await prepareImagesForDisplay(images, {
          cacheSearchResults: Boolean(alias),
          enrichLocation: true,
          useCache,
        });
        printListImages(imagesForDisplay);
      } catch (error: any) {
        console.error('Error listing images:', error.message);
        process.exit(1);
      }
    });
}
