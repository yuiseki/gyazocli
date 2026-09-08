#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { listImages, getImageDetail, searchImages, getCurrentUser, uploadImage, getCollection } from './api';
import {
  saveImageCache,
  loadImageCache,
  getCacheDir,
  saveHourlyCache,
  loadHourlyCache,
} from './storage';
import { ensureAccessToken, resolveAccessToken, getStoredConfig, setStoredConfig } from './credentials';
import { normalizeImageId, normalizeCollectionId } from './ids';
import {
  normalizeText,
  extractOcrDescription,
  extractObjectAnnotations,
  formatObjectAnnotationLine,
} from './format';
import {
  parseDateOption,
  resolveRankingRangeOption,
  buildStatsDateRange,
  parseUploadTimestamp,
} from './dates';
import { parsePositiveIntegerOption } from './options';
import {
  loadImageIdsFromDateRangeCache,
  warmDateCacheForApps,
  warmDateCacheForDomains,
  warmDateCacheForTags,
  warmDateCacheForLocations,
  warmDateCacheForList,
  cacheSearchResultImages,
  supplementAltTextFromSearchCache,
} from './services/memory';
import {
  AppRank,
  DomainRank,
  LocationRank,
  TagRank,
  TagRankingSummary,
  UploadTimeSummary,
  DailySummary,
  buildAppsRankingFromCache,
  buildAppsRankingFromHourlyCache,
  buildDomainsRankingFromCache,
  buildDomainsRankingFromHourlyCache,
  buildLocationsRankingFromCache,
  buildLocationsRankingFromHourlyCache,
  buildTagsRankingFromCache,
  buildTagsRankingFromHourlyCache,
  buildUploadTimeSummaryFromHourlyCache,
  buildUploadTimeSummaryFromImageCache,
  buildDailySummariesFromImageCache,
  renderStatsMarkdown,
  renderSummaryText,
} from './services/analytics';
import {
  requireImageId,
  printGetMarkdown,
  prepareImagesForDisplay,
  printListImages,
  ensureUploadDescTag,
  readStdinBuffer,
} from './services/images';
import {
  requireCollectionId,
  parseCollectionSort,
  sortCollectionImages,
  printCollectionMarkdown,
} from './services/collections';

// Re-exported: these used to live here, and the shorthand tests reach for them.
export { normalizeImageId, normalizeCollectionId };

const program = new Command();


program
  .name('gyazo')
  .description('Gyazo Memory CLI for AI Secretary')
  .option('--mcp-server', 'run as a Model Context Protocol server over stdio')
  .version('0.1.1');

