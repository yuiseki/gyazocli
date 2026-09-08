/**
 * The `get` command: one capture in detail.
 */
import type { Command } from 'commander';
import { getImageDetail } from '../api';
import {
  saveImageCache,
  loadImageCache,
} from '../storage';
import { ensureAccessToken } from '../credentials';
import {
  extractOcrDescription,
  extractObjectAnnotations,
  formatObjectAnnotationLine,
} from '../format';

import { supplementAltTextFromSearchCache } from '../services/memory';
import {
  requireImageId,
  printGetMarkdown,
} from '../services/images';

export function registerGetCommand(program: Command): void {
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
}
