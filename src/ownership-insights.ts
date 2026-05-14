import {
  getFileOwnershipSummaryAsync,
  type GitFileOwnershipSummary,
  type GitOwnershipContributor,
} from './git.js';

export interface OwnershipSummary {
  totalLines: number;
  fileCount: number;
  primaryOwner: string | null;
  primaryOwnerEmail: string | null;
  ownerPct: number;
  recentOwner: string | null;
  recentOwnerEmail: string | null;
  contributorCount: number;
  busFactor: number;
  topContributors: GitOwnershipContributor[];
}

function emptyOwnershipSummary(fileCount: number): OwnershipSummary {
  return {
    totalLines: 0,
    fileCount,
    primaryOwner: null,
    primaryOwnerEmail: null,
    ownerPct: 0,
    recentOwner: null,
    recentOwnerEmail: null,
    contributorCount: 0,
    busFactor: 0,
    topContributors: [],
  };
}

function computeBusFactor(contributors: GitOwnershipContributor[], threshold = 0.75): number {
  if (contributors.length === 0) return 0;
  let covered = 0;
  for (let index = 0; index < contributors.length; index += 1) {
    covered += contributors[index]?.percentage ?? 0;
    if (covered >= threshold) return index + 1;
  }
  return contributors.length;
}

function contributorKey(contributor: { authorName: string; authorEmail: string }): string {
  return `${contributor.authorEmail.trim().toLowerCase()}::${contributor.authorName.trim().toLowerCase()}`;
}

function aggregateOwnership(summaries: GitFileOwnershipSummary[]): OwnershipSummary {
  if (summaries.length === 0) return emptyOwnershipSummary(0);

  const contributors = new Map<string, { authorName: string; authorEmail: string; lineCount: number; latestAuthoredAt: string | null }>();
  let totalLines = 0;

  for (const summary of summaries) {
    totalLines += summary.totalLines;
    for (const contributor of summary.contributors) {
      const key = contributorKey(contributor);
      const existing = contributors.get(key) ?? {
        authorName: contributor.authorName,
        authorEmail: contributor.authorEmail,
        lineCount: 0,
        latestAuthoredAt: null as string | null,
      };
      existing.lineCount += contributor.lineCount;
      if (!existing.latestAuthoredAt || Date.parse(contributor.latestAuthoredAt || '1970-01-01T00:00:00.000Z') > Date.parse(existing.latestAuthoredAt || '1970-01-01T00:00:00.000Z')) {
        existing.latestAuthoredAt = contributor.latestAuthoredAt;
      }
      contributors.set(key, existing);
    }
  }

  const ranked = [...contributors.values()]
    .map(contributor => ({
      authorName: contributor.authorName,
      authorEmail: contributor.authorEmail,
      lineCount: contributor.lineCount,
      percentage: totalLines > 0 ? contributor.lineCount / totalLines : 0,
      latestAuthoredAt: contributor.latestAuthoredAt,
    }))
    .sort((left, right) => right.lineCount - left.lineCount || Date.parse(right.latestAuthoredAt || '1970-01-01T00:00:00.000Z') - Date.parse(left.latestAuthoredAt || '1970-01-01T00:00:00.000Z'));

  const primary = ranked[0] ?? null;
  const recent = [...ranked]
    .sort((left, right) => Date.parse(right.latestAuthoredAt || '1970-01-01T00:00:00.000Z') - Date.parse(left.latestAuthoredAt || '1970-01-01T00:00:00.000Z') || right.lineCount - left.lineCount)[0] ?? null;

  return {
    totalLines,
    fileCount: summaries.length,
    primaryOwner: primary?.authorName ?? null,
    primaryOwnerEmail: primary?.authorEmail ?? null,
    ownerPct: primary?.percentage ?? 0,
    recentOwner: recent?.authorName ?? null,
    recentOwnerEmail: recent?.authorEmail ?? null,
    contributorCount: ranked.length,
    busFactor: computeBusFactor(ranked),
    topContributors: ranked.slice(0, 5),
  };
}

export async function summarizeOwnershipForFilesAsync(
  projectRoot: string,
  filePaths: string[],
  opts?: { maxFiles?: number }
): Promise<OwnershipSummary> {
  const uniqueFiles = [...new Set(filePaths.filter(Boolean))].slice(0, opts?.maxFiles ?? 20);
  if (uniqueFiles.length === 0) return emptyOwnershipSummary(0);

  const summaries = (await Promise.all(uniqueFiles.map(filePath => getFileOwnershipSummaryAsync(projectRoot, filePath))))
    .filter((summary): summary is GitFileOwnershipSummary => summary !== null);

  if (summaries.length === 0) return emptyOwnershipSummary(uniqueFiles.length);
  return aggregateOwnership(summaries);
}