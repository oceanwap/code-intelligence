import { QdrantClient } from '@qdrant/js-client-rest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildDocumentEntries, type DocumentMemoryEntry } from './document-memory.js';
import { extractSemanticTouch, prefersOldRevision } from './change-semantic.js';
import { VECTOR_SIZE, embedQuery, embedTexts, scopedCollectionName } from './embedder.js';
import {
    getCommitPatch,
    getCurrentBranch,
    getHeadCommit,
    getWorkingTreeChanges,
    listRecentCommitMetadata,
    readGitFile,
    type GitCommitMetadata,
} from './git.js';
import { getDataDir } from './git.js';
import { toUUID } from './indexer.js';

export interface ProjectMemoryImpact {
    file: string;
    status: 'A' | 'M' | 'D' | 'R';
    symbols: string[];
    hints: string[];
}

export interface ChangeMemoryEntry {
    id: string;
    kind: 'change';
    sha: string;
    parents: string[];
    authorName: string;
    authorEmail: string;
    timestamp: string;
    title: string;
    body: string;
    changeType: 'feature' | 'fix' | 'refactor' | 'docs' | 'test' | 'ops' | 'chore';
    summary: string;
    topics: string[];
    files: string[];
    symbols: string[];
    impacts: ProjectMemoryImpact[];
}

export interface BugMemoryEntry {
    id: string;
    kind: 'bug';
    timestamp: string;
    title: string;
    body: string;
    summary: string;
    changeType: 'fix';
    topics: string[];
    files: string[];
    symbols: string[];
    impacts: ProjectMemoryImpact[];
    source: 'fix-commit';
    fixedBySha: string;
    status: 'fixed';
    evidenceScore: number;
    symptoms: string[];
    errorSignatures: string[];
    failingTests: string[];
}

export type ProjectMemoryEntry = ChangeMemoryEntry | DocumentMemoryEntry | BugMemoryEntry;

interface ProjectMemorySnapshot {
    branch: string | null;
    headSha: string | null;
    syncedAt: string;
    maxCommits: number;
    entries: ProjectMemoryEntry[];
}

interface MemoryCacheEntry {
    fingerprint: string;
    vector: number[];
}

export interface ProjectMemorySearchHit {
    entry: ProjectMemoryEntry;
    score: number;
}

export interface ProjectMemorySyncResult {
    totalEntries: number;
    newEntries: number;
    staleRemoved: number;
    latestChangeSha: string | null;
}

export interface ProjectMemoryBuildResult {
    branch: string | null;
    headSha: string | null;
    entries: ProjectMemoryEntry[];
    latestChangeSha: string | null;
}

export interface ProjectStatusSnapshot {
    branch: string | null;
    headSha: string | null;
    memoryEntries: number;
    latestChange: ChangeMemoryEntry | null;
    dirtyFiles: Array<{ path: string; status: string }>;
    recentFixes: ChangeMemoryEntry[];
    activeTopics: Array<{ topic: string; count: number }>;
    changeKinds: Array<{ type: ChangeMemoryEntry['changeType']; count: number }>;
    featureDocs: DocumentMemoryEntry[];
}

export interface ProjectFeatureMapSnapshot {
    documentedFeatures: DocumentMemoryEntry[];
    recentFeatureChanges: ChangeMemoryEntry[];
}

export interface WhyChangedMatch {
    entry: ChangeMemoryEntry;
    matchedSymbols: string[];
    matchedFiles: string[];
}

export interface WhyChangedResult {
    target: string;
    mode: 'auto' | 'symbol' | 'file';
    totalMatches: number;
    activeTopics: Array<{ topic: string; count: number }>;
    matches: WhyChangedMatch[];
}

export interface BugBriefMatch {
    entry: BugMemoryEntry;
    matchedSymbols: string[];
    matchedFiles: string[];
}

export interface BugBriefResult {
    target: string;
    mode: 'auto' | 'symbol' | 'file';
    totalMatches: number;
    activeTopics: Array<{ topic: string; count: number }>;
    matches: BugBriefMatch[];
}

