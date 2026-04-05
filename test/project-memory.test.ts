import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DocumentMemoryEntry } from '../src/document-memory.js';
import {
    buildProjectMemoryEntries,
    getFeatureMap,
    getProjectStatus,
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
    commitAll(dir, 'fix login guard', '2026-04-02T10:00:00Z');

    const result = buildProjectMemoryEntries(dir);
    const changeEntries = result.entries.filter((entry): entry is ChangeMemoryEntry => entry.kind === 'change');
    const docEntries = result.entries.filter(entry => entry.kind === 'document');

    assert.ok(result.branch);
    assert.ok(result.headSha);
    assert.equal(result.latestChangeSha, changeEntries[0]?.sha ?? null);
    assert.equal(changeEntries[0]?.title, 'fix login guard');
    assert.equal(changeEntries[0]?.changeType, 'fix');
    assert.deepEqual(changeEntries[0]?.symbols, ['AuthService.login']);
    assert.deepEqual(changeEntries[0]?.files, ['src/auth.ts']);

    assert.ok(docEntries.some(entry => entry.title === 'What It Does'));
    assert.ok(docEntries.some(entry => entry.path === 'README.md'));
});