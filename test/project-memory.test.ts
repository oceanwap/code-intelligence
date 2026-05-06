import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DocumentMemoryEntry } from '../src/document-memory.js';
import {
    buildProjectMemoryEntries,
    getBugBrief,
    getFeatureMap,
    getProjectStatus,
    getWhyChanged,
    listRecentBugs,
    type BugMemoryEntry,
    type ChangeMemoryEntry,
    type ProjectMemoryEntry,
} from '../src/project-memory.js';

function makeTempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-memory-test-'));
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

function makeDocEntry(overrides: Partial<DocumentMemoryEntry>): DocumentMemoryEntry {
    return {
        id: 'doc:default',
        kind: 'document',
        timestamp: '2026-04-03T00:00:00.000Z',
        title: 'Overview',
        body: 'Overview text',
        summary: 'overview note: Overview. Overview text',
        changeType: 'docs',
        topics: ['overview'],
        files: ['README.md'],
        symbols: [],
        impacts: [],
        path: 'README.md',
        docType: 'overview',
        section: 'Overview',
        sourceMtimeMs: 1,
        ...overrides,
    };
}

function makeChangeEntry(overrides: Partial<ChangeMemoryEntry>): ChangeMemoryEntry {
    return {
        id: 'change:abc12345',
        kind: 'change',
        sha: 'abc12345def67890',
        parents: [],
        authorName: 'Tester',
        authorEmail: 'tester@example.com',
        timestamp: '2026-04-02T00:00:00.000Z',
        title: 'Add offline memory',
        body: '',
        changeType: 'feature',
        summary: 'feature change: touches memory.',
        topics: ['memory'],
        files: ['src/project-memory.ts'],
        symbols: ['getFeatureMap'],
        impacts: [],
        ...overrides,
    };
}

function makeBugEntry(overrides: Partial<BugMemoryEntry>): BugMemoryEntry {
    return {
        id: 'bug:abc12345',
        kind: 'bug',
        timestamp: '2026-04-02T00:00:00.000Z',
        title: 'Fix auth login guard',
        body: '',
        summary: 'bug memory: touches AuthService.login. Fixed by abc12345 via Fix auth login guard. Signature: TypeError. Test: src/auth.test.ts. Symptom: login guard. Topics: auth, session.',
        changeType: 'fix',
        topics: ['auth', 'session'],
        files: ['src/auth.ts'],
        symbols: ['AuthService.login'],
        impacts: [],
        source: 'fix-commit',
        fixedBySha: 'abc12345def67890',
        status: 'fixed',
        evidenceScore: 6,
        symptoms: ['login guard'],
        errorSignatures: ['TypeError'],
        failingTests: ['src/auth.test.ts'],
        ...overrides,
    };
}

function writeSnapshot(dir: string, entries: ProjectMemoryEntry[]): void {
    const dataDir = path.join(dir, '.code-intelligence');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
        path.join(dataDir, 'project-memory.json'),
        JSON.stringify(
            {
                branch: null,
                headSha: null,
                syncedAt: '2026-04-03T00:00:00.000Z',
                maxCommits: 150,
                entries,
            },
            null,
            2
        )
    );
}

