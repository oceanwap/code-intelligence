import {
  SyntaxKind,
  Node,
  type SourceFile,
  type CallExpression,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
  type MethodDeclaration,
  type PropertyAccessExpression,
  type StringLiteral,
  type NoSubstitutionTemplateLiteral,
  type Decorator,
} from 'ts-morph';
import * as path from 'node:path';

export type SideEffectKind =
  | 'db.read'
  | 'db.write'
  | 'db.delete'
  | 'http.out'
  | 'http.in'
  | 'cache.read'
  | 'cache.write'
  | 'cache.invalidate'
  | 'queue.publish'
  | 'queue.consume'
  | 'event.publish'
  | 'event.subscribe'
  | 'fs.read'
  | 'fs.write'
  | 'email.send'
  | 'transaction.start'
  | 'transaction.commit'
  | 'transaction.rollback'
  | 'lock.acquire'
  | 'lock.release'
  | 'log.write'
  | 'metric.record';

export interface SideEffect {
  kind: SideEffectKind;
  target: string;
  callSite: { file: string; line: number };
  confidence: number;
  evidence: string;
}

type FnLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;

interface KindMatcher {
  kind: SideEffectKind;
  methods: Set<string>;
  /** Suffix patterns matched case-insensitively against the receiver variable text. */
  receiverPatterns?: string[];
  /** Allow bare calls (no receiver) like `readFile('x')`. */
  matchBare?: boolean;
  /** Require a literal-string first argument (entity name, queue name, etc). */
  requireFirstStringArg?: boolean;
  /** Require the receiver to match `receiverPatterns`. Disambiguates noisy method names. */
  requireReceiverMatch?: boolean;
}

/** Short tokens are too ambiguous to suffix-match reliably (e.g. `em` matches `system`). */
const SHORT_TOKEN_PATTERNS = new Set(['em']);

function receiverMatches(receiver: string, patterns: string[]): boolean {
  const lower = receiver.toLowerCase();
  return patterns.some(p => {
    const pLower = p.toLowerCase();
    if (lower === pLower) return true;
    if (SHORT_TOKEN_PATTERNS.has(pLower)) return false;
    return lower.endsWith(pLower);
  });
}

