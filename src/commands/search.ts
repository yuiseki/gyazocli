/**
 * The `search` command.
 */
import type { Command } from 'commander';
import { searchImages } from '../api';
import { ensureAccessToken } from '../credentials';
import { normalizeText } from '../format';

import { cacheSearchResultImages } from '../services/memory';
import {
  prepareImagesForDisplay,
  printListImages,
} from '../services/images';

export function registerSearchCommand(program: Command): void {
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
}
