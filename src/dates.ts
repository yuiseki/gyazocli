/**
 * Dates, as this CLI means them: a day is a local day, because that is how the
 * cache is laid out and how a person asking for "today" means it. Parses what
 * --date and --days accept, builds the ranges the aggregations walk, and keys
 * the hourly cache buckets.
 */

import { parsePositiveIntegerOption } from './options';

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isToday(date: Date): boolean {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
}

export function parseUploadTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error('Error: --timestamp must be a unix timestamp in seconds.');
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    console.error('Error: --timestamp is out of range.');
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  if (parsed > now) {
    console.error('Error: --timestamp must be current time or in the past.');
    process.exit(1);
  }
  return parsed;
}

export type ParsedDateOption = {
  granularity: 'day' | 'month' | 'year';
  dateKey: string;
  start: Date;
  end: Date;
};

export function parseDateOption(value?: string): ParsedDateOption {
  if (!value) {
    const today = new Date();
    const year = String(today.getFullYear());
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return {
      granularity: 'day',
      dateKey: `${year}-${month}-${day}`,
      start: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0),
      end: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999),
    };
  }

  if (/^\d{4}$/.test(value)) {
    const year = Number(value);
    return {
      granularity: 'year',
      dateKey: value,
      start: new Date(year, 0, 1, 0, 0, 0, 0),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  if (/^\d{4}-\d{2}$/.test(value)) {
    const [yearText, monthText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const probe = new Date(year, month - 1, 1);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1) {
      console.error('Error: --date month is invalid.');
      process.exit(1);
    }
    return {
      granularity: 'month',
      dateKey: value,
      start: new Date(year, month - 1, 1, 0, 0, 0, 0),
      end: new Date(year, month, 0, 23, 59, 59, 999),
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [yearText, monthText, dayText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const probe = new Date(year, month - 1, day);
    if (
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      console.error('Error: --date day is invalid.');
      process.exit(1);
    }
    return {
      granularity: 'day',
      dateKey: value,
      start: new Date(year, month - 1, day, 0, 0, 0, 0),
      end: new Date(year, month - 1, day, 23, 59, 59, 999),
    };
  }

  console.error('Error: --date format must be yyyy or yyyy-mm or yyyy-mm-dd.');
  process.exit(1);
}

export function formatDateYmd(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildRecentWeekRangeUntilYesterday(): ParsedDateOption {
  const today = new Date();

  const end = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
    23,
    59,
    59,
    999,
  );
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 8,
    0,
    0,
    0,
    0,
  );

  return {
    granularity: 'day',
    dateKey: `${formatDateYmd(start)}..${formatDateYmd(end)}`,
    start,
    end,
  };
}

export function resolveRankingRangeOption(options: { date?: string; today?: boolean }): ParsedDateOption {
  if (options.today && options.date) {
    console.error('Error: --today and --date cannot be used together.');
    process.exit(1);
  }
  if (options.today) {
    return parseDateOption();
  }
  if (options.date) {
    return parseDateOption(options.date);
  }
  return buildRecentWeekRangeUntilYesterday();
}

export function buildStatsDateRange(dateOption: string | undefined, daysOption: string): {
  range: ParsedDateOption;
  days: number;
  startLabel: string;
  endLabel: string;
} {
  if (!dateOption && daysOption === '7') {
    const weekly = buildRecentWeekRangeUntilYesterday();
    return {
      range: weekly,
      days: 7,
      startLabel: formatDateYmd(weekly.start),
      endLabel: formatDateYmd(weekly.end),
    };
  }

  const days = parsePositiveIntegerOption(daysOption, '--days');
  let endDate: Date;

  if (dateOption) {
    const parsed = parseDateOption(dateOption);
    endDate = new Date(parsed.end);
  } else {
    const now = new Date();
    endDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      59,
      59,
      999,
    );
  }

  const startDate = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
    0,
    0,
    0,
    0,
  );
  startDate.setDate(startDate.getDate() - (days - 1));

  const startLabel = formatDateYmd(startDate);
  const endLabel = formatDateYmd(endDate);

  return {
    range: {
      granularity: 'day',
      dateKey: `${startLabel}..${endLabel}`,
      start: startDate,
      end: endDate,
    },
    days,
    startLabel,
    endLabel,
  };
}

export function getDateHourStrings(): string[] {
  const hours: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    hours.push(String(hour).padStart(2, '0'));
  }
  return hours;
}

export function buildHourlyBucketKey(year: string, month: string, day: string, hour: string): string {
  return `${year}-${month}-${day}-${hour}`;
}

export function splitHourlyBucketKey(key: string): { year: string; month: string; day: string; hour: string } {
  const [year, month, day, hour] = key.split('-');
  return { year, month, day, hour };
}

export function toDateParts(date: Date): { year: string; month: string; day: string; hour: string } {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
  };
}

export function getDatePartsInRange(start: Date, end: Date): Array<{ year: string; month: string; day: string }> {
  const dates: Array<{ year: string; month: string; day: string }> = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0, 0);

  while (cursor.getTime() <= last.getTime()) {
    dates.push({
      year: String(cursor.getFullYear()),
      month: String(cursor.getMonth() + 1).padStart(2, '0'),
      day: String(cursor.getDate()).padStart(2, '0'),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

/**
 * `yyyy-mm-dd-hh`, the shape the hourly cache is keyed by. Returns null rather
 * than reporting, because how to report differs between the CLI and the MCP
 * server.
 */
export function parseHourOption(
  value: string,
): { year: string; month: string; day: string; hour: string } | null {
  const parts = (value || '').split('-');
  if (parts.length !== 4) return null;
  const [year, month, day, hour] = parts;
  return { year, month, day, hour };
}