function runGit(dir: string, args: string[], env?: Record<string, string>): string {
    return execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf-8',
        env: {
            ...process.env,
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function initGitRepo(dir: string): void {
    runGit(dir, ['init']);
    runGit(dir, ['config', 'user.name', 'Test User']);
    runGit(dir, ['config', 'user.email', 'test@example.com']);
}

function commitAll(dir: string, message: string, isoDate: string): void {
    runGit(dir, ['add', '.']);
    runGit(dir, ['commit', '-m', message], {
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
    });
}

function commitAllWithBody(dir: string, subject: string, body: string, isoDate: string): void {
    runGit(dir, ['add', '.']);
    runGit(dir, ['commit', '-m', subject, '-m', body], {
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
    });
}

test('getFeatureMap prefers feature and architecture docs over setup docs', t => {
    const dir = makeTempDir(t);
    writeSnapshot(dir, [
        makeDocEntry({ id: 'doc:setup', title: 'Setup', section: 'Setup', summary: 'overview note: Setup.', topics: ['setup'] }),
        makeDocEntry({ id: 'doc:what', title: 'What It Does', section: 'What It Does', docType: 'architecture', summary: 'architecture note: What It Does.', topics: ['features', 'memory'] }),
        makeDocEntry({ id: 'doc:storage', title: 'Storage Layout', section: 'Storage Layout', docType: 'architecture', summary: 'architecture note: Storage Layout.', topics: ['storage', 'layout'] }),
        makeChangeEntry(),
    ]);

    const featureMap = getFeatureMap(dir);
    assert.ok(featureMap);

    assert.deepEqual(
        featureMap.documentedFeatures.map(entry => entry.title),
        ['What It Does', 'Storage Layout']
    );
    assert.equal(featureMap.recentFeatureChanges[0]?.title, 'Add offline memory');

    const status = getProjectStatus(dir);
    assert.ok(status);
    assert.deepEqual(
        status.featureDocs.map(entry => entry.title),
        ['What It Does', 'Storage Layout']
    );
});

test('buildProjectMemoryEntries ingests git history and maps commit changes to symbols', t => {
    const dir = makeTempDir(t);
    initGitRepo(dir);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'README.md'),
        [
            '# Auth Brain',
            '',
            '## What It Does',
            '',
            'Offline project memory for authentication work.',
            '',
        ].join('\n')
    );
    fs.writeFileSync(
        path.join(dir, 'src', 'auth.ts'),
        [
            'class AuthService {',
            '  login() {',
            '    return true;',
            '  }',
            '',
            '  logout() {',
            '    return false;',
            '  }',
            '}',
            '',
        ].join('\n')
    );
    commitAll(dir, 'feat add auth service', '2026-04-01T10:00:00Z');

    fs.writeFileSync(
        path.join(dir, 'src', 'auth.ts'),
        [
            'class AuthService {',
            '  login() {',
            '    const sessionReady = true;',
            '    if (!sessionReady) return false;',
            '    return true;',
            '  }',
            '',
            '  logout() {',
            '    return false;',
            '  }',
            '}',
            '',
        ].join('\n')
    );
    commitAllWithBody(
        dir,
        'fix login guard',
        [
            'Handle TypeError when session state is missing.',
            'Failing test: src/auth.test.ts',
            'Co-authored-by: Noise Bot <noise@example.com>',
        ].join('\n'),
        '2026-04-02T10:00:00Z'
    );

    const result = buildProjectMemoryEntries(dir);
    const changeEntries = result.entries.filter((entry): entry is ChangeMemoryEntry => entry.kind === 'change');
    const bugEntries = result.entries.filter((entry): entry is BugMemoryEntry => entry.kind === 'bug');
    const docEntries = result.entries.filter(entry => entry.kind === 'document');

    assert.ok(result.branch);
    assert.ok(result.headSha);
    assert.equal(result.latestChangeSha, changeEntries[0]?.sha ?? null);
    assert.equal(changeEntries[0]?.title, 'fix login guard');
    assert.equal(changeEntries[0]?.changeType, 'fix');
    assert.deepEqual(changeEntries[0]?.symbols, ['AuthService.login']);
    assert.deepEqual(changeEntries[0]?.files, ['src/auth.ts']);
    assert.ok(changeEntries[0]?.body.includes('Handle TypeError when session state is missing'));
    assert.ok(changeEntries[0]?.body.includes('Failing test: src/auth.test.ts'));
    assert.ok(!changeEntries[0]?.body.includes('Co-authored-by'));
    assert.equal(bugEntries[0]?.fixedBySha, changeEntries[0]?.sha);
    assert.equal(bugEntries[0]?.status, 'fixed');
    assert.deepEqual(bugEntries[0]?.symbols, ['AuthService.login']);
    assert.deepEqual(bugEntries[0]?.errorSignatures, ['TypeError']);
    assert.deepEqual(bugEntries[0]?.failingTests, ['src/auth.test.ts']);
    assert.ok((bugEntries[0]?.symptoms ?? []).some(symptom => symptom.includes('login guard')));
    assert.ok((bugEntries[0]?.evidenceScore ?? 0) > 0);

    assert.ok(docEntries.some(entry => entry.title === 'What It Does'));
    assert.ok(docEntries.some(entry => entry.path === 'README.md'));
});

