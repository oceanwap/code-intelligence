import * as path from 'path';

export interface GitCommitMetadata {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
}

export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
}

export interface GitFilePatch {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  hunks: GitDiffHunk[];
}

export interface GitWorkingTreeChange {
  path: string;
  status: string;
}

export interface GitLineRange {
  startLine: number;
  endLine: number;
}

export interface GitLineCommitHistory {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  summary: string;
  lineRanges: GitLineRange[];
}

export interface GitOwnershipContributor {
  authorName: string;
  authorEmail: string;
  lineCount: number;
  percentage: number;
  latestAuthoredAt: string | null;
}

export interface GitFileOwnershipSummary {
  filePath: string;
  totalLines: number;
  primaryOwner: GitOwnershipContributor | null;
  recentOwner: GitOwnershipContributor | null;
  contributorCount: number;
  busFactor: number;
  contributors: GitOwnershipContributor[];
}

export interface GitSymbolReferenceStats {
  count: number;
  files: string[];
  sample: Array<{ file: string; line: number }>;
}

async function parseGitDirFileAsync(dotGitFile: string): Promise<string | null> {
  try {
    const raw = await Bun.file(dotGitFile).text();
    const prefix = 'gitdir:';
    if (!raw.trim().startsWith(prefix)) return null;
    const gitDir = raw.trim().slice(prefix.length).trim();
    return path.resolve(path.dirname(dotGitFile), gitDir);
  } catch {
    return null;
  }
}

async function resolveGitDirAsync(gitRoot: string): Promise<string | null> {
  const dotGit = path.join(gitRoot, '.git');

  try {
    if (await Bun.file(path.join(dotGit, 'HEAD')).exists()) {
      return dotGit;
    }
    if (await Bun.file(dotGit).exists()) {
      return await parseGitDirFileAsync(dotGit);
    }
  } catch {
    return null;
  }

  return null;
}

function stripDiffPrefix(filePath: string): string {
  const unquoted = filePath.startsWith('"') && filePath.endsWith('"')
    ? filePath.slice(1, -1)
    : filePath;
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function parseHunkHeader(line: string): GitDiffHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
    header: (match[5] ?? '').trim(),
  };
}

