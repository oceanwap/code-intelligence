import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildDocumentEntries } from '../src/document-memory.js';

function makeTempDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-doc-test-'));
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

test('buildDocumentEntries ignores headings inside fenced code blocks', t => {
    const dir = makeTempDir(t);
    fs.writeFileSync(
        path.join(dir, 'README.md'),
        [
            '# Product Brain',
            '',
            'Intro text with `code-intel` for local project memory.',
            '',
            '## What It Does',
            '',
            'Features include offline search and feature maps for engineers.',
            '',
            '```bash',
            '# not a heading',
            'echo hello',
            '```',
            '',
            '## Architecture',
            '',
            'Storage layout and system design are documented here.',
            '',
        ].join('\n')
    );

    const entries = buildDocumentEntries(dir);
    const titles = entries.map(entry => entry.title);

    assert.ok(titles.includes('Product Brain'));
    assert.ok(titles.includes('What It Does'));
    assert.ok(titles.includes('Architecture'));
    assert.ok(!titles.includes('not a heading'));

    const overview = entries.find(entry => entry.title === 'Product Brain');
    assert.ok(overview);
    assert.ok(overview.symbols.includes('code-intel'));

    const whatItDoes = entries.find(entry => entry.title === 'What It Does');
    assert.ok(whatItDoes);
    assert.equal(whatItDoes.docType, 'feature');

    const architecture = entries.find(entry => entry.title === 'Architecture');
    assert.ok(architecture);
    assert.equal(architecture.docType, 'architecture');
});

test('buildDocumentEntries classifies changelog files from their path', t => {
    const dir = makeTempDir(t);
    fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        [
            '# Changelog',
            '',
            '## 1.2.0',
            '',
            '- Added offline project memory.',
            '- Improved feature map ranking.',
            '',
        ].join('\n')
    );

    const entries = buildDocumentEntries(dir);
    const releaseEntry = entries.find(entry => entry.title === '1.2.0');

    assert.ok(releaseEntry);
    assert.equal(releaseEntry.docType, 'changelog');
    assert.ok(releaseEntry.summary.includes('offline project memory'));
});