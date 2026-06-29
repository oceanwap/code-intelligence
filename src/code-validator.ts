/**
 * code-validator.ts
 *
 * Post-generation gate: validates a generated code string before it is
 * committed, catching duplicates, constraint violations, and naming
 * inconsistencies that the agent may have missed during generation.
 *
 * Three checks run in parallel:
 *   1. Duplicate detection   — extracted symbol names vs the indexed codebase
 *   2. Constraint check      — import statements vs architectural rules
 *   3. Naming consistency    — generated symbol names vs module naming patterns
 */

import * as path from 'path';
import { Project, SyntaxKind, type Node as MorphNode } from 'ts-morph';
import { findExisting, type ExistingMatch } from './find-existing.js';
import { loadArchitectureAsync } from './cognition/architecture/storage.js';
import { listConstraintViolationsAsync } from './cognition/constraints/engine.js';
import { moduleFromFile } from './utils/module-path.js';
import { loadGraphAsync } from './graph.js';
import { getDataDir } from './git.js';
import { MissingCodeIndexError } from './retriever.js';
import { loadSemanticDuplicates } from './cognition/duplicates/orchestrator.js';
import { type SemanticDuplicatePattern } from './cognition/duplicates/types.js';
import { normalizeBodyText, hashNormalized } from './cognition/duplicates/engine.js';

export type ValidationSeverity = 'PASS' | 'WARN' | 'BLOCK';

export interface DuplicateFlag {
  generatedSymbol: string;
  existingMatch: ExistingMatch;
}

export interface StructuralDuplicateFlag {
  generatedSymbol: string;
  patternId: string;
  category: string;
  occurrenceCount: number;
  existingLocations: Array<{ file: string; symbol: string; line: number }>;
  recommendation: string;
}

export interface ConstraintFlag {
  importPath: string;
  rule: string;
  severity: string;
  details: string;
}

export interface NamingFlag {
  generatedSymbol: string;
  dominantPattern: string;
  suggestion: string;
}

export interface CodeValidationResult {
  verdict: ValidationSeverity;
  duplicateFlags: DuplicateFlag[];
  structuralDuplicateFlags: StructuralDuplicateFlag[];
  constraintFlags: ConstraintFlag[];
  namingFlags: NamingFlag[];
  summary: string;
}

// ── Symbol extraction ─────────────────────────────────────────────────────────

/**
 * Extracts top-level symbol names from generated code using simple regex.
 * Handles: function declarations, arrow const, class declarations, type/interface exports.
 */
function extractSymbolNames(code: string): string[] {
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>)/g,
    /(?:export\s+)?(?:type|interface)\s+(\w+)/g,
  ];
  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Extracts import specifiers from generated code.
 */
function extractImports(code: string): string[] {
  const imports: string[] = [];
  for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) imports.push(match[1]);
  }
  return imports;
}

function detectStructuralDuplicatesInCode(
  code: string,
  duplicateSnapshot: { patterns: SemanticDuplicatePattern[] } | null
): StructuralDuplicateFlag[] {
  if (!duplicateSnapshot || duplicateSnapshot.patterns.length === 0) return [];
  const patternsByHash = new Map<string, SemanticDuplicatePattern>();
  for (const pattern of duplicateSnapshot.patterns) {
    const hash = pattern.id.split(':')[2];
    if (hash) patternsByHash.set(hash, pattern);
  }
  if (patternsByHash.size === 0) return [];

  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile('generated.ts', code);

  const flags: StructuralDuplicateFlag[] = [];
  const seen = new Set<string>();

  const checkNode = (name: string, body: MorphNode | undefined) => {
    if (!body) return;
    const { normalized } = normalizeBodyText(body);
    const hash = hashNormalized(normalized);
    const pattern = patternsByHash.get(hash);
    if (pattern && !seen.has(pattern.id)) {
      seen.add(pattern.id);
      flags.push({
        generatedSymbol: name,
        patternId: pattern.id,
        category: pattern.category,
        occurrenceCount: pattern.locations.length,
        existingLocations: pattern.locations.slice(0, 5).map(loc => ({
          file: loc.file,
          symbol: loc.symbol,
          line: loc.line,
        })),
        recommendation: pattern.recommendation ?? 'Review existing occurrences before adding another copy.',
      });
    }
  };

  for (const fn of sourceFile.getFunctions()) {
    checkNode(fn.getName() ?? '<anonymous>', fn.getBody());
  }
  for (const cls of sourceFile.getClasses()) {
    for (const method of cls.getMethods()) {
      checkNode(`${cls.getName() ?? '<anonymous>'}.${method.getName()}`, method.getBody());
    }
  }
  for (const arrow of sourceFile.getDescendants().filter(n => n.isKind(SyntaxKind.ArrowFunction))) {
    const body = arrow.getBody();
    if (!body) continue;
    if (body.getKind() !== SyntaxKind.Block && body.getText().length < 20) continue;
    const parent = arrow.getParent();
    let name = '<anonymous-arrow>';
    if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
      name = (parent as { getName?(): string }).getName?.() ?? name;
    }
    checkNode(name, body);
  }

  return flags;
}

