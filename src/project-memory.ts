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

export type ProjectMemoryEntry = ChangeMemoryEntry | DocumentMemoryEntry;

interface ProjectMemorySnapshot {
    branch: string | null;
    headSha: string | null;
    syncedAt: string;
    maxCommits: number;
    entries: ProjectMemoryEntry[];
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

function loadMemoryCache(cacheFile: string): Record<string, number[]> {
    if (!fs.existsSync(cacheFile)) return {};
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Record<string, number[]>;
}

function saveMemoryCache(cacheFile: string, cache: Record<string, number[]>): void {
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

function buildEntrySummary(entry: ProjectMemoryEntry): string {
    const impact = summarizeImpact(entry);
    const topics = entry.topics.length > 0 ? ` Topics: ${entry.topics.slice(0, 4).join(', ')}.` : '';
    return `${entry.changeType} change: ${impact}. ${entry.title}.${topics}`;
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
            `body: ${entry.body}`,
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

async function wait(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

function isChangeEntry(entry: ProjectMemoryEntry): entry is ChangeMemoryEntry {
    return entry.kind === 'change';
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
        body: commit.body,
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

async function ensureMemoryCollection(projectRoot: string, qdrantUrl: string): Promise<QdrantClient> {
    const qdrant = new QdrantClient({ url: qdrantUrl });
    const collection = memoryCollectionName(projectRoot);
    const existing = await qdrant.getCollections();

    if (existing.collections.find(item => item.name === collection)) {
        const info = await qdrant.getCollection(collection);
        const dim = (info.config?.params?.vectors as { size?: number } | undefined)?.size;
        if (dim !== undefined && dim !== VECTOR_SIZE) {
            await qdrant.deleteCollection(collection);
            await qdrant.createCollection(collection, {
                vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
            });
        }
    } else {
        await qdrant.createCollection(collection, {
            vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
        });
    }

    return qdrant;
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

    const qdrant = await ensureMemoryCollection(projectRoot, qdrantUrl);
    const collection = memoryCollectionName(projectRoot);
    const cache = loadMemoryCache(cacheFile);
    const uncached = entries.filter(entry => !cache[entry.id]);

    if (uncached.length > 0) {
        const vectors = await embedTexts(uncached.map(entry => buildEmbeddingText(entry)));
        uncached.forEach((entry, index) => {
            cache[entry.id] = vectors[index];
        });
        saveMemoryCache(cacheFile, cache);
    }

    const points = uncached.map(entry => ({
        id: memoryPointId(entry.id),
        vector: cache[entry.id],
        payload: {
            entryId: entry.id,
            sha: entry.kind === 'change' ? entry.sha : undefined,
            kind: entry.kind,
            type: entry.changeType,
            title: entry.title,
            summary: entry.summary,
            timestamp: entry.timestamp,
            topics: entry.topics,
            files: entry.files,
            symbols: entry.symbols,
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

    const qdrant = await ensureMemoryCollection(projectRoot, qdrantUrl);
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
            .map(entry => [entry.sha, entry])
    );

    const changeEntries = commits.map(commit => previousChangesBySha.get(commit.sha) ?? buildCommitEntry(root, commit));
    const documentEntries = buildDocumentEntries(root);
    const entries = [...changeEntries, ...documentEntries]
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

    const qdrant = await ensureMemoryCollection(root, qdrantUrl);
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
            const fixBoost = lookingForFixes && entry.kind === 'change' && entry.changeType === 'fix' ? 0.15 : 0;
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
        : entry.path;
}

function renderEntryType(entry: ProjectMemoryEntry): string {
    return entry.kind === 'change'
        ? entry.changeType
        : `${entry.docType} doc`;
}

function renderEntrySource(entry: ProjectMemoryEntry): string {
    if (entry.kind === 'change') return entry.sha;
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
        return [
            `### ${entry.title} (${renderEntryLabel(entry)})`,
            `Type: ${renderEntryType(entry)}  [score: ${result.score.toFixed(3)}]`,
            `When: ${entry.timestamp}`,
            `Source: ${renderEntrySource(entry)}`,
            `Summary: ${entry.summary}`,
            `Impact: ${renderImpact(entry)}`,
            entry.topics.length > 0 ? `Topics: ${entry.topics.join(', ')}` : '',
            entry.files.length > 0 ? `Files: ${entry.files.join(', ')}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');
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