const MAX_COMMITS = 150;
const PROJECT_MEMORY_FILE = 'project-memory.json';
const PROJECT_MEMORY_CACHE_FILE = 'project-memory-cache.json';
const UPSERT_BATCH_SIZE = 25;
const MAX_UPSERT_RETRIES = 3;
const TOPIC_STOP_WORDS = new Set([
    'the', 'and', 'with', 'from', 'that', 'this', 'were', 'have', 'into', 'after',
    'before', 'when', 'while', 'over', 'under', 'then', 'than', 'your', 'their',
    'feature', 'change', 'changes', 'fix', 'fixed', 'update', 'updated', 'updates',
    'refactor', 'cleanup', 'chore', 'docs', 'test', 'tests', 'readme', 'index',
    'src', 'lib', 'app', 'dist', 'build', 'file', 'files', 'code', 'project',
    'main', 'util', 'utils', 'common', 'module', 'modules', 'component', 'components',
]);
const BUG_SIGNAL_WORDS = /(fix|bug|broken|regression|error|guard|handle|prevent|avoid|race|crash|timeout|fail|failing|retry|recover)/i;
const ERROR_SIGNATURE_PATTERNS = [
    /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|TimeoutError)\b/g,
    /\b(ECONNRESET|ECONNREFUSED|ENOENT|ETIMEDOUT|EPIPE|OOM|OutOfMemory)\b/g,
    /\b(null pointer|null dereference|race condition|deadlock|memory leak)\b/gi,
    /cannot read [^\n.,;]+/gi,
    /undefined(?: is not a function| value)?/gi,
];
const TEST_FILE_PATTERN = /([A-Za-z0-9_./-]+\.(?:spec|test)\.[A-Za-z0-9]+)\b/g;
const TEST_NAME_PATTERN = /(?:failing test|test|spec):?\s*["'`](.+?)["'`]/gi;
const MAX_COMPACT_MEMORY_BODY_LINES = 4;
const MAX_COMPACT_MEMORY_BODY_CHARS = 480;
const MEMORY_NOISE_LINE_PATTERNS = [
    /^at\s+\S+/,
    /^co-authored-by:/i,
    /^signed-off-by:/i,
    /^refs?:/i,
    /^https?:\/\/\S+$/i,
    /^[>|=*\-]{3,}$/,
];

function projectMemoryFile(projectRoot: string): string {
    return path.join(getDataDir(projectRoot), PROJECT_MEMORY_FILE);
}

function projectMemoryCacheFile(projectRoot: string): string {
    return path.join(getDataDir(projectRoot), PROJECT_MEMORY_CACHE_FILE);
}

function memoryCollectionName(projectRoot: string): string {
    return scopedCollectionName(projectRoot, 'memory');
}

function memoryPointId(entryId: string): string {
    const hex = crypto.createHash('sha256').update(entryId).digest('hex').slice(0, 32);
    return toUUID(hex);
}

function embeddingFingerprint(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function loadMemorySnapshot(projectRoot: string): ProjectMemorySnapshot | null {
    const file = projectMemoryFile(projectRoot);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ProjectMemorySnapshot;
}

function saveMemorySnapshot(projectRoot: string, snapshot: ProjectMemorySnapshot): void {
    const file = projectMemoryFile(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
}

function loadMemoryCache(cacheFile: string): Record<string, MemoryCacheEntry> {
    if (!fs.existsSync(cacheFile)) return {};
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Record<string, number[] | MemoryCacheEntry>;
    const normalized: Record<string, MemoryCacheEntry> = {};

    for (const [id, value] of Object.entries(raw)) {
        if (Array.isArray(value)) {
            normalized[id] = { fingerprint: '', vector: value };
            continue;
        }

        if (value && Array.isArray(value.vector)) {
            normalized[id] = {
                fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '',
                vector: value.vector,
            };
        }
    }

    return normalized;
}

function saveMemoryCache(cacheFile: string, cache: Record<string, MemoryCacheEntry>): void {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
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

function inferChangeType(commit: GitCommitMetadata, files: string[]): ChangeMemoryEntry['changeType'] {
    const text = `${commit.subject}\n${commit.body}\n${files.join('\n')}`.toLowerCase();
    if (/(fix|bug|hotfix|regression|error|race|crash|broken|issue)/.test(text)) return 'fix';
    if (/(feat|feature|add|introduc|implement|support|create)/.test(text)) return 'feature';
    if (/(refactor|rewrite|cleanup|simplif|reorgan)/.test(text)) return 'refactor';
    if (/(readme|doc|docs|changelog|adr|guide)/.test(text)) return 'docs';
    if (/(test|spec|assert|fixture|jest|vitest|cypress)/.test(text)) return 'test';
    if (/(ci|build|deploy|docker|k8s|release|infra|ops)/.test(text)) return 'ops';
    return 'chore';
}

function inferTopics(commit: GitCommitMetadata, files: string[], symbols: string[], impacts: ProjectMemoryImpact[]): string[] {
    const scores = new Map<string, number>();
    addWeightedTokens(scores, splitTokens(commit.subject), 4);
    addWeightedTokens(scores, splitTokens(commit.body), 2);
    addWeightedTokens(scores, files.flatMap(file => splitTokens(file)), 3);
    addWeightedTokens(scores, symbols.flatMap(symbol => splitTokens(symbol)), 4);
    addWeightedTokens(scores, impacts.flatMap(impact => impact.hints.flatMap(hint => splitTokens(hint))), 2);

    return [...scores.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 6)
        .map(([topic]) => topic);
}

function summarizeImpact(entry: ProjectMemoryEntry): string {
    if (entry.symbols.length > 0) {
        return `touches ${entry.symbols.slice(0, 4).join(', ')}`;
    }

    const hints = entry.impacts.flatMap(impact => impact.hints).filter(Boolean);
    if (hints.length > 0) {
        return `focuses on ${[...new Set(hints)].slice(0, 2).join(' | ')}`;
    }

    if (entry.files.length > 0) {
        return `affects ${entry.files.slice(0, 3).join(', ')}`;
    }

    return 'records a repository change';
}

function limitStrings(values: string[], limit = 4): string[] {
    return dedupeStrings(values).slice(0, limit);
}

function collectRegexMatches(text: string, pattern: RegExp): string[] {
    return [...text.matchAll(pattern)]
        .map(match => match[1] ?? match[0])
        .map(value => value.trim())
        .filter(Boolean);
}

function normalizeSymptom(text: string): string | null {
    const compact = text
        .trim()
        .replace(/^[-*+]>?\s*/, '')
        .replace(/^(fix|fixed|handle|handled|prevent|prevented|avoid|avoids|guard|guarded|recover|recovered)\s+/i, '')
        .replace(/\s+/g, ' ');

    if (!compact) return null;
    if (!BUG_SIGNAL_WORDS.test(text)) return null;
    if (compact.length < 6 || compact.length > 96) return null;
    return compact.replace(/[.]+$/, '');
}

function normalizeNarrativeLine(line: string): string {
    return line
        .trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isNoiseNarrativeLine(line: string): boolean {
    return line.length < 6 || MEMORY_NOISE_LINE_PATTERNS.some(pattern => pattern.test(line));
}

function hasConcreteNarrativeDetail(line: string): boolean {
    return BUG_SIGNAL_WORDS.test(line)
        || collectRegexMatches(line, TEST_FILE_PATTERN).length > 0
        || ERROR_SIGNATURE_PATTERNS.some(pattern => collectRegexMatches(line, pattern).length > 0)
        || /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|php|py|rb|go|java|cs)\b/.test(line);
}

function compactMemoryBody(text: string): string {
    const normalized = text
        .split('\n')
        .map(normalizeNarrativeLine)
        .filter(line => !isNoiseNarrativeLine(line));
    if (normalized.length === 0) return '';

    const prioritized = normalized.filter(hasConcreteNarrativeDetail);
    const selected = dedupeStrings([...prioritized, ...normalized]).slice(0, MAX_COMPACT_MEMORY_BODY_LINES);
    return selected.join('\n').slice(0, MAX_COMPACT_MEMORY_BODY_CHARS);
}

function shouldReuseChangeEntry(entry: ChangeMemoryEntry): boolean {
    if (!entry.body) return true;

    const compactedBody = compactMemoryBody(entry.body);
    if (compactedBody !== entry.body) return false;

    return entry.summary.includes('Detail:');
}

function extractBugEvidence(change: ChangeMemoryEntry): Pick<BugMemoryEntry, 'evidenceScore' | 'symptoms' | 'errorSignatures' | 'failingTests'> {
    const combinedText = [change.title, change.body].filter(Boolean).join('\n');
    const failingTests = limitStrings([
        ...collectRegexMatches(combinedText, TEST_FILE_PATTERN),
        ...collectRegexMatches(combinedText, TEST_NAME_PATTERN),
    ]);
    const errorSignatures = limitStrings(
        ERROR_SIGNATURE_PATTERNS.flatMap(pattern => collectRegexMatches(combinedText, pattern))
    );
    const symptoms = limitStrings([
        normalizeSymptom(change.title),
        ...change.body
            .split('\n')
            .map(line => normalizeSymptom(line)),
        ...change.impacts
            .flatMap(impact => impact.hints)
            .map(hint => normalizeSymptom(hint)),
    ].filter((value): value is string => value !== null));
    const evidenceScore = errorSignatures.length * 3 + failingTests.length * 2 + symptoms.length;

    return {
        evidenceScore,
        symptoms,
        errorSignatures,
        failingTests,
    };
}

function buildEntrySummary(entry: ProjectMemoryEntry): string {
    if (entry.kind === 'bug') {
        const impact = summarizeImpact(entry);
        const topics = entry.topics.length > 0 ? ` Topics: ${entry.topics.slice(0, 4).join(', ')}.` : '';
        const evidence = [
            entry.errorSignatures[0] ? `Signature: ${entry.errorSignatures[0]}.` : '',
            entry.failingTests[0] ? `Test: ${entry.failingTests[0]}.` : '',
            entry.symptoms[0] ? `Symptom: ${entry.symptoms[0]}.` : '',
        ].filter(Boolean).join(' ');
        return `bug memory: ${impact}. Fixed by ${entry.fixedBySha.slice(0, 8)} via ${entry.title}.${evidence ? ` ${evidence}` : ''}${topics}`.trim();
    }

    const impact = summarizeImpact(entry);
    const topics = entry.topics.length > 0 ? ` Topics: ${entry.topics.slice(0, 4).join(', ')}.` : '';
    const detail = entry.kind === 'change' && entry.body
        ? ` Detail: ${entry.body.split('\n')[0]?.replace(/[.]+$/, '')}.`
        : '';
    return `${entry.changeType} change: ${impact}. ${entry.title}.${detail}${topics}`;
}

function buildEmbeddingText(entry: ProjectMemoryEntry): string {
    if (entry.kind === 'document') {
        return [
            `kind: ${entry.kind}`,
            `doc_type: ${entry.docType}`,
            `title: ${entry.title}`,
            `section: ${entry.section}`,
            `path: ${entry.path}`,
            `summary: ${entry.summary}`,
            entry.topics.length > 0 ? `topics: ${entry.topics.join(', ')}` : '',
            entry.symbols.length > 0 ? `symbols: ${entry.symbols.join(', ')}` : '',
            `date: ${entry.timestamp}`,
        ].filter(Boolean).join('\n');
    }

    if (entry.kind === 'bug') {
        const hintText = entry.impacts.flatMap(impact => impact.hints).slice(0, 8);
        return [
            `kind: ${entry.kind}`,
            `status: ${entry.status}`,
            `source: ${entry.source}`,
            `title: ${entry.title}`,
            entry.body ? `details: ${entry.body}` : '',
            `summary: ${entry.summary}`,
            `evidence_score: ${entry.evidenceScore}`,
            entry.errorSignatures.length > 0 ? `error_signatures: ${entry.errorSignatures.join(' | ')}` : '',
            entry.failingTests.length > 0 ? `failing_tests: ${entry.failingTests.join(' | ')}` : '',
            entry.symptoms.length > 0 ? `symptoms: ${entry.symptoms.join(' | ')}` : '',
            entry.topics.length > 0 ? `topics: ${entry.topics.join(', ')}` : '',
            entry.symbols.length > 0 ? `symbols: ${entry.symbols.join(', ')}` : '',
            hintText.length > 0 ? `semantic_hints: ${hintText.join(' | ')}` : '',
            entry.files.length > 0 ? `files: ${entry.files.join(', ')}` : '',
            `fixed_by: ${entry.fixedBySha}`,
            `date: ${entry.timestamp}`,
        ].filter(Boolean).join('\n');
    }

    const hintText = entry.impacts.flatMap(impact => impact.hints).slice(0, 8);
    return [
        `kind: ${entry.kind}`,
        `change_type: ${entry.changeType}`,
        `title: ${entry.title}`,
        entry.body ? `details: ${entry.body}` : '',
        `summary: ${entry.summary}`,
        entry.topics.length > 0 ? `topics: ${entry.topics.join(', ')}` : '',
        entry.symbols.length > 0 ? `symbols: ${entry.symbols.join(', ')}` : '',
        hintText.length > 0 ? `semantic_hints: ${hintText.join(' | ')}` : '',
        entry.files.length > 0 ? `files: ${entry.files.join(', ')}` : '',
        `author: ${entry.authorName}`,
        `date: ${entry.timestamp}`,
        `sha: ${entry.sha}`,
    ].filter(Boolean).join('\n');
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function normalizeLookupValue(value: string): string {
    return value.trim().toLowerCase();
}

function matchesSymbolTarget(symbol: string, target: string): boolean {
    const normalizedSymbol = normalizeLookupValue(symbol);
    return normalizedSymbol === target
        || normalizedSymbol.endsWith(`.${target}`)
        || normalizedSymbol.endsWith(`::${target}`);
}

function matchesFileTarget(file: string, target: string): boolean {
    return normalizeLookupValue(file).includes(target);
}

async function wait(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

function isChangeEntry(entry: ProjectMemoryEntry): entry is ChangeMemoryEntry {
    return entry.kind === 'change';
}

function isBugEntry(entry: ProjectMemoryEntry): entry is BugMemoryEntry {
    return entry.kind === 'bug';
}

function isDocumentEntry(entry: ProjectMemoryEntry): entry is DocumentMemoryEntry {
    return entry.kind === 'document';
}

function isFeatureDocumentEntry(entry: ProjectMemoryEntry): entry is DocumentMemoryEntry {
    if (!isDocumentEntry(entry)) return false;
    if (/(setup|requirements|project status and history|development|index a project|query a project|vs code integration)/i.test(entry.title)) {
        return false;
    }
    if (entry.docType === 'feature' || entry.docType === 'architecture') return true;
    if (entry.docType !== 'overview') return false;

    return /(what it does|overview|features|capabilities|architecture|system|storage layout|language support|mcp server)/i
        .test(entry.title);
}

function buildCommitEntry(projectRoot: string, commit: GitCommitMetadata): ChangeMemoryEntry {
    const patches = getCommitPatch(projectRoot, commit.sha);
    const impacts: ProjectMemoryImpact[] = [];
    const files = dedupeStrings(patches.map(patch => patch.path));

    for (const patch of patches) {
        const useOldRevision = prefersOldRevision(patch) && commit.parents.length > 0;
        const revision = useOldRevision ? commit.parents[0] : commit.sha;
        const revisionPath = useOldRevision ? (patch.oldPath ?? patch.path) : patch.path;
        const source = readGitFile(projectRoot, revision, revisionPath);
        const touch = extractSemanticTouch(
            { ...patch, path: revisionPath },
            source,
            useOldRevision ? 'old' : 'new'
        );

        impacts.push({
            file: patch.path,
            status: patch.status,
            symbols: touch.symbols,
            hints: touch.hints,
        });
    }

    const symbols = dedupeStrings(impacts.flatMap(impact => impact.symbols));
    const topics = inferTopics(commit, files, symbols, impacts);

    const entry: ChangeMemoryEntry = {
        id: `change:${commit.sha}`,
        kind: 'change',
        sha: commit.sha,
        parents: commit.parents,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        timestamp: commit.authoredAt,
        title: commit.subject,
        body: compactMemoryBody(commit.body),
        changeType: inferChangeType(commit, files),
        summary: '',
        topics,
        files,
        symbols,
        impacts,
    };

    entry.summary = buildEntrySummary(entry);
    return entry;
}

function buildBugEntry(change: ChangeMemoryEntry): BugMemoryEntry {
    const evidence = extractBugEvidence(change);
    const entry: BugMemoryEntry = {
        id: `bug:${change.sha}`,
        kind: 'bug',
        timestamp: change.timestamp,
        title: change.title,
        body: change.body,
        summary: '',
        changeType: 'fix',
        topics: change.topics,
        files: change.files,
        symbols: change.symbols,
        impacts: change.impacts,
        source: 'fix-commit',
        fixedBySha: change.sha,
        status: 'fixed',
        evidenceScore: evidence.evidenceScore,
        symptoms: evidence.symptoms,
        errorSignatures: evidence.errorSignatures,
        failingTests: evidence.failingTests,
    };

    entry.summary = buildEntrySummary(entry);
    return entry;
}

interface MemoryCollectionState {
    qdrant: QdrantClient;
    needsFullSync: boolean;
    cacheInvalidated: boolean;
}

async function ensureMemoryCollection(projectRoot: string, qdrantUrl: string): Promise<MemoryCollectionState> {
    const qdrant = new QdrantClient({ url: qdrantUrl });
    const collection = memoryCollectionName(projectRoot);
    const existing = await qdrant.getCollections();
    let needsFullSync = false;
    let cacheInvalidated = false;

    if (existing.collections.find(item => item.name === collection)) {
        const info = await qdrant.getCollection(collection);
        const dim = (info.config?.params?.vectors as { size?: number } | undefined)?.size;
        if (dim !== undefined && dim !== VECTOR_SIZE) {
            await qdrant.deleteCollection(collection);
            await qdrant.createCollection(collection, {
                vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
            });
            needsFullSync = true;
            cacheInvalidated = true;
        }
    } else {
        await qdrant.createCollection(collection, {
            vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });
        needsFullSync = true;
    }

    return { qdrant, needsFullSync, cacheInvalidated };
}

async function upsertWithRetry(
    qdrant: QdrantClient,
    collection: string,
    points: Array<{
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
    }>
): Promise<void> {
    for (let attempt = 1; attempt <= MAX_UPSERT_RETRIES; attempt++) {
        try {
            await qdrant.upsert(collection, { points });
            return;
        } catch (error) {
            if (attempt === MAX_UPSERT_RETRIES) throw error;
            await wait(200 * attempt);
        }
    }
}

async function upsertMemoryEntries(
    projectRoot: string,
    entries: ProjectMemoryEntry[],
    cacheFile: string,
    qdrantUrl: string
): Promise<number> {
    if (entries.length === 0) return 0;

    const { qdrant, needsFullSync, cacheInvalidated } = await ensureMemoryCollection(projectRoot, qdrantUrl);
    const collection = memoryCollectionName(projectRoot);
    const cache = cacheInvalidated ? {} : loadMemoryCache(cacheFile);
    const embeddingTexts = new Map(entries.map(entry => [entry.id, buildEmbeddingText(entry)]));
    const uncached = entries.filter(entry => {
        const text = embeddingTexts.get(entry.id) ?? '';
        const fingerprint = embeddingFingerprint(text);
        return !cache[entry.id] || cache[entry.id].fingerprint !== fingerprint;
    });

    if (uncached.length > 0) {
        const vectors = await embedTexts(uncached.map(entry => embeddingTexts.get(entry.id) ?? ''));
        uncached.forEach((entry, index) => {
            const text = embeddingTexts.get(entry.id) ?? '';
            cache[entry.id] = {
                fingerprint: embeddingFingerprint(text),
                vector: vectors[index],
            };
        });
        saveMemoryCache(cacheFile, cache);
    }

    const entriesToStore = needsFullSync ? entries : uncached;
    const points = entriesToStore.map(entry => ({
        id: memoryPointId(entry.id),
        vector: cache[entry.id].vector,
        payload: {
            entryId: entry.id,
            sha: entry.kind === 'change' ? entry.sha : entry.kind === 'bug' ? entry.fixedBySha : undefined,
            kind: entry.kind,
            type: entry.kind === 'bug' ? 'bug' : entry.changeType,
            title: entry.title,
            summary: entry.summary,
            timestamp: entry.timestamp,
            topics: entry.topics,
            files: entry.files,
            symbols: entry.symbols,
            source: entry.kind === 'bug' ? entry.source : undefined,
            status: entry.kind === 'bug' ? entry.status : undefined,
            evidenceScore: entry.kind === 'bug' ? entry.evidenceScore : undefined,
            errorSignatures: entry.kind === 'bug' ? entry.errorSignatures : undefined,
            failingTests: entry.kind === 'bug' ? entry.failingTests : undefined,
            symptoms: entry.kind === 'bug' ? entry.symptoms : undefined,
            path: entry.kind === 'document' ? entry.path : undefined,
            docType: entry.kind === 'document' ? entry.docType : undefined,
        },
    }));

    for (let index = 0; index < points.length; index += UPSERT_BATCH_SIZE) {
        await upsertWithRetry(qdrant, collection, points.slice(index, index + UPSERT_BATCH_SIZE));
    }

    return uncached.length;
}

async function deleteStaleMemoryEntries(
    projectRoot: string,
    staleIds: string[],
    cacheFile: string,
    qdrantUrl: string
): Promise<number> {
    if (staleIds.length === 0) return 0;

    const cache = loadMemoryCache(cacheFile);
    for (const id of staleIds) delete cache[id];
    saveMemoryCache(cacheFile, cache);

    const { qdrant } = await ensureMemoryCollection(projectRoot, qdrantUrl);
    await qdrant.delete(memoryCollectionName(projectRoot), {
        points: staleIds.map(memoryPointId),
    });

    return staleIds.length;
}

export async function syncProjectMemory(
    projectRoot: string,
    qdrantUrl = 'http://localhost:6333'
): Promise<ProjectMemorySyncResult> {
    const root = path.resolve(projectRoot);
    const oldSnapshot = loadMemorySnapshot(root);
    const { branch, headSha, entries, latestChangeSha } = buildProjectMemoryEntries(root, oldSnapshot?.entries ?? []);
    const snapshot: ProjectMemorySnapshot = {
        branch,
        headSha,
        syncedAt: new Date().toISOString(),
        maxCommits: MAX_COMMITS,
        entries,
    };

    const cacheFile = projectMemoryCacheFile(root);
    const oldIds = new Set((oldSnapshot?.entries ?? []).map(entry => entry.id));
    const newIds = new Set(entries.map(entry => entry.id));
    const staleIds = [...oldIds].filter(id => !newIds.has(id));
    const newEntries = entries.filter(entry => !oldIds.has(entry.id));

    await upsertMemoryEntries(root, entries, cacheFile, qdrantUrl);
    const staleRemoved = await deleteStaleMemoryEntries(root, staleIds, cacheFile, qdrantUrl);
    saveMemorySnapshot(root, snapshot);

    return {
        totalEntries: entries.length,
        newEntries: newEntries.length,
        staleRemoved,
        latestChangeSha,
    };
}

export function buildProjectMemoryEntries(
    projectRoot: string,
    previousEntries: ProjectMemoryEntry[] = []
): ProjectMemoryBuildResult {
    const root = path.resolve(projectRoot);
    const branch = getCurrentBranch(root);
    const headSha = getHeadCommit(root);
    const commits = listRecentCommitMetadata(root, MAX_COMMITS);
    const previousChangesBySha = new Map(
        previousEntries
            .filter(isChangeEntry)
            .filter(shouldReuseChangeEntry)
            .map(entry => [entry.sha, entry])
    );

    const changeEntries = commits.map(commit => previousChangesBySha.get(commit.sha) ?? buildCommitEntry(root, commit));
    const bugEntries = changeEntries
        .filter(entry => entry.changeType === 'fix')
        .map(buildBugEntry)
        .filter(entry => entry.evidenceScore > 0);
    const documentEntries = buildDocumentEntries(root);
    const entries = [...bugEntries, ...changeEntries, ...documentEntries]
        .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));

    return {
        branch,
        headSha,
        entries,
        latestChangeSha: changeEntries[0]?.sha ?? null,
    };
}

export function listRecentChanges(
    projectRoot: string,
    opts?: { limit?: number; type?: ChangeMemoryEntry['changeType']; topic?: string }
): ChangeMemoryEntry[] {
    const snapshot = loadMemorySnapshot(path.resolve(projectRoot));
    if (!snapshot) return [];

    const typeFilter = opts?.type;
    const topicFilter = opts?.topic?.toLowerCase();
    const limit = opts?.limit ?? 10;

    return snapshot.entries
        .filter(isChangeEntry)
        .filter(entry => !typeFilter || entry.changeType === typeFilter)
        .filter(entry => !topicFilter || entry.topics.some(topic => topic.includes(topicFilter)))
        .slice(0, limit);
}

export async function queryProjectMemory(
    projectRoot: string,
    question: string,
    qdrantUrl = 'http://localhost:6333',
    limit = 5
): Promise<ProjectMemorySearchHit[]> {
    const root = path.resolve(projectRoot);
    const snapshot = loadMemorySnapshot(root);
    if (!snapshot || snapshot.entries.length === 0) return [];

    const { qdrant } = await ensureMemoryCollection(root, qdrantUrl);
    const hits = await qdrant.search(memoryCollectionName(root), {
        vector: await embedQuery(question),
        limit: Math.max(limit * 2, 10),
        with_payload: true,
    });

    const now = Date.now();
    const questionText = question.toLowerCase();
    const lookingForFixes = /(bug|fix|broken|incident|regression|issue|error)/.test(questionText);
    const lookingForProjectFacts = /(what does|what is|feature|capabilit|architecture|overview|design|how .*work|system|status)/.test(questionText);
    const entryById = new Map(snapshot.entries.map(entry => [entry.id, entry]));

    return hits
        .map(hit => {
            const entryId = hit.payload?.['entryId'] as string | undefined;
            if (!entryId) return null;
            const entry = entryById.get(entryId);
            if (!entry) return null;

            const ageDays = Math.max(0, (now - Date.parse(entry.timestamp)) / 86_400_000);
            const freshness = entry.kind === 'document'
                ? Math.max(0.2, 1 - ageDays / 365)
                : Math.max(0, 1 - ageDays / 180);
            const fixBoost = lookingForFixes
                ? entry.kind === 'bug'
                    ? 0.22
                    : entry.kind === 'change' && entry.changeType === 'fix'
                        ? 0.15
                        : 0
                : 0;
            const authorityBoost = entry.kind === 'document' ? 0.06 : 0;
            const factBoost = lookingForProjectFacts && isFeatureDocumentEntry(entry) ? 0.2 : 0;
            return {
                entry,
                score: hit.score * 0.72 + freshness * 0.16 + authorityBoost + factBoost + fixBoost,
            } satisfies ProjectMemorySearchHit;
        })
        .filter((hit): hit is ProjectMemorySearchHit => hit !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
}

export function getProjectStatus(projectRoot: string): ProjectStatusSnapshot | null {
    const root = path.resolve(projectRoot);
    const snapshot = loadMemorySnapshot(root);
    if (!snapshot) return null;

    const recentEntries = snapshot.entries.slice(0, 20);
    const changeEntries = snapshot.entries.filter(isChangeEntry);
    const recentChangeEntries = changeEntries.slice(0, 20);
    const featureDocs = snapshot.entries
        .filter(isFeatureDocumentEntry)
        .slice(0, 3);
    const topicCounts = new Map<string, number>();
    for (const entry of recentEntries) {
        for (const topic of entry.topics) {
            topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
        }
    }

    const changeKinds = new Map<ChangeMemoryEntry['changeType'], number>();
    for (const entry of recentChangeEntries) {
        changeKinds.set(entry.changeType, (changeKinds.get(entry.changeType) ?? 0) + 1);
    }

    return {
        branch: snapshot.branch,
        headSha: snapshot.headSha,
        memoryEntries: snapshot.entries.length,
        latestChange: changeEntries[0] ?? null,
        dirtyFiles: getWorkingTreeChanges(root),
        recentFixes: changeEntries.filter(entry => entry.changeType === 'fix').slice(0, 3),
        activeTopics: [...topicCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 5)
            .map(([topic, count]) => ({ topic, count })),
        changeKinds: [...changeKinds.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([type, count]) => ({ type, count })),
        featureDocs,
    };
}

function renderImpact(entry: ProjectMemoryEntry): string {
    const symbols = entry.symbols.slice(0, 5);
    if (symbols.length > 0) return symbols.join(', ');

    const hints = dedupeStrings(entry.impacts.flatMap(impact => impact.hints)).slice(0, 3);
    if (hints.length > 0) return hints.join(' | ');

    return entry.files.slice(0, 3).join(', ');
}

function renderEntryLabel(entry: ProjectMemoryEntry): string {
    return entry.kind === 'change'
        ? entry.sha.slice(0, 8)
        : entry.kind === 'bug'
            ? `bug@${entry.fixedBySha.slice(0, 8)}`
        : entry.path;
}

function renderEntryType(entry: ProjectMemoryEntry): string {
    return entry.kind === 'change'
        ? entry.changeType
        : entry.kind === 'bug'
            ? 'bug memory'
        : `${entry.docType} doc`;
}

export function renderEntrySource(entry: ProjectMemoryEntry): string {
    if (entry.kind === 'change') return entry.sha;
    if (entry.kind === 'bug') return `fix commit ${entry.fixedBySha}`;
    return entry.section && entry.section !== path.basename(entry.path)
        ? `${entry.path} > ${entry.section}`
        : entry.path;
}

export function renderRecentChanges(entries: ChangeMemoryEntry[]): string {
    if (entries.length === 0) return 'No project-memory changes found.';

    return entries.map(entry => {
        const shortSha = entry.sha.slice(0, 8);
        return [
            `### ${entry.title} (${shortSha})`,
            `Type: ${entry.changeType}`,
            `When: ${entry.timestamp}`,
            `Summary: ${entry.summary}`,
            `Impact: ${renderImpact(entry)}`,
            entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
            entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');
}

export function renderMemoryQueryResults(results: ProjectMemorySearchHit[]): string {
    if (results.length === 0) return 'No matching project-memory entries found.';

    return results.map(result => {
        const entry = result.entry;
        const bugEvidence = entry.kind === 'bug'
            ? [
                entry.errorSignatures.length > 0 ? `Error signatures: ${entry.errorSignatures.join(', ')}` : '',
                entry.failingTests.length > 0 ? `Failing tests: ${entry.failingTests.join(', ')}` : '',
                entry.symptoms.length > 0 ? `Symptoms: ${entry.symptoms.join('; ')}` : '',
            ].filter(Boolean)
            : [];
        return [
            `### ${entry.title} (${renderEntryLabel(entry)})`,
            `Type: ${renderEntryType(entry)}  [score: ${result.score.toFixed(3)}]`,
            `When: ${entry.timestamp}`,
            `Source: ${renderEntrySource(entry)}`,
            `Summary: ${entry.summary}`,
            ...bugEvidence,
            `Impact: ${renderImpact(entry)}`,
            entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
            entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');
}

export function listRecentBugs(
    projectRoot: string,
    opts?: { limit?: number; topic?: string }
): BugMemoryEntry[] {
    const snapshot = loadMemorySnapshot(path.resolve(projectRoot));
    if (!snapshot) return [];

    const topicFilter = opts?.topic?.toLowerCase();
    const limit = opts?.limit ?? 10;

    return snapshot.entries
        .filter(isBugEntry)
        .filter(entry => !topicFilter || entry.topics.some(topic => topic.includes(topicFilter)))
        .slice(0, limit);
}

export function renderRecentBugs(entries: BugMemoryEntry[]): string {
    if (entries.length === 0) return 'No bug-memory entries found.';

    return entries.map(entry => [
        `### ${entry.title} (${entry.fixedBySha.slice(0, 8)})`,
        `Status: ${entry.status}`,
        `Evidence score: ${entry.evidenceScore}`,
        `When fixed: ${entry.timestamp}`,
        `Fixed by: ${entry.fixedBySha}`,
        entry.errorSignatures.length > 0 ? `Error signatures: ${entry.errorSignatures.join(', ')}` : '',
        entry.failingTests.length > 0 ? `Failing tests: ${entry.failingTests.join(', ')}` : '',
        entry.symptoms.length > 0 ? `Symptoms: ${entry.symptoms.join('; ')}` : '',
        `Summary: ${entry.summary}`,
        `Impact: ${renderImpact(entry)}`,
        entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
        entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
    ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

export function renderProjectStatus(status: ProjectStatusSnapshot): string {
    const lines = [
        `Branch: ${status.branch ?? 'n/a'}`,
        `HEAD: ${status.headSha ? status.headSha.slice(0, 8) : 'n/a'}`,
        `Project memory entries: ${status.memoryEntries}`,
    ];

    if (status.latestChange) {
        lines.push(`Latest change: ${status.latestChange.title} (${status.latestChange.sha.slice(0, 8)})`);
        lines.push(`Latest summary: ${status.latestChange.summary}`);
    }

    if (status.activeTopics.length > 0) {
        lines.push(`Active topics: ${status.activeTopics.map(topic => `${topic.topic} (${topic.count})`).join(', ')}`);
    }

    if (status.changeKinds.length > 0) {
        lines.push(`Recent change mix: ${status.changeKinds.map(item => `${item.type} (${item.count})`).join(', ')}`);
    }

    if (status.featureDocs.length > 0) {
        lines.push(`Feature docs: ${status.featureDocs.map(entry => renderEntrySource(entry)).join('; ')}`);
    }

    if (status.recentFixes.length > 0) {
        lines.push(`Recent fixes: ${status.recentFixes.map(entry => `${entry.sha.slice(0, 8)} ${entry.title}`).join('; ')}`);
    }

    if (status.dirtyFiles.length > 0) {
        lines.push(`Dirty files: ${status.dirtyFiles.map(file => `${file.path} [${file.status}]`).join(', ')}`);
    } else {
        lines.push('Dirty files: none');
    }

    return lines.join('\n');
}

export function getProjectMemoryCount(projectRoot: string): number {
    return loadMemorySnapshot(path.resolve(projectRoot))?.entries.length ?? 0;
}

export function getProjectMemoryEntries(projectRoot: string): ProjectMemoryEntry[] {
    return loadMemorySnapshot(path.resolve(projectRoot))?.entries ?? [];
}

export function getWhyChanged(
    projectRoot: string,
    opts: { target: string; mode?: 'auto' | 'symbol' | 'file'; topic?: string; limit?: number }
): WhyChangedResult | null {
    const snapshot = loadMemorySnapshot(path.resolve(projectRoot));
    if (!snapshot) return null;

    const mode = opts.mode ?? 'auto';
    const normalizedTarget = normalizeLookupValue(opts.target);
    const topicFilter = opts.topic?.toLowerCase();
    const limit = opts.limit ?? 10;
    const topicCounts = new Map<string, number>();

    const allMatches = snapshot.entries
        .filter(isChangeEntry)
        .filter(entry => !topicFilter || entry.topics.some(topic => topic.includes(topicFilter)))
        .map(entry => {
            const matchedSymbols = mode === 'file'
                ? []
                : entry.symbols.filter(symbol => matchesSymbolTarget(symbol, normalizedTarget));
            const matchedFiles = mode === 'symbol'
                ? []
                : entry.files.filter(file => matchesFileTarget(file, normalizedTarget));

            if (matchedSymbols.length === 0 && matchedFiles.length === 0) return null;
            for (const topic of entry.topics) {
                topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
            }
            return {
                entry,
                matchedSymbols,
                matchedFiles,
            } satisfies WhyChangedMatch;
        })
        .filter((match): match is WhyChangedMatch => match !== null);

    return {
        target: opts.target,
        mode,
        totalMatches: allMatches.length,
        activeTopics: [...topicCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 5)
            .map(([topic, count]) => ({ topic, count })),
        matches: allMatches.slice(0, limit),
    };
}

export function getBugBrief(
    projectRoot: string,
    opts: { target: string; mode?: 'auto' | 'symbol' | 'file'; topic?: string; limit?: number }
): BugBriefResult | null {
    const snapshot = loadMemorySnapshot(path.resolve(projectRoot));
    if (!snapshot) return null;

    const mode = opts.mode ?? 'auto';
    const normalizedTarget = normalizeLookupValue(opts.target);
    const topicFilter = opts.topic?.toLowerCase();
    const limit = opts.limit ?? 10;
    const topicCounts = new Map<string, number>();

    const allMatches = snapshot.entries
        .filter(isBugEntry)
        .filter(entry => !topicFilter || entry.topics.some(topic => topic.includes(topicFilter)))
        .map(entry => {
            const matchedSymbols = mode === 'file'
                ? []
                : entry.symbols.filter(symbol => matchesSymbolTarget(symbol, normalizedTarget));
            const matchedFiles = mode === 'symbol'
                ? []
                : entry.files.filter(file => matchesFileTarget(file, normalizedTarget));

            if (matchedSymbols.length === 0 && matchedFiles.length === 0) return null;
            for (const topic of entry.topics) {
                topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
            }
            return {
                entry,
                matchedSymbols,
                matchedFiles,
            } satisfies BugBriefMatch;
        })
        .filter((match): match is BugBriefMatch => match !== null);

    return {
        target: opts.target,
        mode,
        totalMatches: allMatches.length,
        activeTopics: [...topicCounts.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 5)
            .map(([topic, count]) => ({ topic, count })),
        matches: allMatches.slice(0, limit),
    };
}

export function renderWhyChanged(result: WhyChangedResult): string {
    if (result.totalMatches === 0) {
        return `No recorded changes matched "${result.target}".`;
    }

    const sections = [
        `Target: ${result.target}`,
        `Match mode: ${result.mode}`,
        `Matched changes: ${result.totalMatches}`,
        result.activeTopics.length > 0
            ? `Active topics: ${result.activeTopics.map(item => `${item.topic} (${item.count})`).join(', ')}`
            : '',
    ].filter(Boolean);

    sections.push(
        result.matches.map(match => {
            const entry = match.entry;
            return [
                `### ${entry.title} (${entry.sha.slice(0, 8)})`,
                `Type: ${entry.changeType}`,
                `When: ${entry.timestamp}`,
                match.matchedSymbols.length > 0 ? `Matched symbols: ${match.matchedSymbols.join(', ')}` : '',
                match.matchedFiles.length > 0 ? `Matched files: ${match.matchedFiles.join(', ')}` : '',
                `Summary: ${entry.summary}`,
                entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
                entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
            ].filter(Boolean).join('\n');
        }).join('\n\n---\n\n')
    );

    return sections.join('\n\n');
}

export function renderBugBrief(result: BugBriefResult): string {
    if (result.totalMatches === 0) {
        return `No recorded bugs matched "${result.target}".`;
    }

    const sections = [
        `Target: ${result.target}`,
        `Match mode: ${result.mode}`,
        `Matched bugs: ${result.totalMatches}`,
        result.activeTopics.length > 0
            ? `Active topics: ${result.activeTopics.map(item => `${item.topic} (${item.count})`).join(', ')}`
            : '',
    ].filter(Boolean);

    sections.push(
        result.matches.map(match => {
            const entry = match.entry;
            return [
                `### ${entry.title} (${entry.fixedBySha.slice(0, 8)})`,
                `Status: ${entry.status}`,
                `Evidence score: ${entry.evidenceScore}`,
                `When fixed: ${entry.timestamp}`,
                `Fixed by: ${entry.fixedBySha}`,
                entry.errorSignatures.length > 0 ? `Error signatures: ${entry.errorSignatures.join(', ')}` : '',
                entry.failingTests.length > 0 ? `Failing tests: ${entry.failingTests.join(', ')}` : '',
                entry.symptoms.length > 0 ? `Symptoms: ${entry.symptoms.join('; ')}` : '',
                match.matchedSymbols.length > 0 ? `Matched symbols: ${match.matchedSymbols.join(', ')}` : '',
                match.matchedFiles.length > 0 ? `Matched files: ${match.matchedFiles.join(', ')}` : '',
                `Summary: ${entry.summary}`,
                entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
                entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
            ].filter(Boolean).join('\n');
        }).join('\n\n---\n\n')
    );

    return sections.join('\n\n');
}

export function getFeatureMap(projectRoot: string): ProjectFeatureMapSnapshot | null {
    const snapshot = loadMemorySnapshot(path.resolve(projectRoot));
    if (!snapshot) return null;

    const documentedFeatures = snapshot.entries
        .filter(isFeatureDocumentEntry)
        .slice(0, 8);

    const recentFeatureChanges = snapshot.entries
        .filter(isChangeEntry)
        .filter(entry => entry.changeType === 'feature')
        .slice(0, 5);

    return {
        documentedFeatures: documentedFeatures.length > 0
            ? documentedFeatures
            : snapshot.entries.filter(isDocumentEntry).slice(0, 5),
        recentFeatureChanges,
    };
}

export function renderFeatureMap(featureMap: ProjectFeatureMapSnapshot): string {
    const sections: string[] = [];

    if (featureMap.documentedFeatures.length > 0) {
        sections.push([
            '## Documented areas',
            featureMap.documentedFeatures.map(entry => [
                `### ${entry.title}`,
                `Source: ${renderEntrySource(entry)}`,
                `Type: ${entry.docType}`,
                `Summary: ${entry.summary}`,
                entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
            ].filter(Boolean).join('\n')).join('\n\n---\n\n'),
        ].join('\n\n'));
    }

    if (featureMap.recentFeatureChanges.length > 0) {
        sections.push([
            '## Recent feature changes',
            featureMap.recentFeatureChanges.map(entry => [
                `### ${entry.title} (${entry.sha.slice(0, 8)})`,
                `When: ${entry.timestamp}`,
                `Summary: ${entry.summary}`,
                `Impact: ${renderImpact(entry)}`,
            ].join('\n')).join('\n\n---\n\n'),
        ].join('\n\n'));
    }

    return sections.length > 0
        ? sections.join('\n\n')
        : 'No documented features or recent feature changes found.';
}
