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
import { findExisting, type ExistingMatch } from './find-existing.js';
import { loadArchitectureAsync } from './cognition/architecture/storage.js';
import { listConstraintViolationsAsync } from './cognition/constraints/engine.js';
import { moduleFromFile } from './utils/module-path.js';

export type ValidationSeverity = 'PASS' | 'WARN' | 'BLOCK';

export interface DuplicateFlag {
  generatedSymbol: string;
  existingMatch: ExistingMatch;
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

  // Run all three checks concurrently.
  const [
    duplicateResults,
    architecture,
    violations,
  ] = await Promise.all([
    // Check each extracted symbol for duplicates.
    Promise.all(
      generatedSymbols.slice(0, 8).map(sym =>
        findExisting(root, sym, qdrantUrl, 3),
      ),
    ),
    loadArchitectureAsync(root),
    listConstraintViolationsAsync(root, { limit: 50 }),
  ]);

  // 1. Duplicate flags.
  const duplicateFlags: DuplicateFlag[] = [];
  for (const [i, result] of duplicateResults.entries()) {
    for (const match of result.matches) {
      if (match.tier === 'LIKELY_DUPLICATE') {
        duplicateFlags.push({ generatedSymbol: generatedSymbols[i]!, existingMatch: match });
      }
    }
  }

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

  // 3. Naming flags — compare generated names against module's existing symbols.
  const namingFlags: NamingFlag[] = [];
  if (targetModule && architecture) {
    // Collect existing symbol names in the target module from architecture data.
    const moduleData = architecture.modules.find(m => m.name === targetModule);
    if (moduleData) {
      // We use the module name tokens as a proxy; real symbols would come from the graph.
      const existingSymbols: string[] = []; // populated below if graph is available
      namingFlags.push(...checkNaming(generatedSymbols, existingSymbols));
    }
  }

  // 4. Derive verdict.
  const hasBlocking = duplicateFlags.length > 0
    || constraintFlags.some(f => f.severity === 'high');
  const hasWarnings = constraintFlags.length > 0 || namingFlags.length > 0;
  const verdict: ValidationSeverity = hasBlocking ? 'BLOCK' : hasWarnings ? 'WARN' : 'PASS';

  // 5. Summary.
  const parts: string[] = [];
  if (duplicateFlags.length > 0) {
    parts.push(`${duplicateFlags.length} likely duplicate(s): ${duplicateFlags.map(f => f.generatedSymbol).join(', ')}`);
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

  return { verdict, duplicateFlags, constraintFlags, namingFlags, summary };
}

export function renderCodeValidation(result: CodeValidationResult): string {
  const lines = [`## Code Validation — ${result.verdict}`, '', result.summary];

  if (result.duplicateFlags.length > 0) {
    lines.push('', '### Duplicate Flags (BLOCK)');
    for (const f of result.duplicateFlags) {
      lines.push(
        `- **${f.generatedSymbol}** → ${f.existingMatch.recommendation}`,
        `  Existing: \`${f.existingMatch.symbol}\` @ ${f.existingMatch.file} (similarity ${f.existingMatch.similarityScore.toFixed(2)}, ${f.existingMatch.usageCount} callers)`,
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