async function runGitAsync(projectRoot: string, args: string[]): Promise<string> {
  const gitRoot = await findGitRootAsync(projectRoot);
  if (!gitRoot) {
    throw new Error(`Not a git repository: ${projectRoot}`);
  }

  const proc = Bun.spawn(['git', '-c', 'core.quotepath=false', ...args], {
    cwd: gitRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 0) return stdout;

  const message = stderr.trim();
  throw new Error(message || `git command failed with exit code ${exitCode}`);
}

export function findGitRoot(projectRoot: string): string | null {
  const startDir = path.resolve(projectRoot);
  const proc = Bun.spawnSync(['git', '-C', startDir, 'rev-parse', '--show-toplevel'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const output = proc.stdout.toString().trim();
  return output.length > 0 ? output : null;
}

function runGitSync(projectRoot: string, args: string[]): string | null {
  const gitRoot = findGitRoot(projectRoot);
  if (!gitRoot) return null;
  const proc = Bun.spawnSync(['git', '-C', gitRoot, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const output = proc.stdout.toString().trim();
  return output.length > 0 ? output : null;
}

function shortDetachedHead(projectRoot: string): string | null {
  const sha = runGitSync(projectRoot, ['rev-parse', '--short=8', 'HEAD']);
  if (!sha) return null;
  return `detached-${sha}`;
}

export function getCurrentBranch(projectRoot: string): string | null {
  const branch = runGitSync(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (branch) return branch;
  return shortDetachedHead(projectRoot);
}

/**
 * Sanitise a branch name so it can be used as a directory name.
 * e.g. "feature/auth-service" -> "feature-auth-service"
 */
export function branchSlug(branch: string): string {
  return (
    branch
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'default'
  );
}

/**
 * Returns the data directory for index files:
 *   git project  -> <projectRoot>/.code-intelligence/<branch-slug>/
 *   non-git      -> <projectRoot>/.code-intelligence/
 *
 * Non-git projects use a flat layout since there are no branches to isolate.
 */
export function getDataDir(projectRoot: string): string {
  const branch = getCurrentBranch(projectRoot);
  if (branch === null) {
    // Not a git repo - use flat layout, no branch subdirectory
    return path.join(projectRoot, '.code-intelligence');
  }
  return path.join(projectRoot, '.code-intelligence', branchSlug(branch));
}

export async function findGitRootAsync(projectRoot: string): Promise<string | null> {
  let dir = path.resolve(projectRoot);
  const root = path.parse(dir).root;
  while (true) {
    if (await Bun.file(path.join(dir, '.git', 'HEAD')).exists()) return dir;
    if (await Bun.file(path.join(dir, '.git')).exists()) return dir;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Returns true if projectRoot (or any ancestor) contains a .git directory.
 * Walks up the directory tree to handle nested projects.
 */
export function isGitRepo(projectRoot: string): boolean {
  return findGitRoot(projectRoot) !== null;
}

export async function getCurrentBranchAsync(projectRoot: string): Promise<string | null> {
  const gitRoot = await findGitRootAsync(projectRoot);
  if (!gitRoot) return null;

  try {
    const gitDir = await resolveGitDirAsync(gitRoot);
    if (!gitDir) return null;
    const headFile = path.join(gitDir, 'HEAD');
    const head = (await Bun.file(headFile).text()).trim();
    if (head.startsWith('ref: refs/heads/')) {
      return head.slice('ref: refs/heads/'.length);
    }
    return `detached-${head.slice(0, 8)}`;
  } catch {
    return null;
  }
}

export async function getHeadCommitAsync(projectRoot: string): Promise<string | null> {
  if (!await isGitRepoAsync(projectRoot)) return null;
  try {
    return (await runGitAsync(projectRoot, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/**
 * Count how many recent commits touched each indexable file.
 * Returns paths relative to projectRoot (forward-slash normalized).
 */
export async function getFileChurnAsync(projectRoot: string, maxCount = 200): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const gitRoot = await findGitRootAsync(projectRoot);
  if (!gitRoot) return counts;

  const resolvedRoot = path.resolve(projectRoot);
  let raw = '';
  try {
    const format = '%H%x00';
    raw = await runGitAsync(projectRoot, [
      'log',
      `--max-count=${maxCount}`,
      `--pretty=format:${format}`,
      '--name-only',
      '--diff-filter=AM',
      'HEAD',
    ]);
  } catch {
    return counts;
  }

  const segments = raw.split('\0');
  for (const segment of segments) {
    const lines = segment.split('\n').map(line => line.trim()).filter(Boolean);
    // First line is the commit SHA, remaining lines are changed file paths.
    for (let index = 1; index < lines.length; index += 1) {
      const gitRel = lines[index];
      if (!gitRel) continue;
      const absPath = path.join(gitRoot, gitRel);
      const relToProject = path.relative(resolvedRoot, absPath).replace(/\\/g, '/');
      if (relToProject.startsWith('..')) continue;
      counts.set(relToProject, (counts.get(relToProject) ?? 0) + 1);
    }
  }

  return counts;
}

export async function listRecentCommitMetadataAsync(projectRoot: string, maxCount = 150): Promise<GitCommitMetadata[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];

  const format = [
    '%H',
    '%P',
    '%an',
    '%ae',
    '%aI',
    '%s',
    '%b',
  ].join('%x1f') + '%x1e';

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['log', `--max-count=${maxCount}`, `--pretty=format:${format}`, 'HEAD']);
  } catch {
    return [];
  }

  return raw
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [sha, parents, authorName, authorEmail, authoredAt, subject, body] = record.split('\x1f');
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        authorName,
        authorEmail,
        authoredAt,
        subject,
        body: (body ?? '').trim(),
      } satisfies GitCommitMetadata;
    });
}

function parseDiffPatches(raw: string): GitFilePatch[] {
  const patches: GitFilePatch[] = [];
  let current: GitFilePatch | null = null;

  const flush = (): void => {
    if (current) {
      if (!current.path && current.oldPath) current.path = current.oldPath;
      patches.push(current);
    }
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const oldPath = stripDiffPrefix(match?.[1] ?? '');
      const newPath = stripDiffPrefix(match?.[2] ?? '');
      current = {
        path: newPath || oldPath,
        oldPath: oldPath || undefined,
        status: 'M',
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode ')) {
      current.status = 'A';
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      current.status = 'D';
      continue;
    }

    if (line.startsWith('rename from ')) {
      current.status = 'R';
      current.oldPath = line.slice('rename from '.length).trim();
      continue;
    }

    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length).trim();
      continue;
    }

    if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.oldPath = stripDiffPrefix(value);
      continue;
    }

    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') current.path = stripDiffPrefix(value);
      continue;
    }

    if (line.startsWith('@@ ')) {
      const hunk = parseHunkHeader(line);
      if (hunk) current.hunks.push(hunk);
    }
  }

  flush();
  return patches;
}

export async function getCommitPatchAsync(projectRoot: string, sha: string): Promise<GitFilePatch[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['show', '--format=', '--find-renames', '--unified=0', sha]);
  } catch {
    return [];
  }

  return parseDiffPatches(raw);
}