const MATCHERS: KindMatcher[] = [
  {
    kind: 'db.delete',
    methods: new Set(['delete', 'remove', 'softDelete', 'softRemove', 'destroy']),
  },
  {
    kind: 'db.write',
    methods: new Set(['save', 'insert', 'update', 'delete', 'softDelete', 'remove', 'persist', 'flush']),
    receiverPatterns: ['repo', 'repository', 'entityManager', 'manager', 'em', 'dataSource', 'queryBuilder'],
    requireFirstStringArg: true,
    requireReceiverMatch: true,
  },

  {
    kind: 'db.read',
    methods: new Set(['getMany', 'getOne', 'getRawMany', 'getRawOne', 'findAndCount', 'findByIds', 'count', 'exists']),
    receiverPatterns: ['repo', 'repository', 'entityManager', 'manager', 'em', 'queryBuilder', 'dataSource'],
    requireReceiverMatch: true,
  },

  { kind: 'transaction.start', methods: new Set(['transaction', 'startTransaction']) },
  { kind: 'transaction.commit', methods: new Set(['commitTransaction']) },
  { kind: 'transaction.rollback', methods: new Set(['rollbackTransaction']) },

  { kind: 'fs.read', methods: new Set(['readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'exists', 'existsSync']), matchBare: true },
  { kind: 'fs.write', methods: new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'unlink', 'unlinkSync', 'rm', 'rmSync']), matchBare: true },

  {
    kind: 'lock.acquire',
    methods: new Set(['acquire']),
    receiverPatterns: ['lock', 'mutex', 'redlock'],
  },
  {
    kind: 'lock.release',
    methods: new Set(['release']),
    receiverPatterns: ['lock', 'mutex', 'redlock'],
  },

  {
    kind: 'cache.write',
    methods: new Set(['set', 'mset', 'setex']),
    receiverPatterns: ['cache', 'cacheManager', 'redis', 'redisClient'],
  },
  {
    kind: 'cache.read',
    methods: new Set(['get', 'mget', 'exists']),
    receiverPatterns: ['cache', 'cacheManager', 'redis', 'redisClient'],
  },
  {
    kind: 'cache.invalidate',
    methods: new Set(['del', 'delete', 'clear', 'invalidate', 'invalidateByPattern', 'reset']),
    receiverPatterns: ['cache', 'cacheManager', 'redis', 'redisClient'],
  },

  {
    kind: 'queue.publish',
    methods: new Set(['add', 'send', 'publish', 'enqueue']),
    receiverPatterns: ['queue', 'bullQueue', 'producer', 'publisher', 'bus'],
  },

  {
    kind: 'http.out',
    methods: new Set(['get', 'post', 'put', 'patch', 'delete', 'request', 'head']),
    receiverPatterns: ['httpClient', 'axios', 'got', 'http', 'httpService', 'api'],
  },
  { kind: 'http.out', methods: new Set(['fetch', 'got']), matchBare: true },

  {
    kind: 'email.send',
    methods: new Set(['send', 'sendMail']),
    receiverPatterns: ['mailer', 'transporter', 'mail', 'emailService', 'nodemailer'],
  },

  {
    kind: 'log.write',
    methods: new Set(['info', 'warn', 'error', 'debug', 'trace', 'fatal', 'verbose', 'log']),
    receiverPatterns: ['logger', 'console', 'winston', 'pino', 'bunyan'],
  },

  {
    kind: 'metric.record',
    methods: new Set(['record', 'increment', 'inc', 'decrement', 'dec', 'gauge', 'histogram', 'observe']),
    receiverPatterns: ['metrics', 'metricsClient', 'metric', 'counter', 'meter', 'gauge', 'histogram', 'statsd'],
  },

  {
    kind: 'event.publish',
    methods: new Set(['emit', 'publish', 'dispatch']),
    receiverPatterns: ['eventEmitter', 'bus', 'emitter', 'events', 'subject', 'mediator'],
  },
];

const CONDITIONAL_SYNTAX_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
]);

const INLINE_CALLBACK_METHODS = new Set([
  'transaction', 'then', 'catch', 'finally',
  'map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every',
  'subscribe', 'tap',
  'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'setImmediate',
]);

const HTTP_IN_DECORATORS = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'All',
]);

const QUEUE_CONSUME_DECORATORS = new Set([
  'Processor', 'OnQueueActive', 'OnQueueCompleted', 'OnQueueFailed', 'Subscribe',
  'OnMessage',
]);

const EVIDENCE_MAX = 80;

function isInlineCallback(fn: FnLike): boolean {
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return false;
  const parent = fn.getParent();
  if (!parent || !Node.isCallExpression(parent)) return false;
  const callee = parent.getExpression();
  if (Node.isPropertyAccessExpression(callee)) return INLINE_CALLBACK_METHODS.has(callee.getName());
  // Bare global calls like setTimeout(...), setInterval(...), queueMicrotask(...)
  return INLINE_CALLBACK_METHODS.has(callee.getText());
}

function isInsideNestedFunction(call: CallExpression, rootFn: FnLike): boolean {
  let cur: Node | undefined = call.getParent();
  while (cur && cur !== rootFn) {
    if (
      Node.isFunctionDeclaration(cur) ||
      Node.isFunctionExpression(cur) ||
      Node.isArrowFunction(cur) ||
      Node.isMethodDeclaration(cur)
    ) {
      if (isInlineCallback(cur as FnLike)) return false;
      return true;
    }
    cur = cur.getParent();
  }
  return false;
}

