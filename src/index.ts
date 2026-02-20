#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { listImages, getImageDetail, searchImages } from './api';
import { saveImageCache, loadImageCache, getCacheDir, saveHourlyCache, loadHourlyCache } from './storage';
import { ensureAccessToken, getStoredConfig, setStoredConfig } from './credentials';

const program = new Command();

program
  .name('gyazo')
  .description('Gyazo Memory CLI for AI Secretary')
  .version('1.0.0');

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
  .action((key) => {
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

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
}

program
  .command('list')
  .alias('ls')
  .description('List recent images')
  .option('-p, --page <number>', 'page number', '1')
  .option('-l, --limit <number>', 'items per page', '20')
  .option('-j, --json', 'output as JSON')
  .option('-H, --hour <yyyy-mm-dd-hh>', 'target hour')
  .action(async (options) => {
    await ensureAccessToken();
    try {
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
        
        const images = imageIds.map(id => loadImageCache(id)).filter(img => img !== null);
        if (options.json) {
          console.log(JSON.stringify(images, null, 2));
        } else {
          images.forEach(img => {
            console.log(`- [${img.created_at}] ${img.image_id}: ${img.permalink_url}`);
            if (img.metadata?.title) console.log(`  Title: ${img.metadata.title}`);
          });
        }
        return;
      }

      const images = await listImages(parseInt(options.page, 10), parseInt(options.limit, 10));
      if (options.json) {
        console.log(JSON.stringify(images, null, 2));
      } else {
        images.forEach(img => {
          console.log(`- [${img.created_at}] ${img.image_id}: ${img.permalink_url}`);
        });
      }
    } catch (error: any) {
      console.error('Error listing images:', error.message);
    }
  });

program
  .command('get <image_id>')
  .description('Get detailed metadata for an image')
  .option('-j, --json', 'output as JSON')
  .option('--no-cache', 'force fetch from API')
  .action(async (imageId, options) => {
    await ensureAccessToken();
    try {
      let image = options.cache !== false ? loadImageCache(imageId) : null;
      if (!image) {
        image = await getImageDetail(imageId);
        saveImageCache(imageId, image);
      }

      if (options.json) {
        console.log(JSON.stringify(image, null, 2));
      } else {
        console.log(`ID: ${image.image_id}`);
        console.log(`URL: ${image.permalink_url}`);
        console.log(`Created: ${image.created_at}`);
        if (image.metadata?.title) console.log(`Title: ${image.metadata.title}`);
        if (image.ocr?.description) {
          console.log('--- OCR ---');
          console.log(image.ocr.description);
        }
      }
    } catch (error: any) {
      console.error('Error getting image:', error.message);
    }
  });

program
  .command('search <query>')
  .description('Search images')
  .option('-j, --json', 'output as JSON')
  .action(async (query, options) => {
    await ensureAccessToken();
    try {
      const images = await searchImages(query);
      if (options.json) {
        console.log(JSON.stringify(images, null, 2));
      } else {
        images.forEach(img => {
          console.log(`- [${img.created_at}] ${img.image_id}: ${img.permalink_url}`);
        });
      }
    } catch (error: any) {
      console.error('Error searching images:', error.message);
    }
  });

program
  .command('sync')
  .description('Sync images from yesterday back to N days')
  .option('--days <number>', 'number of days to sync', '1')
  .option('--max-pages <number>', 'max pages to fetch', '10')
  .action(async (options) => {
    await ensureAccessToken();
    const days = parseInt(options.days, 10);
    const maxPages = parseInt(options.maxPages, 10);
    
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);
    
    const limitDate = new Date(now);
    limitDate.setDate(limitDate.getDate() - days - 1);
    limitDate.setHours(0, 0, 0, 0);

    console.log(`Syncing images between ${limitDate.toISOString()} and ${yesterday.toISOString()}...`);

    const hourlyIndices: Map<string, Set<string>> = new Map();

    for (let page = 1; page <= maxPages; page++) {
      const images = await listImages(page, 100);
      if (images.length === 0) break;

      let reachedLimit = false;
      for (const img of images) {
        const createdAt = new Date(img.created_at);
        
        if (createdAt > yesterday) {
          // Skip today's images
          continue;
        }
        
        if (createdAt < limitDate) {
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

program.parseAsync(process.argv);
