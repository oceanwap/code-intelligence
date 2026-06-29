import { type DuplicateSource, type SemanticDuplicateOptions, type SemanticDuplicatePattern, type SemanticDuplicateSnapshot } from './types.js';
import { detectStructuralDuplicatesAsync } from './engine.js';
import { runAstGrepAsync, runMadgeAsync, runSemgrepAsync } from './external.js';
import { loadSemanticDuplicatesAsync, saveSemanticDuplicatesAsync } from './storage.js';
import { loadDuplicateContextAsync, scoreDuplicatePatterns, type DuplicateContext } from './signals.js';

export interface RunDuplicateDetectionOptions extends SemanticDuplicateOptions {
  /** Run ast-grep if installed and merge its matches. */
  withAstGrep?: boolean;
  astGrepRulePath?: string;
  /** Run semgrep if installed and merge its matches. */
  withSemgrep?: boolean;
  semgrepConfig?: string;
  /** Run madge if installed and merge circular dependency findings. */
  withMadge?: boolean;
  /** Override the detected project root. */
  projectRoot?: string;
  /**
   * Enrich patterns with architecture/attention/evolution signals and recommendations.
   * Default true. Disable when running in a context where those snapshots are unavailable.
   */
  withEnrichment?: boolean;
}

function countBy<T extends string>(items: T[]): Record<T, number> {
  const record = {} as Record<T, number>;
  for (const item of items) {
    record[item] = (record[item] ?? 0) + 1;
  }
  return record;
}

export async function detectSemanticDuplicatesAsync(
  projectRoot: string,
  options: RunDuplicateDetectionOptions = {}
): Promise<SemanticDuplicateSnapshot> {
  const root = options.projectRoot ?? projectRoot;
  const patterns: SemanticDuplicatePattern[] = [];

  // Always run the native ts-morph structural duplicate detector.
  const structural = await detectStructuralDuplicatesAsync(root, options);
  patterns.push(...structural);

  // Optional external analyzers.
  if (options.withAstGrep) {
    const astGrep = await runAstGrepAsync(root, options.astGrepRulePath);
    patterns.push(...astGrep.patterns);
  }

  if (options.withSemgrep) {
    const semgrep = await runSemgrepAsync(root, options.semgrepConfig);
    patterns.push(...semgrep.patterns);
  }

  if (options.withMadge) {
    const madge = await runMadgeAsync(root);
    patterns.push(...madge.patterns);
  }

  // Enrich with architectural context and recommendations.
  const withEnrichment = options.withEnrichment !== false;
  let context: DuplicateContext | undefined;
  if (withEnrichment) {
    context = await loadDuplicateContextAsync(root);
    patterns.splice(0, patterns.length, ...scoreDuplicatePatterns(patterns, context));
  }

  const sources = patterns.map(p => p.source);
  const severities = patterns.map(p => p.severity);

  const snapshot: SemanticDuplicateSnapshot = {
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    totalPatterns: patterns.length,
    bySource: countBy(sources),
    bySeverity: countBy(severities),
    patterns,
  };

  await saveSemanticDuplicatesAsync(root, snapshot);
  return snapshot;
}

export async function loadSemanticDuplicates(projectRoot: string): Promise<SemanticDuplicateSnapshot | null> {
  return loadSemanticDuplicatesAsync(projectRoot);
}

export function sourcesUsed(snapshot: SemanticDuplicateSnapshot): DuplicateSource[] {
  return Object.keys(snapshot.bySource) as DuplicateSource[];
}

/** Refresh alias that matches the naming convention of other cognition engines. */
export async function refreshSemanticDuplicatesAsync(
  projectRoot: string,
  options?: Omit<RunDuplicateDetectionOptions, 'projectRoot'>
): Promise<SemanticDuplicateSnapshot> {
  return detectSemanticDuplicatesAsync(projectRoot, options);
}

export { loadDuplicateContextAsync, scoreDuplicatePatterns };
export type { DuplicateContext };
