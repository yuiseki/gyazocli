/**
 * What the captures add up to: which applications and sites a day came from,
 * which tags and places recur, when in the day the uploads happen, and the
 * markdown the stats and summary commands print.
 *
 * Every ranking has two paths. One reads the hourly metadata buckets, which is
 * what a date range uses, and one reads whole images by ID, which is what an
 * arbitrary set of IDs uses. They agree on the shape they return.
 */
import { loadImageCache, loadHourlyCache, type HourlyMetadataKind } from '../storage';
import {
  type ParsedDateOption,
  WEEKDAY_LABELS,
  formatDateYmd,
  getDatePartsInRange,
  getDateHourStrings,
} from '../dates';
import {
  normalizeText,
  extractImageApps,
  extractImageDomains,
  extractImageLocations,
  extractImageTags,
} from '../format';
import { loadOrBuildHourlyMetadataEntries, type MetadataValueExtractor } from './memory';

export type AppRank = {
  app: string;
  count: number;
};

export type DomainRank = {
  domain: string;
  count: number;
};

export type LocationRank = {
  location: string;
  count: number;
};

export type TagRank = {
  tag: string;
  count: number;
};

export type TagRankingSummary = {
  ranking: TagRank[];
  imageCountWithTags: number;
  totalTagAssignments: number;
};

export type UploadTimeSummary = {
  totalImages: number;
  byHour: Array<{ hour: number; count: number }>;
  byWeekday: Array<{ weekday: number; count: number }>;
};

export type DailyUploadCount = {
  date: string;
  count: number;
};

export type DailySummary = {
  date: string;
  imageCount: number;
  apps: AppRank[];
  domains: DomainRank[];
  tags: TagRank[];
  locations: LocationRank[];
};

export type RankingFromHourlySummary = {
  ranking: Array<{ key: string; count: number }>;
  totalImages: number;
  imageCountWithValues: number;
  totalAssignments: number;
};

export function aggregateRankingFromHourlyMetadataCache(
  targetDate: ParsedDateOption,
  metadataKind: HourlyMetadataKind,
  extractValues: MetadataValueExtractor,
): RankingFromHourlySummary {
  const counts = new Map<string, number>();
  const seenImageIds = new Set<string>();
  let totalImages = 0;
  let imageCountWithValues = 0;
  let totalAssignments = 0;

  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();

  for (const date of dates) {
    for (const hour of hours) {
      const entries = loadOrBuildHourlyMetadataEntries(
        metadataKind,
        date.year,
        date.month,
        date.day,
        hour,
        extractValues,
      );

      for (const [imageId, values] of Object.entries(entries)) {
        if (seenImageIds.has(imageId)) continue;
        seenImageIds.add(imageId);
        totalImages++;

        if (values.length === 0) continue;
        imageCountWithValues++;
        totalAssignments += values.length;
        for (const value of values) {
          counts.set(value, (counts.get(value) || 0) + 1);
        }
      }
    }
  }

  const ranking = Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });

  return {
    ranking,
    totalImages,
    imageCountWithValues,
    totalAssignments,
  };
}

export function buildAppsRankingFromCache(imageIds: string[]): AppRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const apps = extractImageApps(image);
    if (apps.length === 0) continue;

    const app = apps[0];
    counts.set(app, (counts.get(app) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.app.localeCompare(b.app);
    });
}

export function buildAppsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: AppRank[];
  totalImages: number;
  imageCountWithApps: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'apps', extractImageApps);
  return {
    ranking: summary.ranking.map(item => ({ app: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithApps: summary.imageCountWithValues,
  };
}

export function buildDomainsRankingFromCache(imageIds: string[]): DomainRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const domains = extractImageDomains(image);
    if (domains.length === 0) continue;

    const domain = domains[0];
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.domain.localeCompare(b.domain);
    });
}

export function buildDomainsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: DomainRank[];
  totalImages: number;
  imageCountWithDomains: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'domains', extractImageDomains);
  return {
    ranking: summary.ranking.map(item => ({ domain: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithDomains: summary.imageCountWithValues,
  };
}

export function buildLocationsRankingFromCache(imageIds: string[]): LocationRank[] {
  const counts = new Map<string, number>();

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const locations = extractImageLocations(image);
    if (locations.length === 0) continue;

    const location = locations[0];
    counts.set(location, (counts.get(location) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.location.localeCompare(b.location);
    });
}

export function buildLocationsRankingFromHourlyCache(targetDate: ParsedDateOption): {
  ranking: LocationRank[];
  totalImages: number;
  imageCountWithLocations: number;
} {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'locations', extractImageLocations);
  return {
    ranking: summary.ranking.map(item => ({ location: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithLocations: summary.imageCountWithValues,
  };
}

export function buildTagsRankingFromCache(imageIds: string[]): TagRankingSummary {
  const counts = new Map<string, number>();
  let imageCountWithTags = 0;
  let totalTagAssignments = 0;

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const tags = extractImageTags(image);
    if (tags.length === 0) continue;

    imageCountWithTags++;
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
      totalTagAssignments++;
    }
  }

  const ranking = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });

  return {
    ranking,
    imageCountWithTags,
    totalTagAssignments,
  };
}

