/**
 * The `list` command, which is also `ls`.
 */
import type { Command } from 'commander';
import { listImages, getImageDetail, searchImages } from '../api';
import {
  saveImageCache,
  loadImageCache,
  loadHourlyCache,
} from '../storage';
import { ensureAccessToken } from '../credentials';
import { parseDateOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';
import {
  loadImageIdsFromDateRangeCache,
  warmDateCacheForList,
} from '../services/memory';
import {
  prepareImagesForDisplay,
  printListImages,
} from '../services/images';

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
        const targetDate = hasDateRange
          ? (options.today ? parseDateOption() : parseDateOption(options.date))
          : undefined;

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

        const aliasQuery = options.photos
          ? 'has:location'
          : options.uploaded
            ? 'gyazocli_uploads'
            : undefined;
        if (aliasQuery) {
          let images: any[] = [];
          if (targetDate) {
            const collected: any[] = [];
            for (let searchPage = 1; searchPage <= maxPages; searchPage++) {
              const pageImages = await searchImages(aliasQuery, searchPage, 100);
              if (pageImages.length === 0) break;

              let reachedLimit = false;
              for (const img of pageImages) {
                const createdAt = new Date(img.created_at);
                if (Number.isNaN(createdAt.getTime())) continue;
                if (createdAt > targetDate.end) continue;
                if (createdAt < targetDate.start) {
                  reachedLimit = true;
                  break;
                }
                collected.push(img);
              }
              if (reachedLimit) break;
            }

            collected.sort((a, b) => {
              const ta = new Date(a.created_at).getTime();
              const tb = new Date(b.created_at).getTime();
              return tb - ta;
            });

            const startIndex = (page - 1) * limit;
            images = collected.slice(startIndex, startIndex + limit);
          } else {
            images = await searchImages(
              aliasQuery,
              page,
              limit,
            );
          }

          if (options.json) {
            console.log(JSON.stringify(images, null, 2));
          } else {
            const imagesForDisplay = await prepareImagesForDisplay(images, {
              cacheSearchResults: true,
              enrichLocation: true,
              useCache,
            });
            printListImages(imagesForDisplay);
          }
          return;
        }

        if (targetDate) {
          let imageIds: string[] = [];
          if (useCache) {
            imageIds = loadImageIdsFromDateRangeCache(targetDate);
            if (imageIds.length === 0) {
              await warmDateCacheForList(targetDate, maxPages, true);
              imageIds = loadImageIdsFromDateRangeCache(targetDate);
            }
          } else {
            imageIds = await warmDateCacheForList(targetDate, maxPages, false);
          }

          if (imageIds.length === 0) {
            console.log(`No images found for ${targetDate.dateKey}.`);
            return;
          }

          let images = imageIds
            .map(id => loadImageCache(id))
            .filter((img): img is any => img !== null);
          images = images.filter((img) => {
            const createdAt = new Date(img.created_at);
            if (Number.isNaN(createdAt.getTime())) return false;
            return createdAt >= targetDate.start && createdAt <= targetDate.end;
          });

          images.sort((a, b) => {
            const ta = new Date(a.created_at).getTime();
            const tb = new Date(b.created_at).getTime();
            return tb - ta;
          });

          const startIndex = (page - 1) * limit;
          const pageImages = images.slice(startIndex, startIndex + limit);
          if (options.json) {
            console.log(JSON.stringify(pageImages, null, 2));
          } else {
            const imagesForDisplay = await prepareImagesForDisplay(pageImages, {
              enrichLocation: true,
              useCache,
            });
            printListImages(imagesForDisplay);
          }
          return;
        }

        if (options.hour) {
          const parts = options.hour.split('-');
          if (parts.length !== 4) {
            console.error('Error: hour format must be yyyy-mm-dd-hh');
            process.exit(1);
          }
          const [year, month, day, hour] = parts;
          const imageIds = loadHourlyCache(year, month, day, hour);
          if (!imageIds) {
            console.log(`No images found for ${options.hour} in cache.`);
            return;
          }

          let images: any[] = [];
          if (useCache) {
            images = imageIds.map(id => loadImageCache(id)).filter(img => img !== null);
          } else {
            for (const imageId of imageIds) {
              try {
                const detail = await getImageDetail(imageId);
                saveImageCache(imageId, detail);
                images.push(detail);
              } catch (_error) {
                // Skip failed items and continue with the rest.
              }
            }
          }
          if (options.json) {
            console.log(JSON.stringify(images, null, 2));
          } else {
            const imagesForDisplay = await prepareImagesForDisplay(images, {
              enrichLocation: true,
              useCache,
            });
            printListImages(imagesForDisplay);
          }
          return;
        }

        const images = await listImages(page, limit);
        if (options.json) {
          console.log(JSON.stringify(images, null, 2));
        } else {
          const imagesForDisplay = await prepareImagesForDisplay(images, {
            enrichLocation: true,
            useCache,
          });
          printListImages(imagesForDisplay);
        }
      } catch (error: any) {
        console.error('Error listing images:', error.message);
        process.exit(1);
      }
    });
}
