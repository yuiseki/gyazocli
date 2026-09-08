/**
 * The `upload` command.
 */
import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { uploadImage } from '../api';
import { ensureAccessToken } from '../credentials';
import { parseUploadTimestamp } from '../dates';

import {
  ensureUploadDescTag,
  readStdinBuffer,
} from '../services/images';

export function registerUploadCommand(program: Command): void {
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
}