export async function getWorkingTreePatchAsync(projectRoot: string): Promise<GitFilePatch[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['diff', '--find-renames', '--unified=0', 'HEAD']);
  } catch {
    return [];
  }

  return parseDiffPatches(raw);
}

export async function getRangePatchAsync(projectRoot: string, baseRef: string, headRef: string): Promise<GitFilePatch[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['diff', '--find-renames', '--unified=0', `${baseRef}..${headRef}`]);
  } catch {
    return [];
  }

  return parseDiffPatches(raw);
}

export async function readGitFileAsync(projectRoot: string, revision: string, filePath: string): Promise<string | null> {
  if (!await isGitRepoAsync(projectRoot)) return null;

  try {
    return await runGitAsync(projectRoot, ['show', `${revision}:${filePath}`]);
  } catch {
    return null;
  }
}

export async function getWorkingTreeChangesAsync(projectRoot: string): Promise<GitWorkingTreeChange[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['status', '--porcelain', '--untracked-files=normal']);
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const status = line.slice(0, 2).trim() || '??';
      const rawPath = line.slice(3).trim();
      const pathText = rawPath.includes(' -> ')
        ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4)
        : rawPath;
      return { path: pathText, status } satisfies GitWorkingTreeChange;
    });
}

function parseGrepLines(lines: string[], withRevisionPrefix: boolean, maxMatches: number): GitSymbolReferenceStats {
  const sample: Array<{ file: string; line: number }> = [];
  const files = new Set<string>();
  let total = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(':');
    if (parts.length < 3) continue;

    const filePart = withRevisionPrefix ? parts[1] : parts[0];
    const linePart = withRevisionPrefix ? parts[2] : parts[1];
    const lineNo = Number(linePart);
    if (!filePart || !Number.isFinite(lineNo) || lineNo < 1) continue;

    total += 1;
    files.add(filePart);
    if (sample.length < maxMatches) {
      sample.push({ file: filePart, line: lineNo });
    }
  }

  return {
    count: total,
    files: [...files].slice(0, maxMatches),
    sample,
  };
}

export async function querySymbolReferencesAtRevision(
  projectRoot: string,
  revision: string,
  symbol: string,
  maxMatches = 50
): Promise<GitSymbolReferenceStats> {
  if (!await isGitRepoAsync(projectRoot)) return { count: 0, files: [], sample: [] };
  const token = symbol.trim();
  if (!token) return { count: 0, files: [], sample: [] };

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['grep', '-n', '-F', '--full-name', '--no-color', token, revision, '--']);
  } catch {
    return { count: 0, files: [], sample: [] };
  }

  return parseGrepLines(raw.split('\n'), true, maxMatches);
}

