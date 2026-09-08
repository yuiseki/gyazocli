/**
 * The `collection` command.
 */
import type { Command } from 'commander';
import { resolveAccessToken } from '../credentials';
import {
  requireCollectionId,
  parseCollectionSort,
  readCollection,
  printCollectionMarkdown,
} from '../services/collections';

export function registerCollectionCommand(program: Command): void {
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
        const { collection, images } = await readCollection(collectionId, {
          anonymous: Boolean(options.anonymous),
          sort,
        });

        if (options.json) {
          console.log(JSON.stringify(collection, null, 2));
          return;
        }

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
}
