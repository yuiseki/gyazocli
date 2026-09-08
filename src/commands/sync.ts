/**
 * The `sync` command, which fills the cache.
 */
import type { Command } from 'commander';
import { listImages, getImageDetail } from '../api';
import {
  saveImageCache,
  loadImageCache,
  saveHourlyCache,
  loadHourlyCache,
} from '../storage';
import { ensureAccessToken } from '../credentials';
import { parseDateOption } from '../dates';
import { parsePositiveIntegerOption } from '../options';

export function registerSyncCommand(program: Command): void {
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
}
