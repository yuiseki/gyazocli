/**
 * The `coverage` command: how much of the account is actually cached, measured
 * against its true counts from images_summary. The listing and search cannot
 * enumerate the whole account, so counting what is cached is not the real total;
 * this is the honest picture of what is still only on Gyazo -- the salvage map.
 *
 * `--month` breaks it down by month so a backfill can target exactly the months
 * that are missing, instead of re-walking ones already in hand.
 */
import type { Command } from 'commander';
import { loadCookieHeader } from '../cookies';
import { fetchImagesSummary } from '../api';
import { countCacheByMonth } from '../storage';

interface CoverageRow {
  key: string; // 'YYYY' or 'YYYY-MM'
  true: number;
  cached: number;
  missing: number;
  withSize: number;
  sizeMissing: number;
}

function sum(obj: Record<string, number> | undefined): number {
  return obj ? Object.values(obj).reduce((a, b) => a + Number(b), 0) : 0;
}

export function registerCoverageCommand(program: Command): void {
  program
    .command('coverage')
    .description("Cache coverage against the account's true counts (needs cookies)")
    .option('--month', 'break the table down by month instead of by year')
    .option('--incomplete', 'show only rows still missing images')
    .option('--cookies <path>', 'gyazo.com cookies')
    .option('-j, --json', 'output as JSON')
    .action(async (options) => {
      const cookieHeader = loadCookieHeader(options.cookies);
      if (!cookieHeader) {
        console.error('Error: coverage needs gyazo.com cookies.');
        console.error('Put them in ~/.config/gyazo/cookie.json or pass --cookies <path>.');
        process.exit(1);
      }
      let summary: any;
      try {
        summary = await fetchImagesSummary(cookieHeader);
      } catch (error: any) {
        console.error('Error fetching images_summary:', error.message);
        process.exit(1);
      }
      const monthly: Record<string, Record<string, number>> = summary?.monthly_counts || {};
      const { byMonth: cachedByMonth, sizedByMonth } = countCacheByMonth();

      const years = Array.from(new Set([...Object.keys(monthly), ...Object.keys(cachedByMonth)])).sort();

      const rows: CoverageRow[] = [];
      let trueTotal = 0;
      let cachedTotal = 0;
      let sizedTotal = 0;
      for (const year of years) {
        if (options.month) {
          const months = Array.from(
            new Set([
              ...Object.keys(monthly[year] || {}),
              ...Object.keys(cachedByMonth[year] || {}),
            ]),
          ).sort((a, b) => Number(a) - Number(b));
          for (const month of months) {
            const t = Number(monthly[year]?.[month] || 0);
            const c = Number(cachedByMonth[year]?.[month] || 0);
            const s = Number(sizedByMonth[year]?.[month] || 0);
            trueTotal += t;
            cachedTotal += c;
            sizedTotal += s;
            rows.push({
              key: `${year}-${String(Number(month)).padStart(2, '0')}`,
              true: t,
              cached: c,
              missing: Math.max(0, t - c),
              withSize: s,
              sizeMissing: Math.max(0, t - s),
            });
          }
        } else {
          const t = sum(monthly[year]);
          const c = sum(cachedByMonth[year]);
          const s = sum(sizedByMonth[year]);
          trueTotal += t;
          cachedTotal += c;
          sizedTotal += s;
          rows.push({
            key: year,
            true: t,
            cached: c,
            missing: Math.max(0, t - c),
            withSize: s,
            sizeMissing: Math.max(0, t - s),
          });
        }
      }

      const shown = options.incomplete ? rows.filter((r) => r.missing > 0) : rows;

      if (options.json) {
        console.log(JSON.stringify({
          trueTotal,
          cachedTotal,
          sizedTotal,
          missing: Math.max(0, trueTotal - cachedTotal),
          sizeMissing: Math.max(0, trueTotal - sizedTotal),
          rows: shown,
        }, null, 2));
        return;
      }

      const n = (v: number) => v.toLocaleString('en-US');
      const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
      console.log(
        `True total: ${n(trueTotal)}   ` +
          `Cached: ${n(cachedTotal)} (${pct(cachedTotal, trueTotal)})   ` +
          `With size: ${n(sizedTotal)} (${pct(sizedTotal, trueTotal)})   ` +
          `Missing: ${n(Math.max(0, trueTotal - cachedTotal))}`,
      );
      console.log('');
      const label = options.month ? 'month  ' : 'year';
      console.log(`${label} |     true |   cached | cov% |  missing | withSize | cov% |  missing`);
      for (const r of shown) {
        console.log(
          `${r.key} | ${String(r.true).padStart(8)} | ${String(r.cached).padStart(8)} | ${pct(r.cached, r.true).padStart(4)} | ${String(r.missing).padStart(8)} | ` +
            `${String(r.withSize).padStart(8)} | ${pct(r.withSize, r.true).padStart(4)} | ${String(r.sizeMissing).padStart(8)}`,
        );
      }
    });
}