export function buildTagsRankingFromHourlyCache(targetDate: ParsedDateOption): TagRankingSummary & { totalImages: number } {
  const summary = aggregateRankingFromHourlyMetadataCache(targetDate, 'tags', extractImageTags);
  return {
    ranking: summary.ranking.map(item => ({ tag: item.key, count: item.count })),
    totalImages: summary.totalImages,
    imageCountWithTags: summary.imageCountWithValues,
    totalTagAssignments: summary.totalAssignments,
  };
}

export function buildUploadTimeSummaryFromHourlyCache(targetDate: ParsedDateOption): UploadTimeSummary {
  const seen = new Set<string>();
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const weekdayCounts = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();

  for (const date of dates) {
    for (const hourText of hours) {
      const hour = Number(hourText);
      const imageIds = loadHourlyCache(date.year, date.month, date.day, hourText) || [];
      const weekday = new Date(
        Number(date.year),
        Number(date.month) - 1,
        Number(date.day),
        hour,
        0,
        0,
        0,
      ).getDay();

      for (const imageId of imageIds) {
        if (seen.has(imageId)) continue;
        seen.add(imageId);
        hourCounts[hour].count++;
        weekdayCounts[weekday].count++;
      }
    }
  }

  return {
    totalImages: seen.size,
    byHour: hourCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.hour - b.hour;
    }),
    byWeekday: weekdayCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.weekday - b.weekday;
    }),
  };
}

export function buildUploadTimeSummaryFromImageCache(
  imageIds: string[],
  targetDate: ParsedDateOption,
): UploadTimeSummary {
  const seen = new Set<string>();
  const hourCounts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const weekdayCounts = Array.from({ length: 7 }, (_, weekday) => ({ weekday, count: 0 }));

  for (const imageId of imageIds) {
    if (seen.has(imageId)) continue;

    const image = loadImageCache(imageId);
    const createdAtText = normalizeText(image?.created_at);
    if (!createdAtText) continue;

    const createdAt = new Date(createdAtText);
    if (Number.isNaN(createdAt.getTime())) continue;
    if (createdAt < targetDate.start || createdAt > targetDate.end) continue;

    seen.add(imageId);
    hourCounts[createdAt.getHours()].count++;
    weekdayCounts[createdAt.getDay()].count++;
  }

  return {
    totalImages: seen.size,
    byHour: hourCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.hour - b.hour;
    }),
    byWeekday: weekdayCounts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.weekday - b.weekday;
    }),
  };
}

export function buildDailyUploadCountsFromHourlyCache(targetDate: ParsedDateOption): DailyUploadCount[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();
  const byDate = new Map<string, Set<string>>();

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    if (!byDate.has(dateLabel)) {
      byDate.set(dateLabel, new Set());
    }

    const ids = byDate.get(dateLabel)!;
    for (const hour of hours) {
      const imageIds = loadHourlyCache(date.year, date.month, date.day, hour) || [];
      for (const imageId of imageIds) ids.add(imageId);
    }
  }

  return dates.map(date => {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    return {
      date: dateLabel,
      count: byDate.get(dateLabel)?.size || 0,
    };
  });
}

export function buildDailyUploadCountsFromImageCache(
  imageIds: string[],
  targetDate: ParsedDateOption,
): DailyUploadCount[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const byDate = new Map<string, Set<string>>();

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    byDate.set(dateLabel, new Set());
  }

  for (const imageId of imageIds) {
    const image = loadImageCache(imageId);
    const createdAtText = normalizeText(image?.created_at);
    if (!createdAtText) continue;

    const createdAt = new Date(createdAtText);
    if (Number.isNaN(createdAt.getTime())) continue;
    if (createdAt < targetDate.start || createdAt > targetDate.end) continue;

    const dateLabel = formatDateYmd(createdAt);
    const ids = byDate.get(dateLabel);
    if (!ids) continue;
    ids.add(imageId);
  }

  return dates.map(date => {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    return {
      date: dateLabel,
      count: byDate.get(dateLabel)?.size || 0,
    };
  });
}

