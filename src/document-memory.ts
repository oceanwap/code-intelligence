import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { walkFiles } from './indexer.js';

export type ProjectDocumentType =
    | 'overview'
    | 'feature'
    | 'architecture'
    | 'decision'
    | 'operations'
    | 'changelog'
    | 'note';

export interface DocumentMemoryEntry {
    id: string;
    kind: 'document';
    timestamp: string;
    title: string;
    body: string;
    summary: string;
    changeType: 'docs';
    topics: string[];
    files: string[];
    symbols: string[];
    impacts: [];
    path: string;
    docType: ProjectDocumentType;
    section: string;
    sourceMtimeMs: number;
}

interface DocumentSection {
    title: string;
    body: string;
}

const DOC_EXTS = ['.md', '.mdx', '.txt'];
const DOC_NAMES = new Set([
    'README', 'README.md', 'README.mdx',
    'CHANGELOG', 'CHANGELOG.md', 'CHANGELOG.txt',
    'HISTORY', 'HISTORY.md',
    'ROADMAP.md', 'NOTES.md', 'RUNBOOK.md',
]);
const MAX_DOC_BYTES = 96_000;
const MAX_DOC_BODY_CHARS = 4_000;
const MAX_DOC_SECTIONS_PER_FILE = 24;
const MAX_TOTAL_DOC_ENTRIES = 120;
const TOPIC_STOP_WORDS = new Set([
    'the', 'and', 'with', 'from', 'that', 'this', 'were', 'have', 'into', 'after',
    'before', 'when', 'while', 'over', 'under', 'then', 'than', 'your', 'their',
    'readme', 'docs', 'documentation', 'guide', 'notes', 'project', 'section',
    'file', 'files', 'about', 'into', 'using', 'used', 'local', 'system', 'code',
    'overview', 'introduction', 'general', 'detail', 'details', 'example', 'examples',
]);

function hashText(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function splitTokens(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 3 && token.length <= 24 && !TOPIC_STOP_WORDS.has(token));
}

function addWeightedTokens(target: Map<string, number>, values: string[], weight: number): void {
    for (const value of values) {
        target.set(value, (target.get(value) ?? 0) + weight);
    }
}

function stripMarkdown(source: string): string {
    return source
        .replace(/```[\s\S]*?```/g, '\n')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^\)]+\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/<[^>]+>/g, ' ');
}

function normalizeLine(line: string): string {
    return line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function meaningfulLines(source: string): string[] {
    return stripMarkdown(source)
        .split('\n')
        .map(normalizeLine)
        .filter(line => line.length >= 12 && !/^[-=_]{3,}$/.test(line));
}

function extractInlineSymbols(source: string): string[] {
    return dedupeStrings(
        [...source.matchAll(/`([^`\n]{2,80})`/g)]
            .map(match => match[1].trim())
            .filter(token => /^[A-Za-z0-9_./:-]+$/.test(token))
            .slice(0, 12)
    );
}

function splitDocumentSections(source: string, fallbackTitle: string): DocumentSection[] {
    const sections: DocumentSection[] = [];
    let currentTitle = fallbackTitle;
    let currentLines: string[] = [];
    let inCodeFence = false;

    const flush = (): void => {
        const body = currentLines.join('\n').trim();
        if (body.length === 0) return;
        sections.push({ title: currentTitle, body });
    };

    for (const line of source.split('\n')) {
        if (/^```/.test(line.trim())) {
            inCodeFence = !inCodeFence;
            currentLines.push(line);
            continue;
        }

        if (inCodeFence) {
            currentLines.push(line);
            continue;
        }

        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (heading) {
            flush();
            currentTitle = heading[2].trim();
            currentLines = [];
            continue;
        }
        currentLines.push(line);
    }

    flush();

    return sections.length > 0
        ? sections.slice(0, MAX_DOC_SECTIONS_PER_FILE)
        : [{ title: fallbackTitle, body: source.slice(0, MAX_DOC_BODY_CHARS) }];
}

function inferDocType(relPath: string, title: string, body: string): ProjectDocumentType {
    const text = `${relPath}\n${title}\n${body}`.toLowerCase();
    if (/(^|\/)(changelog|history)(\.|\/|$)/.test(relPath.toLowerCase()) || /(release notes|migration guide)/.test(text)) return 'changelog';
    if (/(^|\/)(adr|adrs|decisions)(\/|$)/.test(relPath.toLowerCase()) || /(adr|decision|tradeoff|rationale)/.test(text)) return 'decision';
    if (/(architecture|design|system|structure|call graph|storage layout)/.test(text)) return 'architecture';
    if (/(runbook|deploy|deployment|operations|incident|oncall|ops|troubleshoot)/.test(text)) return 'operations';
    if (/(what it does|features|capabilities|feature map|overview|introduction)/.test(text)) return 'feature';
    if (/(readme|getting started|setup|usage)/.test(text)) return 'overview';
    return 'note';
}

function inferTopics(relPath: string, title: string, body: string, docType: ProjectDocumentType): string[] {
    const scores = new Map<string, number>();
    addWeightedTokens(scores, splitTokens(relPath), 3);
    addWeightedTokens(scores, splitTokens(title), 5);
    addWeightedTokens(scores, splitTokens(body), 1);
    addWeightedTokens(scores, splitTokens(docType), 2);

    return [...scores.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 6)
        .map(([topic]) => topic);
}

function summarizeSection(title: string, body: string, docType: ProjectDocumentType): string {
    const lines = meaningfulLines(body);
    const summaryLines = lines.slice(0, 2);
    if (summaryLines.length === 0) {
        return `${docType} note: ${title}`;
    }
    return `${docType} note: ${title}. ${summaryLines.join(' ')}`.slice(0, 320);
}

export function buildDocumentEntries(projectRoot: string): DocumentMemoryEntry[] {
    const root = path.resolve(projectRoot);
    const files = walkFiles(root, DOC_EXTS, DOC_NAMES);
    const entries: DocumentMemoryEntry[] = [];

    for (const absPath of files) {
        if (entries.length >= MAX_TOTAL_DOC_ENTRIES) break;

        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch {
            continue;
        }

        if (stat.size > MAX_DOC_BYTES) continue;

        let source = '';
        try {
            source = fs.readFileSync(absPath, 'utf-8');
        } catch {
            continue;
        }

        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        const fallbackTitle = path.basename(relPath);
        const sections = splitDocumentSections(source, fallbackTitle);

        for (const section of sections) {
            if (entries.length >= MAX_TOTAL_DOC_ENTRIES) break;

            const body = section.body.trim().slice(0, MAX_DOC_BODY_CHARS);
            if (meaningfulLines(body).length === 0) continue;

            const docType = inferDocType(relPath, section.title, body);
            entries.push({
                id: `doc:${hashText(`${relPath}\n${section.title}\n${body}`)}`,
                kind: 'document',
                timestamp: new Date(stat.mtimeMs).toISOString(),
                title: section.title,
                body,
                summary: summarizeSection(section.title, body, docType),
                changeType: 'docs',
                topics: inferTopics(relPath, section.title, body, docType),
                files: [relPath],
                symbols: extractInlineSymbols(`${section.title}\n${body}`),
                impacts: [],
                path: relPath,
                docType,
                section: section.title,
                sourceMtimeMs: stat.mtimeMs,
            });
        }
    }

    return entries.sort((left, right) => right.sourceMtimeMs - left.sourceMtimeMs);
}