/**
 * The `triage` command: a search, rendered as markdown for reading rather than
 * for parsing.
 *
 * `ls` and `search` print one line per capture, which is the right shape for
 * scanning a day. Going through captures one at a time, deciding something
 * about each, wants the opposite: everything a capture carries, laid out, with
 * nothing invented and nothing hidden.
 */
import type { Command } from 'commander';
import { searchImages } from '../api';
import { ensureAccessToken } from '../credentials';
import { normalizeText } from '../format';
import { parsePositiveIntegerOption } from '../options';
import { enrichImageLocations } from '../services/memory';

/**
 * Fields worth a heading, in the order a person reads them. The id, the URLs
 * and the coordinates are deliberately absent: the id is the heading, and the
 * rest is noise when the job is deciding something about a capture.
 */
const FIELD_ORDER = [
  'created_at',
  'captured_at',
  'app',
  'title',
  'desc',
  'page_url',
  'alt_text',
  'ocr',
  'address',
  'objects',
];

const CYAN = '\u001b[36m';
const RESET = '\u001b[0m';

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * What a capture actually carries, flattened to a name and a block of text.
 * A field that is absent, null or empty is left out rather than printed as a
 * heading with nothing under it.
 */
function fieldsOf(image: any): Array<[string, string]> {
  const metadata = image?.metadata || {};
  const ocr = metadata.ocr ?? image?.ocr;
  const exif = metadata.exif_normalized ?? image?.exif_normalized;
  const address =
    metadata.exif_address?.ja?.address ?? metadata.exif_address?.en?.address ?? undefined;
  const objects = Array.isArray(metadata.localized_object_annotations)
    ? metadata.localized_object_annotations
    : metadata.localizedObjectAnnotations;

  const candidates: Record<string, string | undefined> = {
    created_at: text(image?.created_at),
    captured_at: text(image?.exif_captured_at ?? exif?.time),
    type: text(image?.type),
    permalink_url: text(image?.permalink_url),
    url: text(image?.url),
    app: text(metadata.app),
    title: text(metadata.title),
    desc: text(metadata.desc),
    page_url: text(metadata.url),
    alt_text: text(image?.alt_text),
    ocr: text(ocr?.description),
    ocr_locale: text(ocr?.locale),
    latitude: text(exif?.latitude),
    longitude: text(exif?.longitude),
    address: text(address),
    objects: Array.isArray(objects)
      ? objects
          .map((o: any) => {
            const name = text(o?.name_ja || o?.nameJa || o?.name);
            const score = typeof o?.score === 'number' ? ` (${(o.score * 100).toFixed(1)}%)` : '';
            return name ? `${name}${score}` : undefined;
          })
          .filter(Boolean)
          .join('\n') || undefined
      : undefined,
  };

  return FIELD_ORDER.map((key) => [key, candidates[key]] as [string, string | undefined]).filter(
    (entry): entry is [string, string] => Boolean(entry[1]),
  );
}

export function registerTriageCommand(program: Command): void {
  program
    .command('triage [query]')
    .description('Search, and print everything each capture carries as markdown')
    .option('-q, --query <query>', 'the search query')
    .option('-p, --page <number>', 'page number', '1')
    .option('-l, --limit <number>', 'captures per page', '20')
    .option('--color <when>', 'colour the headings: auto, always or never', 'auto')
    .option('--no-cache', 'force fetch from API')
    .action(async (positional, options) => {
      await ensureAccessToken();
      try {
        const query = normalizeText(options.query || positional);
        if (!query) {
          console.error('Error: Query is required.');
          console.error('Hint: gyazo triage -q "password"');
          process.exit(1);
        }

        const page = parsePositiveIntegerOption(options.page, '--page');
        const limit = parsePositiveIntegerOption(options.limit, '--limit');
        const found = await searchImages(query, page, limit);

        // Colour when a person is reading, not when the output is being piped
        // into a file. `--color always` is for a pager that understands it.
        const colour =
          options.color === 'always' ||
          (options.color !== 'never' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

        console.log(`triage: ${query}`);
        if (!found || found.length === 0) {
          console.log('');
          console.log('No captures matched.');
          return;
        }

        // The search endpoint returns a lean image: no OCR, no coordinates.
        // Triage is about what a capture says, so fetch the rest.
        const images = await enrichImageLocations(found, {
          useCache: options.cache !== false,
          limit: found.length,
        });

        console.log(`${images.images.length} captures, page ${page}.`);
        images.images.forEach((image: any, index: number) => {
          console.log('');
          if (index > 0) {
            console.log('---');
            console.log('');
          }
          const heading = `# ${image.image_id}`;
          console.log(colour ? `${CYAN}${heading}${RESET}` : heading);
          for (const [key, value] of fieldsOf(image)) {
            console.log('');
            console.log(`## ${key}`);
            console.log('');
            console.log(value);
          }
        });
      } catch (error: any) {
        console.error('Error triaging images:', error.message);
        process.exit(1);
      }
    });
}
