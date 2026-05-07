import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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

function parseGitDirFile(dotGitFile: string): string | null {
  try {
    const raw = fs.readFileSync(dotGitFile, 'utf-8').trim();
    const prefix = 'gitdir:';
    if (!raw.startsWith(prefix)) return null;
    const gitDir = raw.slice(prefix.length).trim();
    return path.resolve(path.dirname(dotGitFile), gitDir);
  } catch {
    return null;
  }
}

function resolveGitDir(gitRoot: string): string | null {
  const dotGit = path.join(gitRoot, '.git');
  if (!fs.existsSync(dotGit)) return null;

  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) return parseGitDirFile(dotGit);
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

function runGit(projectRoot: string, args: string[]): string {
  const gitRoot = findGitRoot(projectRoot);
  if (!gitRoot) {
    throw new Error(`Not a git repository: ${projectRoot}`);
  }

  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: gitRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function findGitRoot(projectRoot: string): string | null {
  let dir = path.resolve(projectRoot);
  const root = path.parse(dir).root;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
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

/**
 * Read the current git branch from the resolved git directory.
 * Returns null if the directory is not a git repo.
 * Returns the first 8 chars of the commit hash when in detached HEAD state.
 */
export function getCurrentBranch(projectRoot: string): string | null {
  const gitRoot = findGitRoot(projectRoot);
  if (!gitRoot) return null;

  try {
    const gitDir = resolveGitDir(gitRoot);
    if (!gitDir) return null;
    const headFile = path.join(gitDir, 'HEAD');
    const head = fs.readFileSync(headFile, 'utf-8').trim();
    if (head.startsWith('ref: refs/heads/')) {
      return head.slice('ref: refs/heads/'.length);
    }
    // Detached HEAD — use short commit hash so the data dir is still stable
    return `detached-${head.slice(0, 8)}`;
  } catch {
    return null;
  }
}

/**
 * Sanitise a branch name so it can be used as a directory name.
 * e.g. "feature/auth-service" → "feature-auth-service"
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
 *   git project  → <projectRoot>/.code-intelligence/<branch-slug>/
 *   non-git      → <projectRoot>/.code-intelligence/
 *
 * Non-git projects use a flat layout since there are no branches to isolate.
 */
export function getDataDir(projectRoot: string): string {
  const branch = getCurrentBranch(projectRoot);
  if (branch === null) {
    // Not a git repo — use flat layout, no branch subdirectory
    return path.join(projectRoot, '.code-intelligence');
  }
  return path.join(projectRoot, '.code-intelligence', branchSlug(branch));
}

export function getHeadCommit(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null;
  try {
    return runGit(projectRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

export function listRecentCommitMetadata(projectRoot: string, maxCount = 150): GitCommitMetadata[] {
  if (!isGitRepo(projectRoot)) return [];

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
    raw = runGit(projectRoot, ['log', `--max-count=${maxCount}`, `--pretty=format:${format}`, 'HEAD']);
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

export function getCommitPatch(projectRoot: string, sha: string): GitFilePatch[] {
  if (!isGitRepo(projectRoot)) return [];

  let raw = '';
  try {
    raw = runGit(projectRoot, ['show', '--format=', '--find-renames', '--unified=0', sha]);
  } catch {
    return [];
  }

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

export function readGitFile(projectRoot: string, revision: string, filePath: string): string | null {
  if (!isGitRepo(projectRoot)) return null;

  try {
    return runGit(projectRoot, ['show', `${revision}:${filePath}`]);
  } catch {
    return null;
  }
}

export function getWorkingTreeChanges(projectRoot: string): GitWorkingTreeChange[] {
  if (!isGitRepo(projectRoot)) return [];

  let raw = '';
  try {
    raw = runGit(projectRoot, ['status', '--porcelain', '--untracked-files=normal']);
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

export function getLineCommitHistory(
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number
): GitLineCommitHistory[] {
  if (!isGitRepo(projectRoot)) return [];
  if (startLine < 1 || endLine < startLine) return [];

  let raw = '';
  try {
    raw = runGit(projectRoot, [
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