test('getWhyChanged finds recent changes for a symbol or file target', t => {
    const dir = makeTempDir(t);
    writeSnapshot(dir, [
        makeChangeEntry({
            id: 'change:auth',
            sha: 'auth1234def567890',
            title: 'Fix auth login guard',
            changeType: 'fix',
            summary: 'fix change: touches AuthService.login.',
            topics: ['auth', 'session'],
            files: ['src/auth.ts'],
            symbols: ['AuthService.login'],
        }),
        makeChangeEntry({
            id: 'change:cache',
            sha: 'cache123def456789',
            title: 'Refactor cache refresh',
            changeType: 'refactor',
            summary: 'refactor change: touches CacheService.refresh.',
            topics: ['cache'],
            files: ['src/cache.ts'],
            symbols: ['CacheService.refresh'],
            timestamp: '2026-04-01T00:00:00.000Z',
        }),
    ]);

    const symbolResult = getWhyChanged(dir, { target: 'AuthService.login', mode: 'symbol' });
    assert.ok(symbolResult);
    assert.equal(symbolResult.totalMatches, 1);
    assert.deepEqual(symbolResult.matches[0]?.matchedSymbols, ['AuthService.login']);
    assert.equal(symbolResult.matches[0]?.entry.title, 'Fix auth login guard');

    const fileResult = getWhyChanged(dir, { target: 'cache.ts', mode: 'file' });
    assert.ok(fileResult);
    assert.equal(fileResult.totalMatches, 1);
    assert.deepEqual(fileResult.matches[0]?.matchedFiles, ['src/cache.ts']);
    assert.equal(fileResult.matches[0]?.entry.title, 'Refactor cache refresh');
});

test('listRecentBugs and getBugBrief surface bug memory for exact targets', t => {
    const dir = makeTempDir(t);
    writeSnapshot(dir, [
        makeBugEntry(),
        makeBugEntry({
            id: 'bug:cache',
            title: 'Fix cache refresh race',
            summary: 'bug memory: touches CacheService.refresh. Fixed by cache123d via Fix cache refresh race. Signature: race condition. Topics: cache.',
            topics: ['cache'],
            files: ['src/cache.ts'],
            symbols: ['CacheService.refresh'],
            fixedBySha: 'cache123def456789',
            timestamp: '2026-04-01T00:00:00.000Z',
            evidenceScore: 4,
            symptoms: ['cache refresh race'],
            errorSignatures: ['race condition'],
            failingTests: [],
        }),
        makeChangeEntry(),
    ]);

    const recentBugs = listRecentBugs(dir, { topic: 'auth' });
    assert.equal(recentBugs.length, 1);
    assert.equal(recentBugs[0]?.title, 'Fix auth login guard');

    const brief = getBugBrief(dir, { target: 'AuthService.login', mode: 'symbol' });
    assert.ok(brief);
    assert.equal(brief.totalMatches, 1);
    assert.deepEqual(brief.matches[0]?.matchedSymbols, ['AuthService.login']);
    assert.equal(brief.matches[0]?.entry.fixedBySha, 'abc12345def67890');
    assert.deepEqual(brief.matches[0]?.entry.errorSignatures, ['TypeError']);
});

test('buildProjectMemoryEntries rebuilds stale noisy change entries instead of reusing them', t => {
    const dir = makeTempDir(t);
    initGitRepo(dir);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'src', 'auth.ts'),
        [
            'class AuthService {',
            '  login() {',
            '    return true;',
            '  }',
            '}',
            '',
        ].join('\n')
    );
    commitAllWithBody(
        dir,
        'fix login guard',
        [
            'Handle TypeError when session state is missing.',
            'Failing test: src/auth.test.ts',
        ].join('\n'),
        '2026-04-02T10:00:00Z'
    );

    const fresh = buildProjectMemoryEntries(dir);
    const freshChange = fresh.entries.find((entry): entry is ChangeMemoryEntry => entry.kind === 'change');
    assert.ok(freshChange);

    const reused = buildProjectMemoryEntries(dir, [{
        ...freshChange,
        body: [
            'Handle TypeError when session state is missing.',
            'Failing test: src/auth.test.ts',
            'Co-authored-by: Noise Bot <noise@example.com>',
        ].join('\n'),
        summary: 'fix change: touches AuthService.login. fix login guard.',
    }]);

    const rebuilt = reused.entries.find((entry): entry is ChangeMemoryEntry => entry.kind === 'change');
    assert.ok(rebuilt);
    assert.ok(!rebuilt.body.includes('Co-authored-by'));
    assert.ok(rebuilt.summary.includes('Detail: Handle TypeError when session state is missing'));
});