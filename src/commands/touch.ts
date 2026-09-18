/**
 * `gyazo touch <url...>`: cycle a public capture's access policy to bring it
 * back.
 *
 * After the 2026-09-11 incident some public images stopped being delivered.
 * Flipping one to only_me and back to anyone re-materialises it. This does that
 * cycle, leaving the capture public, so a Cosense page's embedded Gyazo images
 * can be restored. Pipe a list in from `cosensecli list-gyazo`.
 *
 * It refuses a capture that is already only_me: cycling that would end at
 * anyone and expose something meant to stay private.
 */
import readline from 'node:readline';
import type { Command } from 'commander';
import { getImageDetail, touchAccessPolicy } from '../api';
import { ensureAccessToken } from '../credentials';
import { loadCookieHeader } from '../cookies';
import { normalizeImageId } from '../ids';

async function collectFromStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const lines: string[] = [];
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

export function registerTouchCommand(program: Command): void {
  program
    .command('touch [url...]')
    .description('Cycle a public capture only_me→anyone to restore it (needs cookies)')
    .option('--cookies <path>', 'gyazo.com cookies')
    .action(async (urls: string[], options) => {
      await ensureAccessToken();

      const inputs = [...(urls || []), ...(await collectFromStdin())];
      if (inputs.length === 0) {
        console.error('Error: no URLs given.');
        console.error('Hint: gyazo touch https://gyazo.com/<id>');
        console.error('      cosensecli list-gyazo | gyazo touch');
        process.exit(1);
      }

      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: touch needs gyazo.com cookies, which were not found.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }

      // A list from `cosensecli list-gyazo` is full of things that are not
      // captures: /search/... , /signup, other hosts. Those are noise, not
      // failures, so they are dropped before anything is attempted and never
      // reach the exit code. Duplicates (the same capture as a permalink and
      // as an i.gyazo.com URL) collapse to one.
      const seen = new Set<string>();
      const imageIds: string[] = [];
      let ignored = 0;
      for (const input of inputs) {
        const imageId = normalizeImageId(input);
        if (!imageId) {
          ignored++;
          continue;
        }
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        imageIds.push(imageId);
      }

      if (imageIds.length === 0) {
        console.log(`No captures to touch (${ignored} non-image URLs ignored).`);
        return;
      }

      let touched = 0;
      let failed = 0;
      for (const imageId of imageIds) {
        try {
          const image = await getImageDetail(imageId);
          // Never turn a deliberately private capture public.
          if (image?.access_policy === 'only_me') {
            console.error(`skip: ${imageId} is only_me; refusing to make it public`);
            failed++;
            continue;
          }
          await touchAccessPolicy(imageId, cookieHeader);
          console.log(`touched: https://gyazo.com/${imageId}`);
          touched++;
        } catch (error: any) {
          console.error(`failed: ${imageId}: ${error.message}`);
          failed++;
        }
      }

      console.log(`\n${touched} touched, ${failed} failed, ${ignored} ignored.`);
      // Only a real capture that could not be touched is an error; noise is not.
      if (failed > 0) process.exit(1);
    });
}