function computeConfidence(call: CallExpression): number {
  let cur: Node | undefined = call.getParent();
  let sawConditional = false;
  let sawTry = false;
  while (cur) {
    const kind = cur.getKind();
    if (kind === SyntaxKind.TryStatement) {
      sawTry = true;
      break;
    }
    if (CONDITIONAL_SYNTAX_KINDS.has(kind)) sawConditional = true;
    cur = cur.getParent();
  }
  if (sawTry) return 0.9;
  if (sawConditional) return 0.85;
  return 1.0;
}

function getFirstStringArg(call: CallExpression): string | null {
  for (const arg of call.getArguments()) {
    const k = arg.getKind();
    if (k === SyntaxKind.StringLiteral) return (arg as StringLiteral).getLiteralValue();
    if (k === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return (arg as NoSubstitutionTemplateLiteral).getLiteralValue();
    }
  }
  return null;
}

function deriveReceiverName(call: CallExpression): string | null {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getExpression().getText();
  return null;
}

const DEGENERATE_RECEIVERS = /^(manager|entityManager|em|queryRunner|repo|repository)$/i;

function deriveTargetFromReceiver(receiver: string): string {
  const stripped = receiver
    .replace(/^this\./, '')
    .replace(/^_+/, '')
    .replace(/(Repository|Repo)$/i, '');
  if (
    !stripped
    || stripped.length < 2
    || stripped === receiver
    || DEGENERATE_RECEIVERS.test(receiver)
  ) {
    return `<${receiver}>`;
  }
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function truncateEvidence(text: string): string {
  if (text.length <= EVIDENCE_MAX) return text;
  return text.slice(0, EVIDENCE_MAX - 1) + '…';
}

function isAmbiguousMethod(methodName: string): boolean {
  let count = 0;
  for (const matcher of MATCHERS) {
    if (matcher.methods.has(methodName) && matcher.receiverPatterns) count += 1;
  }
  return count > 1;
}

function matchCall(call: CallExpression, relPath: string): SideEffect | null {
  const expr = call.getExpression();
  const isBareCall = !Node.isPropertyAccessExpression(expr);
  const methodName = isBareCall ? expr.getText() : (expr as PropertyAccessExpression).getName();
  const receiverName = deriveReceiverName(call);
  const firstStringArg = getFirstStringArg(call);

  for (const matcher of MATCHERS) {
    if (!matcher.methods.has(methodName)) continue;

    const hasReceiverMatch = Boolean(
      receiverName
      && matcher.receiverPatterns
      && matcher.receiverPatterns.length > 0
      && receiverMatches(receiverName, matcher.receiverPatterns)
    );

    // Strict gates: at least one required signal must be present.
    if (matcher.requireFirstStringArg && !firstStringArg && !hasReceiverMatch) continue;
    if (matcher.requireReceiverMatch && !hasReceiverMatch && !firstStringArg) continue;

    // Legacy gates for matchers that don't use strict flags.
    if (!matcher.requireFirstStringArg && !matcher.requireReceiverMatch) {
      if (matcher.receiverPatterns && matcher.receiverPatterns.length > 0) {
        if (isBareCall || !receiverName) continue;
        if (!hasReceiverMatch) continue;
      } else if (isBareCall) {
        if (!matcher.matchBare) continue;
      }
    }

    let target: string;
    if (firstStringArg) {
      target = firstStringArg;
    } else if (receiverName) {
      target = deriveTargetFromReceiver(receiverName);
    } else {
      target = `<dynamic:${methodName}>`;
    }

    let confidence = computeConfidence(call);
    if (!isBareCall && matcher.receiverPatterns && isAmbiguousMethod(methodName)) {
      confidence = Math.min(confidence, 0.7);
    }

    return {
      kind: matcher.kind,
      target,
      callSite: { file: relPath, line: call.getStartLineNumber() },
      confidence,
      evidence: truncateEvidence(call.getText()),
    };
  }

  return null;
}

function getFnName(node: FnLike): string | null {
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? null;
  if (Node.isMethodDeclaration(node)) {
    const cls = node.getParentIfKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName() ?? '<class>';
    return `${clsName}.${node.getName()}`;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyDeclaration(parent)) {
      const cls = parent.getParentIfKind(SyntaxKind.ClassDeclaration);
      if (cls) return `${cls.getName() ?? '<class>'}.${parent.getName()}`;
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) return parent.getName();
  }
  return null;
}