// Config Command
const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key, value) => {
    setStoredConfig(key, value);
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .option('-j, --json', 'output as JSON')
  .action(async (key, options) => {
    if (key === 'me') {
      await ensureAccessToken();
      try {
        const me = await getCurrentUser();
        if (options.json) {
          console.log(JSON.stringify(me, null, 2));
          return;
        }

        const user = me?.user || {};
        if (user.uid) console.log(`UID: ${user.uid}`);
        if (user.name) console.log(`Name: ${user.name}`);
        if (user.email) console.log(`Email: ${user.email}`);
        if (typeof user.is_pro === 'boolean') console.log(`Plan: ${user.is_pro ? 'Pro' : 'Free'}`);
        if (typeof user.is_team === 'boolean') console.log(`Team: ${user.is_team ? 'Yes' : 'No'}`);
        if (user.profile_image) console.log(`Profile image: ${user.profile_image}`);
      } catch (error: any) {
        console.error('Error getting current user:', error.message);
        process.exit(1);
      }
      return;
    }

    const value = getStoredConfig(key);
    if (value) {
      if (key === 'token') {
        const masked = value.length > 8 
          ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}`
          : '********';
        console.log(masked);
      } else {
        console.log(value);
      }
    } else {
      console.error(`Config key '${key}' not found.`);
      process.exit(1);
    }
  });






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

program
  .command('get <image_id>')
  .description('Get detailed metadata for an image')
  .option('-j, --json', 'output as JSON')
  .option('--ocr', 'output OCR text only')
  .option('--objects', 'output object annotations only')
  .option('--no-cache', 'force fetch from API')
  .action(async (imageId, options) => {
    await ensureAccessToken();
    try {
      if (options.json && (options.ocr || options.objects)) {
        console.error('Error: --json cannot be used with --ocr or --objects.');
        process.exit(1);
      }
      if (options.ocr && options.objects) {
        console.error('Error: --ocr and --objects cannot be used together.');
        process.exit(1);
      }

      imageId = requireImageId(imageId);

      let image = options.cache !== false ? loadImageCache(imageId) : null;
      if (!image) {
        image = await getImageDetail(imageId);
        saveImageCache(imageId, image);
      }

      const supplemented = supplementAltTextFromSearchCache(image);
      image = supplemented.image;
      if (supplemented.supplemented) {
        saveImageCache(imageId, image);
      }

      const ocrDescription = extractOcrDescription(image);
      const objects = extractObjectAnnotations(image);

      if (options.ocr) {
        if (!ocrDescription) {
          console.error('OCR not found for this image.');
          process.exit(1);
        }
        console.log(ocrDescription);
        return;
      }

      if (options.objects) {
        if (objects.length === 0) {
          console.error('Object annotations not found for this image.');
          process.exit(1);
        }
        console.log(objects.map(formatObjectAnnotationLine).join('\n'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(image, null, 2));
      } else {
        printGetMarkdown(image, ocrDescription, objects);
      }
    } catch (error: any) {
      console.error('Error getting image:', error.message);
      process.exit(1);
    }
  });

program
  .command('collection <collection_id>')
  .aliases(['col', 'cols', 'collections'])
  .description('Show a collection and the images in it')
  .option('-j, --json', 'output as JSON')
  .option('-A, --anonymous', 'read without an access token, even when one is configured')
  .option('--sort <added|created|captured>', 'image order (default: added)')
  .action(async (collectionIdInput, options) => {
    const collectionId = requireCollectionId(collectionIdInput);
    const sort = parseCollectionSort(options.sort);

    // No token is not an error here: public collections read fine anonymously.
    if (!options.anonymous) {
      resolveAccessToken();
    }

    try {
      const collection = await getCollection(collectionId, { anonymous: Boolean(options.anonymous) });

      if (options.json) {
        console.log(JSON.stringify(collection, null, 2));
        return;
      }

      const images = sortCollectionImages(
        Array.isArray(collection?.images) ? collection.images : [],
        sort,
      );
      printCollectionMarkdown(collection, images);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.error(`Error: collection ${collectionId} was not found or not public.`);
        console.error('Hint: a private collection returns the same 404 as one that does not exist.');
        if (options.anonymous) {
          console.error('Hint: you are running with --anonymous. Drop it to use your access token.');
        }
        process.exit(1);
      }
      console.error('Error getting collection:', error.message);
      process.exit(1);
    }
  });

program
  .command('search [query]')
  .description('Search images')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (query, options) => {
    await ensureAccessToken();
    try {
      if (!normalizeText(query)) {
        console.error('Error: Query is required.');
        console.error('Hint: Run `gyazo search -h` for usage.');
        process.exit(1);
      }

      const images = await searchImages(query);
      const useCache = options.cache !== false;
      if (options.json) {
        cacheSearchResultImages(images);
        console.log(JSON.stringify(images, null, 2));
      } else {
        const imagesForDisplay = await prepareImagesForDisplay(images, {
          cacheSearchResults: true,
          enrichLocation: true,
          useCache,
        });
        printListImages(imagesForDisplay);
      }
    } catch (error: any) {
      console.error('Error searching images:', error.message);
      process.exit(1);
    }
  });

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

program
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

program
  .command('upload [path]')
  .description('Upload an image file (or read image bytes from stdin)')
  .option('-j, --json', 'output the upload response as JSON')
  .option('--title <title>', 'image title')
  .option('--app <app>', 'application name', 'gyazocli')
  .option('--url <url>', 'source URL (sent as referer_url)')
  .option('--timestamp <unix_timestamp>', 'created_at unix timestamp (current or past)')
  .option('--desc <desc>', 'image description')
  .action(async (inputPath, options) => {
    await ensureAccessToken();

    let imageData: Buffer;
    let filename = 'stdin-upload.bin';

    if (inputPath && inputPath !== '-') {
      const resolvedPath = path.resolve(inputPath);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`Error: File not found: ${resolvedPath}`);
        process.exit(1);
      }
      imageData = fs.readFileSync(resolvedPath);
      filename = path.basename(resolvedPath);
    } else {
      if (process.stdin.isTTY) {
        console.error('Error: Provide an image path or pipe image data via stdin.');
        console.error('Hint: Run `gyazo upload -h` for usage.');
        process.exit(1);
      }
      imageData = await readStdinBuffer();
      if (imageData.length === 0) {
        console.error('Error: No image data received from stdin.');
        process.exit(1);
      }
    }

    const desc = ensureUploadDescTag(options.desc);
    const timestamp = parseUploadTimestamp(options.timestamp);

    try {
      const uploaded = await uploadImage({
        imageData,
        filename,
        title: options.title,
        app: options.app || 'gyazocli',
        refererUrl: options.url,
        desc,
        timestamp,
      });

      if (options.json) {
        console.log(JSON.stringify(uploaded, null, 2));
      } else {
        console.log(uploaded.permalink_url);
      }
    } catch (error: any) {
      console.error('Error uploading image:', error.message);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Sync images from yesterday back to N days')
  .option('--days <number>', 'number of days to sync (used when --date is omitted)')
  .option('--date <yyyy|yyyy-mm|yyyy-mm-dd>', 'sync only this date/month/year range')
  .option('--max-pages <number>', 'max pages to fetch', '10')
  .action(async (options) => {
    await ensureAccessToken();
    if (options.date && options.days) {
      console.error('Error: --date and --days cannot be used together.');
      process.exit(1);
    }

    const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');

    let startDate: Date;
    let endDate: Date;

    if (options.date) {
      const parsed = parseDateOption(options.date);
      startDate = parsed.start;
      endDate = parsed.end;
    } else {
      const days = options.days ? parsePositiveIntegerOption(options.days, '--days') : 1;
      const now = new Date();
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);

      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - days - 1);
      startDate.setHours(0, 0, 0, 0);
    }

    console.log(`Syncing images between ${startDate.toISOString()} and ${endDate.toISOString()}...`);

    const hourlyIndices: Map<string, Set<string>> = new Map();

    for (let page = 1; page <= maxPages; page++) {
      const images = await listImages(page, 100);
      if (images.length === 0) break;

      let reachedLimit = false;
      for (const img of images) {
        const createdAt = new Date(img.created_at);
        
        if (createdAt > endDate) {
          // Skip images newer than target range.
          continue;
        }
        
        if (createdAt < startDate) {
          reachedLimit = true;
          break;
        }

        // Add to hourly index
        const y = createdAt.getFullYear().toString();
        const m = (createdAt.getMonth() + 1).toString().padStart(2, '0');
        const d = createdAt.getDate().toString().padStart(2, '0');
        const h = createdAt.getHours().toString().padStart(2, '0');
        const key = `${y}-${m}-${d}-${h}`;
        if (!hourlyIndices.has(key)) hourlyIndices.set(key, new Set());
        hourlyIndices.get(key)?.add(img.image_id);

        const cached = loadImageCache(img.image_id);
        if (cached && cached.ocr) {
          process.stdout.write(`s`);
          continue;
        }

        process.stdout.write(`.`);
        try {
          const detail = await getImageDetail(img.image_id);
          saveImageCache(img.image_id, detail);
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          process.stdout.write(`x`);
        }
      }

      console.log(`\nPage ${page} processed.`);
      if (reachedLimit) break;
    }

    // Save hourly indices
    console.log(`Updating hourly indices...`);
    for (const [key, ids] of hourlyIndices.entries()) {
      const [y, m, d, h] = key.split('-');
      const existing = loadHourlyCache(y, m, d, h) || [];
      const merged = Array.from(new Set([...existing, ...ids]));
      saveHourlyCache(y, m, d, h, merged);
    }
    console.log(`Sync complete.`);
  });

program
  .command('import <type> <dir>')
  .description('Import legacy data (type: json|hourly)')
  .action(async (type, dir) => {
    const sourceDir = path.resolve(dir);
    if (!fs.existsSync(sourceDir)) {
      console.error(`Error: Source directory ${sourceDir} does not exist.`);
      process.exit(1);
    }

    if (type === 'json') {
      const targetDir = path.join(getCacheDir(), 'images');
      console.log(`Importing legacy Gyazo JSON from ${sourceDir}...`);
      let total = 0;
      const walk = (d: string) => {
        fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.json')) {
            const id = e.name.replace('.json', '');
            const p1 = id[0] || '_', p2 = id[1] || '_';
            const dest = path.join(targetDir, p1, p2);
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            fs.copyFileSync(p, path.join(dest, e.name));
            total++;
            if (total % 100 === 0) process.stdout.write('.');
          }
        });
      };
      walk(sourceDir);
      console.log(`\nImport complete. Copied ${total} files.`);
    } else if (type === 'hourly') {
      console.log(`Importing legacy Gyazo hourly data from ${sourceDir}...`);
      let total = 0;
      const years = fs.readdirSync(sourceDir).filter(f => /^[0-9]{4}$/.test(f));
      for (const y of years) {
        const months = fs.readdirSync(path.join(sourceDir, y)).filter(f => /^[0-9]{2}$/.test(f));
        for (const m of months) {
          const days = fs.readdirSync(path.join(sourceDir, y, m)).filter(f => /^[0-9]{2}$/.test(f));
          for (const d of days) {
            const hours = fs.readdirSync(path.join(sourceDir, y, m, d)).filter(f => /^[0-9]{2}$/.test(f));
            for (const h of hours) {
              const txt = path.join(sourceDir, y, m, d, h, 'image_ids.txt');
              if (fs.existsSync(txt)) {
                const ids = fs.readFileSync(txt, 'utf-8').split('\n').map(id => id.trim()).filter(id => id.length > 0);
                saveHourlyCache(y, m, d, h, ids);
                total++;
              }
            }
          }
        }
        process.stdout.write('.');
      }
      console.log(`\nImport complete. Copied ${total} hourly index files.`);
    } else {
      console.error('Error: type must be "json" or "hourly"');
      process.exit(1);
    }
  });

/**
 * Let the first argument stand on its own when it is unambiguous:
 * a Gyazo image ID or URL means `get`, an existing file means `upload`.
 * Anything else is left to commander so unknown commands still report as such.
 */
function expandImplicitCommand(argv: string[]): string[] {
  const args = argv.slice(2);
  const first = args[0];
  if (!first || first.startsWith('-')) {
    return argv;
  }

  const knownNames = new Set<string>(['help']);
  for (const command of program.commands) {
    knownNames.add(command.name());
    for (const alias of command.aliases()) {
      knownNames.add(alias);
    }
  }
  if (knownNames.has(first)) {
    return argv;
  }

  let implicitCommand: string | null = null;
  if (normalizeImageId(first)) {
    // A bare 32-hex ID is ambiguous; treat it as an image.
    implicitCommand = 'get';
  } else if (normalizeCollectionId(first)) {
    // Only the /collections/<id> URL form is unambiguous.
    implicitCommand = 'collection';
  } else if (fs.existsSync(first) && fs.statSync(first).isFile()) {
    implicitCommand = 'upload';
  }
  if (!implicitCommand) {
    return argv;
  }

  return [...argv.slice(0, 2), implicitCommand, ...args];
}

/**
 * The MCP server is not a commander command: it owns stdout for the whole
 * process, so it is dispatched before parsing rather than from an action.
 * The spellings a client is likely to be configured with all work.
 */
const MCP_INVOCATIONS = new Set(['--mcp-server', '--mcp', 'mcp-server', 'mcp']);

function isMcpInvocation(argv: string[]): boolean {
  const first = argv.slice(2)[0];
  return first !== undefined && MCP_INVOCATIONS.has(first);
}

if (isMcpInvocation(process.argv)) {
  // Required lazily: the MCP SDK is a large import that every other command
  // would otherwise pay for at startup.
  const { runMcpServer } = require('./mcp') as typeof import('./mcp');
  runMcpServer().catch((error: any) => {
    console.error('MCP server failed:', error?.message || error);
    process.exit(1);
  });
} else {
  program.parseAsync(expandImplicitCommand(process.argv));
}