export function buildDailySummariesFromImageCache(targetDate: ParsedDateOption): DailySummary[] {
  const dates = getDatePartsInRange(targetDate.start, targetDate.end);
  const hours = getDateHourStrings();
  const summaries: DailySummary[] = [];

  for (const date of dates) {
    const dateLabel = `${date.year}-${date.month}-${date.day}`;
    const imageIds = new Set<string>();

    for (const hour of hours) {
      const ids = loadHourlyCache(date.year, date.month, date.day, hour) || [];
      for (const id of ids) imageIds.add(id);
    }

    const appCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const locationCounts = new Map<string, number>();

    for (const imageId of imageIds) {
      const image = loadImageCache(imageId);
      if (!image) continue;

      for (const app of extractImageApps(image)) {
        appCounts.set(app, (appCounts.get(app) || 0) + 1);
      }
      for (const domain of extractImageDomains(image)) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
      for (const tag of extractImageTags(image)) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
      for (const location of extractImageLocations(image)) {
        locationCounts.set(location, (locationCounts.get(location) || 0) + 1);
      }
    }

    const sortEntries = (a: [string, number], b: [string, number]) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    };

    const apps = Array.from(appCounts.entries())
      .sort(sortEntries)
      .map(([app, count]) => ({ app, count }));
    const domains = Array.from(domainCounts.entries())
      .sort(sortEntries)
      .map(([domain, count]) => ({ domain, count }));
    const tags = Array.from(tagCounts.entries())
      .sort(sortEntries)
      .map(([tag, count]) => ({ tag, count }));
    const locations = Array.from(locationCounts.entries())
      .sort(sortEntries)
      .map(([location, count]) => ({ location, count }));

    summaries.push({
      date: dateLabel,
      imageCount: imageIds.size,
      apps,
      domains,
      tags,
      locations,
    });
  }

  return summaries;
}

export function appendStatsRankSection(
  lines: string[],
  title: string,
  rows: Array<{ label: string; count: number }>,
  top: number,
): void {
  lines.push(`### ${title}`);
  const filtered = rows.filter(row => row.count > 0).slice(0, top);
  if (filtered.length === 0) {
    lines.push('- No data');
    lines.push('');
    return;
  }

  for (const row of filtered) {
    lines.push(`- ${row.label}: ${row.count}`);
  }
  lines.push('');
}

export function renderStatsMarkdown(params: {
  startLabel: string;
  endLabel: string;
  days: number;
  totalUploads: number;
  uploadTime: UploadTimeSummary;
  apps: AppRank[];
  domains: DomainRank[];
  tags: TagRank[];
  top: number;
}): string {
  const lines: string[] = [];
  lines.push('## Gyazo Stats');
  lines.push('');
  lines.push(`- Window: ${params.startLabel} to ${params.endLabel} (${params.days} days)`);
  lines.push(`- Total uploads: ${params.totalUploads}`);
  lines.push('');

  appendStatsRankSection(
    lines,
    'Upload Time (Hour)',
    params.uploadTime.byHour.map(item => ({
      label: `${String(item.hour).padStart(2, '0')}:00`,
      count: item.count,
    })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Upload Weekday',
    params.uploadTime.byWeekday.map(item => ({
      label: WEEKDAY_LABELS[item.weekday] || String(item.weekday),
      count: item.count,
    })),
    Math.min(params.top, 7),
  );

  appendStatsRankSection(
    lines,
    'Apps',
    params.apps.map(item => ({ label: item.app, count: item.count })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Domains',
    params.domains.map(item => ({ label: item.domain, count: item.count })),
    params.top,
  );

  appendStatsRankSection(
    lines,
    'Tags',
    params.tags.map(item => ({ label: `#${item.tag}`, count: item.count })),
    params.top,
  );

  return lines.join('\n').trimEnd();
}

export function renderSummaryText(params: {
  dateKey: string;
  dailySummaries: DailySummary[];
  limit: number;
}): string {
  const appendRankSection = (
    lines: string[],
    title: string,
    rows: Array<{ label: string; count: number }>,
    limit: number,
  ) => {
    lines.push(`- ${title}:`);
    const items = rows.filter(row => row.count > 0).slice(0, limit);
    if (items.length === 0) {
      lines.push('  - (none)');
      return;
    }
    for (const row of items) {
      lines.push(`  - ${row.label}${row.count > 1 ? ` (${row.count})` : ''}`);
    }
  };

  const lines: string[] = [];
  lines.push('## Gyazo Summary');
  lines.push('');
  lines.push(`- Window: ${params.dateKey}`);
  lines.push('');

  for (const day of params.dailySummaries) {
    lines.push(`### ${day.date}`);
    lines.push(`- Image count: ${day.imageCount}`);
    appendRankSection(
      lines,
      'Apps',
      day.apps.map(item => ({ label: item.app, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Domains',
      day.domains.map(item => ({ label: item.domain, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Tags',
      day.tags.map(item => ({ label: `#${item.tag}`, count: item.count })),
      params.limit,
    );
    appendRankSection(
      lines,
      'Locations',
      day.locations.map(item => ({ label: item.location, count: item.count })),
      params.limit,
    );
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