// ── Naming pattern analysis ───────────────────────────────────────────────────

const COMMON_PREFIXES = [
  'get', 'set', 'build', 'load', 'fetch', 'create', 'make', 'find',
  'update', 'delete', 'remove', 'handle', 'parse', 'render', 'format',
  'validate', 'check', 'is', 'has', 'can', 'should',
];

function extractPrefix(name: string): string | null {
  for (const prefix of COMMON_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      const next = name[prefix.length];
      if (next && next === next.toUpperCase()) return prefix;
    }
  }
  return null;
}

function dominantPrefixIn(symbols: string[]): string | null {
  const counts = new Map<string, number>();
  for (const s of symbols) {
    const p = extractPrefix(s);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [[topPrefix, topCount]] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return topCount >= 2 ? topPrefix : null;
}

function hasSuffixPattern(symbols: string[], suffix: string): boolean {
  const count = symbols.filter(s => s.endsWith(suffix)).length;
  return symbols.length > 0 && count / symbols.length >= 0.5;
}

function checkNaming(
  generatedNames: string[],
  moduleSymbols: string[],
): NamingFlag[] {
  const flags: NamingFlag[] = [];

  const domPrefix = dominantPrefixIn(moduleSymbols);
  const domAsync  = hasSuffixPattern(moduleSymbols, 'Async');

  for (const name of generatedNames) {
    const genPrefix = extractPrefix(name);
    const genAsync  = name.endsWith('Async');

    // Flag if module strongly prefers Async suffix but generated name omits it.
    if (domAsync && !genAsync && !name.startsWith('I') && !/^[A-Z]/.test(name)) {
      flags.push({
        generatedSymbol: name,
        dominantPattern: 'Async suffix (≥50% of module symbols)',
        suggestion: `Consider renaming to \`${name}Async\` to match module conventions.`,
      });
    }

    // Flag if module has a strong prefix pattern and generated name uses a different one.
    if (domPrefix && genPrefix && genPrefix !== domPrefix) {
      flags.push({
        generatedSymbol: name,
        dominantPattern: `${domPrefix}* prefix pattern`,
        suggestion: `Module favours the \`${domPrefix}*\` prefix. Consider \`${domPrefix}${name[0].toUpperCase()}${name.slice(1)}\` if appropriate.`,
      });
    }
  }

  return flags;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function validateGeneratedCode(
  projectRoot: string,
  code: string,
  targetFile: string | undefined,
  qdrantUrl = 'http://localhost:6333',
): Promise<CodeValidationResult> {
  const root = path.resolve(projectRoot);
  const generatedSymbols = extractSymbolNames(code);
  const generatedImports = extractImports(code);
  const targetModule     = targetFile ? moduleFromFile(targetFile) : null;

  // Run all checks concurrently — graph loaded once, reused for constraint + naming.
  const [
    duplicateResults,
    architecture,
    violations,
    graph,
    duplicateSnapshot,
  ] = await Promise.all([
    // Check each extracted symbol for duplicates.
    Promise.all(
      generatedSymbols.slice(0, 8).map(async sym => {
        try {
          return await findExisting(root, sym, qdrantUrl, 3);
        } catch (error) {
          if (error instanceof MissingCodeIndexError) {
            return { matches: [], verdict: 'SAFE_TO_CREATE' as const };
          }
          throw error;
        }
      }),
    ),
    loadArchitectureAsync(root),
    listConstraintViolationsAsync(root, { limit: 50 }),
    loadGraphAsync(path.join(getDataDir(root), 'graph.json')),
    loadSemanticDuplicates(root),
  ]);

  // 1. Semantic duplicate flags (embedding-based).
  const duplicateFlags: DuplicateFlag[] = [];
  for (const [i, result] of duplicateResults.entries()) {
    for (const match of result.matches) {
      if (match.tier === 'LIKELY_DUPLICATE') {
        duplicateFlags.push({ generatedSymbol: generatedSymbols[i]!, existingMatch: match });
      }
    }
  }

  // 1b. Structural duplicate flags (AST-normalized shapes already in the codebase).
  const structuralDuplicateFlags = detectStructuralDuplicatesInCode(code, duplicateSnapshot);

  // 2. Constraint flags — check whether generated imports touch violated modules.
  const constraintFlags: ConstraintFlag[] = [];
  if (targetModule) {
    for (const imp of generatedImports) {
      const importedModule = imp.startsWith('.')
        ? moduleFromFile(path.join(path.dirname(targetFile ?? ''), imp))
        : imp.split('/')[0] ?? imp;

      for (const v of violations) {
        const involvesTarget   = v.modules.some(m => m.includes(targetModule));
        const involvesImported = v.modules.some(m => m.includes(importedModule));
        if (involvesTarget || involvesImported) {
          constraintFlags.push({
            importPath: imp,
            rule: v.rule,
            severity: v.severity,
            details: v.details,
          });
          break;
        }
      }
    }
  }

  // 3. Naming flags — compare generated names against all existing symbols in the target module.
  const namingFlags: NamingFlag[] = [];
  if (targetModule && graph) {
    // Collect every symbol that belongs to the target module from the call graph.
    const existingSymbols = Object.entries(graph.symbolFile)
      .filter(([, file]) => moduleFromFile(file) === targetModule)
      .map(([symbol]) => symbol);

    if (existingSymbols.length > 0) {
      namingFlags.push(...checkNaming(generatedSymbols, existingSymbols));
    }
  }

  // 4. Derive verdict.
  const hasBlocking = duplicateFlags.length > 0
    || structuralDuplicateFlags.length > 0
    || constraintFlags.some(f => f.severity === 'high');
  const hasWarnings = constraintFlags.length > 0
    || namingFlags.length > 0
    || structuralDuplicateFlags.some(f => f.occurrenceCount >= 3);
  const verdict: ValidationSeverity = hasBlocking ? 'BLOCK' : hasWarnings ? 'WARN' : 'PASS';

  // 5. Summary.
  const parts: string[] = [];
  if (duplicateFlags.length > 0) {
    parts.push(`${duplicateFlags.length} likely semantic duplicate(s): ${duplicateFlags.map(f => f.generatedSymbol).join(', ')}`);
  }
  if (structuralDuplicateFlags.length > 0) {
    parts.push(`${structuralDuplicateFlags.length} structural duplicate pattern(s): ${structuralDuplicateFlags.map(f => f.generatedSymbol).join(', ')}`);
  }
  if (constraintFlags.length > 0) {
    parts.push(`${constraintFlags.length} constraint warning(s)`);
  }
  if (namingFlags.length > 0) {
    parts.push(`${namingFlags.length} naming inconsistenc${namingFlags.length === 1 ? 'y' : 'ies'}`);
  }
  const summary = verdict === 'PASS'
    ? 'PASS — no issues detected. Code looks clean.'
    : `${verdict} — ${parts.join('; ')}.`;

  return { verdict, duplicateFlags, structuralDuplicateFlags, constraintFlags, namingFlags, summary };
}

export function renderCodeValidation(result: CodeValidationResult): string {
  const lines = [`## Code Validation — ${result.verdict}`, '', result.summary];

  if (result.duplicateFlags.length > 0) {
    lines.push('', '### Semantic Duplicate Flags (BLOCK)');
    for (const f of result.duplicateFlags) {
      lines.push(
        `- **${f.generatedSymbol}** → ${f.existingMatch.recommendation}`,
        `  Existing: \`${f.existingMatch.symbol}\` @ ${f.existingMatch.file} (similarity ${f.existingMatch.similarityScore.toFixed(2)}, ${f.existingMatch.usageCount} callers)`,
      );
    }
  }

  if (result.structuralDuplicateFlags.length > 0) {
    lines.push('', '### Structural Duplicate Flags');
    for (const f of result.structuralDuplicateFlags) {
      lines.push(
        `- **${f.generatedSymbol}** matches existing ${f.category} pattern (${f.occurrenceCount} occurrences)`,
        `  ${f.recommendation}`,
        `  Existing: ${f.existingLocations.map(loc => `${loc.symbol} @ ${loc.file}:${loc.line}`).join(', ')}`,
      );
    }
  }

  if (result.constraintFlags.length > 0) {
    lines.push('', '### Constraint Flags');
    for (const f of result.constraintFlags) {
      lines.push(`- [${f.severity}] \`${f.importPath}\` triggers \`${f.rule}\`: ${f.details}`);
    }
  }

  if (result.namingFlags.length > 0) {
    lines.push('', '### Naming Flags');
    for (const f of result.namingFlags) {
      lines.push(`- \`${f.generatedSymbol}\`: ${f.suggestion} (pattern: ${f.dominantPattern})`);
    }
  }

  return lines.join('\n');
}