export async function querySymbolReferencesInWorkingTree(
  projectRoot: string,
  symbol: string,
  maxMatches = 50
): Promise<GitSymbolReferenceStats> {
  if (!await isGitRepoAsync(projectRoot)) return { count: 0, files: [], sample: [] };
  const token = symbol.trim();
  if (!token) return { count: 0, files: [], sample: [] };

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, ['grep', '-n', '-F', '--full-name', '--no-color', token, '--']);
  } catch {
    return { count: 0, files: [], sample: [] };
  }

  return parseGrepLines(raw.split('\n'), false, maxMatches);
}

function compactLineRanges(lines: number[]): GitLineRange[] {
  const sorted = [...new Set(lines)].sort((left, right) => left - right);
  if (sorted.length === 0) return [];
  const ranges: GitLineRange[] = [];
  let startLine = sorted[0];
  let endLine = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const line = sorted[index];
    if (line === endLine + 1) {
      endLine = line;
      continue;
    }
    ranges.push({ startLine, endLine });
    startLine = line;
    endLine = line;
  }
  ranges.push({ startLine, endLine });
  return ranges;
}

export async function getLineCommitHistoryAsync(
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<GitLineCommitHistory[]> {
  if (!await isGitRepoAsync(projectRoot)) return [];
  if (startLine < 1 || endLine < startLine) return [];

  let raw = '';
  try {
    raw = await runGitAsync(projectRoot, [
      'blame',
      '--line-porcelain',
      '-L',
      `${startLine},${endLine}`,
      '--',
      filePath,
    ]);
  } catch {
    return [];
  }

  const commits = new Map<string, { meta: Omit<GitLineCommitHistory, 'lineRanges'>; lines: number[] }>();
  const lines = raw.split('\n');
  let index = 0;

  while (index < lines.length) {
    const header = /^([0-9a-f]{40}|0{40})\s+\d+\s+(\d+)(?:\s+(\d+))?$/.exec(lines[index] ?? '');
    if (!header) {
      index += 1;
      continue;
    }

    const sha = header[1];
    const finalLine = Number(header[2]);
    const lineCount = header[3] ? Number(header[3]) : 1;
    index += 1;

    let authorName = '';
    let authorEmail = '';
    let authoredAt = '';
    let summary = '';

    while (index < lines.length) {
      const line = lines[index] ?? '';
      if (line.startsWith('\t')) {
        index += 1;
        break;
      }
      if (line.startsWith('author ')) authorName = line.slice('author '.length).trim();
      else if (line.startsWith('author-mail ')) authorEmail = line.slice('author-mail '.length).trim().replace(/^<|>$/g, '');
      else if (line.startsWith('author-time ')) {
        const seconds = Number(line.slice('author-time '.length).trim());
        authoredAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
      } else if (line.startsWith('summary ')) summary = line.slice('summary '.length).trim();
      index += 1;
    }

    if (!commits.has(sha)) {
      commits.set(sha, {
        meta: {
          sha,
          authorName,
          authorEmail,
          authoredAt,
          summary,
        },
        lines: [],
      });
    }

    const entry = commits.get(sha);
    if (!entry) continue;
    for (let offset = 0; offset < lineCount; offset += 1) {
      entry.lines.push(finalLine + offset);
    }
    if (!entry.meta.authorName && authorName) entry.meta.authorName = authorName;
    if (!entry.meta.authorEmail && authorEmail) entry.meta.authorEmail = authorEmail;
    if (!entry.meta.authoredAt && authoredAt) entry.meta.authoredAt = authoredAt;
    if (!entry.meta.summary && summary) entry.meta.summary = summary;
  }

  return [...commits.values()]
    .map(entry => ({
      ...entry.meta,
      lineRanges: compactLineRanges(entry.lines),
    }))
    .sort((left, right) => Date.parse(right.authoredAt || '1970-01-01T00:00:00.000Z') - Date.parse(left.authoredAt || '1970-01-01T00:00:00.000Z'));
}

function lineRangeCount(ranges: GitLineRange[]): number {
  return ranges.reduce((sum, range) => sum + (range.endLine - range.startLine + 1), 0);
}

function contributorKey(authorName: string, authorEmail: string): string {
  return `${authorEmail.trim().toLowerCase()}::${authorName.trim().toLowerCase()}`;
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

export async function getFileOwnershipSummaryAsync(projectRoot: string, filePath: string): Promise<GitFileOwnershipSummary | null> {
  const gitRoot = await findGitRootAsync(projectRoot);
  if (!gitRoot) return null;

  const absPath = path.join(gitRoot, filePath);
  let totalLines = 0;
  try {
    const source = await Bun.file(absPath).text();
    totalLines = source.length === 0 ? 0 : source.split(/\r?\n/).length;
  } catch {
    return null;
  }

  if (totalLines === 0) {
    return {
      filePath,
      totalLines: 0,
      primaryOwner: null,
      recentOwner: null,
      contributorCount: 0,
      busFactor: 0,
      contributors: [],
    };
  }

  const history = await getLineCommitHistoryAsync(projectRoot, filePath, 1, totalLines);
  if (history.length === 0) {
    return {
      filePath,
      totalLines,
      primaryOwner: null,
      recentOwner: null,
      contributorCount: 0,
      busFactor: 0,
      contributors: [],
    };
  }

  const contributors = new Map<string, { authorName: string; authorEmail: string; lineCount: number; latestAuthoredAt: string | null }>();
  for (const commit of history) {
    const key = contributorKey(commit.authorName || 'Unknown', commit.authorEmail || 'unknown@example.invalid');
    const existing = contributors.get(key) ?? {
      authorName: commit.authorName || 'Unknown',
      authorEmail: commit.authorEmail || 'unknown@example.invalid',
      lineCount: 0,
      latestAuthoredAt: null as string | null,
    };
    existing.lineCount += lineRangeCount(commit.lineRanges);
    if (!existing.latestAuthoredAt || Date.parse(commit.authoredAt || '1970-01-01T00:00:00.000Z') > Date.parse(existing.latestAuthoredAt || '1970-01-01T00:00:00.000Z')) {
      existing.latestAuthoredAt = commit.authoredAt || existing.latestAuthoredAt;
    }
    contributors.set(key, existing);
  }

  const effectiveTotalLines = [...contributors.values()].reduce((sum, contributor) => sum + contributor.lineCount, 0) || totalLines;
  const ranked = [...contributors.values()]
    .map(contributor => ({
      authorName: contributor.authorName,
      authorEmail: contributor.authorEmail,
      lineCount: contributor.lineCount,
      percentage: effectiveTotalLines > 0 ? contributor.lineCount / effectiveTotalLines : 0,
      latestAuthoredAt: contributor.latestAuthoredAt,
    }))
    .sort((left, right) => right.lineCount - left.lineCount || Date.parse(right.latestAuthoredAt || '1970-01-01T00:00:00.000Z') - Date.parse(left.latestAuthoredAt || '1970-01-01T00:00:00.000Z'));

  const recentOwner = [...ranked]
    .sort((left, right) => Date.parse(right.latestAuthoredAt || '1970-01-01T00:00:00.000Z') - Date.parse(left.latestAuthoredAt || '1970-01-01T00:00:00.000Z') || right.lineCount - left.lineCount)[0] ?? null;

  return {
    filePath,
    totalLines: effectiveTotalLines,
    primaryOwner: ranked[0] ?? null,
    recentOwner,
    contributorCount: ranked.length,
    busFactor: computeBusFactor(ranked),
    contributors: ranked,
  };
}

async function isGitRepoAsync(projectRoot: string): Promise<boolean> {
  return await findGitRootAsync(projectRoot) !== null;
}
