/**
 * The `triage` command: a search, rendered as markdown for reading rather than
 * for parsing.
 *
 * `ls` and `search` print one line per capture, which is the right shape for
 * scanning a day. Going through captures one at a time, deciding something
 * about each, wants the opposite: everything a capture carries, laid out, with
 * nothing invented and nothing hidden.
 */
import readline from 'node:readline';
import type { Command } from 'commander';
import { getImageDetail, searchImages } from '../api';
import { ensureAccessToken } from '../credentials';
import { formatCreatedAtJa, normalizeText } from '../format';
import { normalizeImageId } from '../ids';
import { parsePositiveIntegerOption } from '../options';
import { enrichImageLocations } from '../services/memory';
import {
  appendTriageEntry,
  getTriageLedgerPath,
  loadTriageVerdicts,
  type Verdict,
} from '../services/triage-ledger';

/**
 * Fields worth a heading, in the order a person reads them. The id, the URLs
 * and the coordinates are deliberately absent: the id is the heading, and the
 * rest is noise when the job is deciding something about a capture.
 */
const FIELD_ORDER = [
  // First, because it is what a triage decision often turns on.
  'access_policy',
  'created_at',
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
const ORANGE = '\u001b[38;5;208m';
/** Back to the default foreground, rather than resetting every attribute. */
const PLAIN = '\u001b[39m';

/** Operators whose value never appears in the text, so painting it is noise. */
const STRUCTURAL_KEYS = new Set(['has', 'type', 'date', 'since', 'until']);

/**
 * The parts of a query that can show up in what a capture says: bare words,
 * and the values of the operators that match text. `has:exif` contributes
 * nothing, and a negated term should not be there to find.
 */
export function highlightTermsOf(query: string): string[] {
  const terms: string[] = [];
  // Quoted values hold spaces: app:"Gyazo Android".
  for (const token of query.match(/(?:[^\s"]|"[^"]*")+/g) || []) {
    if (token.startsWith('-') || token === 'OR' || token === 'or') continue;
    const separator = token.indexOf(':');
    const raw = separator === -1 ? token : token.slice(separator + 1);
    if (separator !== -1 && STRUCTURAL_KEYS.has(token.slice(0, separator).toLowerCase())) continue;
    const value = raw.replace(/^"|"$/g, '').trim();
    if (value) terms.push(value);
  }
  return terms;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Paint every occurrence of a term, keeping the text's own case. */
function highlight(value: string, terms: string[]): string {
  if (terms.length === 0) return value;
  const pattern = new RegExp(terms.map(escapeForRegExp).join('|'), 'gi');
  return value.replace(pattern, (match) => `${ORANGE}${match}${PLAIN}`);
}

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
    // The API leaves this unset on most captures, where it means the default.
    // Reading a hundred sections looking for the ones that are not `anyone`
    // is easier when every section says which it is.
    access_policy: text(image?.access_policy) ?? 'anyone',
    created_at: image?.created_at ? formatCreatedAtJa(image.created_at) : undefined,
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
    .description('Search, and go through the captures one at a time')
    .option('-q, --query <query>', 'the search query')
    .option('-l, --limit <number>', 'how many captures to go through in this run', '20')
    .option('--max-pages <number>', 'how many search pages to walk looking for them', '20')
    .option('--id <image_id...>', 'go through exactly these captures, answered or not')
    .option('--color <when>', 'colour the headings: auto, always or never', 'auto')
    .option('-i, --interactive', 'ask about each capture and record the answer')
    .option('--no-interactive', 'print without asking, even at a terminal')
    .option('--again', 'ask again about captures already answered')
    .option('--no-cache', 'force fetch from API')
    .action(async (positional, options) => {
      await ensureAccessToken();

      const ids: string[] = options.id || [];
      const query = normalizeText(options.query || positional) || '';
      if (!query && ids.length === 0) {
        console.error('Error: Query is required.');
        console.error('Hint: gyazo triage -q "password"');
        console.error('      gyazo triage --id <image_id>   to revisit one');
        process.exit(1);
      }

      const limit = parsePositiveIntegerOption(options.limit, '--limit');
      const maxPages = parsePositiveIntegerOption(options.maxPages, '--max-pages');

      // Colour when a person is reading, not when the output is being piped
      // into a file. `--color always` is for a pager that understands it.
      const colour =
        options.color === 'always' ||
        (options.color !== 'never' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

      // Asking only makes sense with someone there to answer. A pipe on either
      // side means this is feeding a file, not a person.
      const interactive =
        options.interactive === true ||
        (options.interactive !== false &&
          Boolean(process.stdin.isTTY) &&
          Boolean(process.stdout.isTTY));

      const terms = colour ? highlightTermsOf(query) : [];

      const print = (image: any, index: number) => {
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
          console.log(highlight(value, terms));
        }
      };

      const goThrough = async (
        captures: any[],
        skipped: number,
        pagesWalked: number,
      ): Promise<void> => {
        if (!interactive) {
          captures.forEach(print);
          return;
        }

        // Lines are pulled from an iterator rather than asked for with
        // rl.question: with piped input, question() resolves once and then
        // never again, so everything after the first answer is lost.
        const lines = readline.createInterface({ input: process.stdin });
        const answers = lines[Symbol.asyncIterator]();
        const ask = async (prompt: string): Promise<string | null> => {
          process.stdout.write(prompt);
          const { value, done } = await answers.next();
          return done ? null : String(value);
        };

        const counts: Record<Verdict, number> = { safe: 0, unsafe: 0 };
        const toMakePrivate: string[] = [];
        let asked = 0;

        try {
          for (const [index, image] of captures.entries()) {
            print(image, index);
            console.log('');
            const raw = await ask('Is it safe? [Y/n] ');
            // Enter takes the default. q stops, and so does end of input: no
            // answer is not the same as "safe".
            if (raw === null) {
              console.log('');
              break;
            }
            const answer = raw.trim().toLowerCase();
            if (answer === 'q' || answer === 'quit') break;

            const verdict: Verdict = answer === 'n' || answer === 'no' ? 'unsafe' : 'safe';
            appendTriageEntry({
              image_id: image.image_id,
              verdict,
              at: new Date().toISOString(),
              query: query || undefined,
            });
            counts[verdict]++;
            asked++;

            if (verdict === 'unsafe') {
              // Gyazo's API can set an access policy at upload and never
              // after, so making this one only_me means opening its page.
              // Printed here, where the decision was made, and again at the
              // end so a session leaves one list to work through.
              const link = image.permalink_url || `https://gyazo.com/${image.image_id}`;
              toMakePrivate.push(link);
              console.log(colour ? `${ORANGE}→ ${link}${PLAIN}` : `→ ${link}`);
            }
          }
        } finally {
          lines.close();
        }

        console.log('');
        console.log(`${asked} answered: ${counts.safe} safe, ${counts.unsafe} unsafe.`);
        if (skipped > 0) {
          console.log(`${skipped} skipped as already answered, ${pagesWalked} pages walked.`);
        }
        if (toMakePrivate.length > 0) {
          console.log('');
          console.log(`${toMakePrivate.length} to make private (only_me), on their own pages:`);
          for (const link of toMakePrivate) console.log(`  ${link}`);
        }
        console.log(`Written to ${getTriageLedgerPath()}`);
      };

      try {
        console.log(`triage: ${query || ids.join(', ')}`);

        // Named captures are fetched as named, and asked about whether or not
        // they were answered before: naming one is how a mistake is corrected.
        if (ids.length > 0) {
          const named: any[] = [];
          for (const given of ids) {
            const imageId = normalizeImageId(given);
            if (!imageId) {
              console.error(`Error: '${given}' is not a Gyazo image ID or URL.`);
              process.exit(1);
            }
            named.push(await getImageDetail(imageId));
          }
          await goThrough(named, 0, 0);
          return;
        }

        // Walk the search until `limit` captures that have not been answered
        // are in hand. A page where everything is already answered is not the
        // end of the road, which is what stopping at one page made it.
        const answered = options.again ? new Map() : loadTriageVerdicts();
        const selected: any[] = [];
        let pagesWalked = 0;
        let skipped = 0;
        for (let page = 1; page <= maxPages && selected.length < limit; page++) {
          const found = await searchImages(query, page, 100);
          pagesWalked = page;
          if (!found || found.length === 0) break;

          for (const image of found) {
            if (answered.has(image.image_id)) {
              skipped++;
              continue;
            }
            selected.push(image);
            if (selected.length >= limit) break;
          }

          if (found.length < 100) break;
        }

        if (selected.length === 0) {
          console.log('');
          if (skipped > 0) {
            console.log(
              `Nothing left to ask about: ${skipped} already answered, ` +
                `${pagesWalked} pages walked.`,
            );
            console.log(`Answers so far: ${getTriageLedgerPath()}`);
          } else {
            console.log('No captures matched.');
          }
          return;
        }

        // The search endpoint returns a lean image: no OCR, no coordinates.
        // Triage is about what a capture says, so fetch the rest.
        const enriched = await enrichImageLocations(selected, {
          useCache: options.cache !== false,
          limit: selected.length,
        });

        console.log(
          `${enriched.images.length} captures` +
            (skipped > 0 ? `, ${skipped} already answered and skipped` : '') +
            `, ${pagesWalked} pages walked.`,
        );
        await goThrough(enriched.images, skipped, pagesWalked);
      } catch (error: any) {
        console.error('Error triaging images:', error.message);
        process.exit(1);
      }
    });
}