function extractDecoratorStringArg(decorator: Decorator): string | null {
  const arg = decorator.getArguments()[0];
  if (!arg) return null;
  const k = arg.getKind();
  if (k === SyntaxKind.StringLiteral) return (arg as StringLiteral).getLiteralValue();
  if (k === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (arg as NoSubstitutionTemplateLiteral).getLiteralValue();
  }
  return null;
}

const KIND_LABEL: Record<SideEffectKind, string> = {
  'db.read': 'Reads',
  'db.write': 'Writes',
  'db.delete': 'Deletes',
  'http.out': 'HTTP out',
  'http.in': 'HTTP in',
  'cache.read': 'Cache read',
  'cache.write': 'Cache write',
  'cache.invalidate': 'Invalidates cache',
  'queue.publish': 'Publishes to queue',
  'queue.consume': 'Consumes queue',
  'event.publish': 'Publishes event',
  'event.subscribe': 'Subscribes to event',
  'fs.read': 'Reads file',
  'fs.write': 'Writes file',
  'email.send': 'Sends email',
  'transaction.start': 'Starts transaction',
  'transaction.commit': 'Commits transaction',
  'transaction.rollback': 'Rolls back transaction',
  'lock.acquire': 'Acquires lock',
  'lock.release': 'Releases lock',
  'log.write': 'Logs',
  'metric.record': 'Records metric',
};

export function renderBehaviorChecklist(effects: SideEffect[]): string {
  if (effects.length === 0) return '(no side effects detected)';
  const best = new Map<string, SideEffect>();
  for (const e of effects) {
    const key = `${e.kind}::${e.target}`;
    const existing = best.get(key);
    if (!existing || e.confidence > existing.confidence) best.set(key, e);
  }
  const sorted = [...best.values()].sort((a, b) => b.confidence - a.confidence || a.kind.localeCompare(b.kind));
  return sorted.map(e => `✓ ${KIND_LABEL[e.kind]} ${e.target}  ${Math.round(e.confidence * 100)}%`).join('\n');
}

export function extractSideEffects(sourceFile: SourceFile, projectRoot: string): Map<string, SideEffect[]> {
  const results = new Map<string, SideEffect[]>();
  const relPath = path.relative(projectRoot, sourceFile.getFilePath()).replace(/\\/g, '/');

  const fnNodes: FnLike[] = [
    ...sourceFile.getFunctions(),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ...sourceFile.getClasses().flatMap(cls => cls.getMethods()),
  ];

  for (const fn of fnNodes) {
    const name = getFnName(fn);
    if (!name) continue;

    if (Node.isMethodDeclaration(fn)) {
      for (const dec of fn.getDecorators()) {
        const decName = dec.getName();
        let effectKind: SideEffectKind | null = null;
        if (decName === 'OnEvent') effectKind = 'event.subscribe';
        else if (HTTP_IN_DECORATORS.has(decName)) effectKind = 'http.in';
        else if (QUEUE_CONSUME_DECORATORS.has(decName)) effectKind = 'queue.consume';
        if (!effectKind) continue;

        const arg = extractDecoratorStringArg(dec);
        const target = arg ?? `<dynamic:${decName}>`;
        const list = results.get(name) ?? [];
        list.push({
          kind: effectKind,
          target,
          callSite: { file: relPath, line: fn.getStartLineNumber() },
          confidence: 1.0,
          evidence: arg ? `@${decName}('${target}')` : `@${decName}`,
        });
        results.set(name, list);
      }
    }

    const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      if (isInsideNestedFunction(call, fn)) continue;
      const effect = matchCall(call, relPath);
      if (!effect) continue;
      const list = results.get(name) ?? [];
      list.push(effect);
      results.set(name, list);
    }
  }

  return results;
}