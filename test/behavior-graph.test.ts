import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Project } from 'ts-morph';
import { extractSideEffects, renderBehaviorChecklist } from '../src/behavior-graph.js';
import { buildGraphAsync } from '../src/graph.js';

function makeProject(t: TestContext, source: string): { project: Project; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-behavior-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'service.ts'), source);
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFileAtPath(path.join(dir, 'src', 'service.ts'));
  return { project, dir };
}

function findEffects(map: Map<string, ReturnType<typeof extractSideEffects> extends Map<string, infer V> ? V : never>, symbol: string) {
  return map.get(symbol) ?? [];
}

test('extractSideEffects detects db.write on repository save', t => {
  const source = [
    'class BookingService {',
    '  async create(bookingRepo: any, data: any) {',
    '    await bookingRepo.save(data);',
    '  }',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'BookingService.create');
  const writes = list.filter(e => e.kind === 'db.write');
  assert.ok(writes.length >= 1, 'expected at least one db.write');
  assert.equal(writes[0]!.target, 'Booking');
  assert.equal(writes[0]!.confidence, 1.0);
});

test('extractSideEffects detects http.out via axios', t => {
  const source = [
    'class NotifyService {',
    '  async send(http: any, payload: any) {',
    '    await http.post("/api/notify", payload);',
    '  }',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'NotifyService.send');
  const http = list.filter(e => e.kind === 'http.out');
  assert.ok(http.length >= 1, 'expected at least one http.out');
  assert.equal(http[0]!.target, '/api/notify');
});

test('extractSideEffects detects event.publish via EventEmitter.emit', t => {
  const source = [
    'class BookingService {',
    '  async onCreated(bus: any, evt: any) {',
    '    bus.emit("BookingCreated", evt);',
    '  }',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'BookingService.onCreated');
  const publish = list.filter(e => e.kind === 'event.publish');
  assert.ok(publish.length >= 1, 'expected at least one event.publish');
  assert.equal(publish[0]!.target, 'BookingCreated');
});

test('extractSideEffects detects event.subscribe via @OnEvent decorator', t => {
  const source = [
    'function OnEvent(_name: string): MethodDecorator { return () => {}; }',
    'class BookingListener {',
    '  @OnEvent("BookingCreated")',
    '  handle() {}',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'BookingListener.handle');
  const subs = list.filter(e => e.kind === 'event.subscribe');
  assert.ok(subs.length >= 1, 'expected at least one event.subscribe');
  assert.equal(subs[0]!.target, 'BookingCreated');
});

test('extractSideEffects caps confidence inside conditional', t => {
  const source = [
    'class Service {',
    '  async run(repo: any, flag: boolean) {',
    '    if (flag) {',
    '      await repo.save({});',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'Service.run');
  const writes = list.filter(e => e.kind === 'db.write');
  assert.ok(writes.length >= 1);
  assert.equal(writes[0]!.confidence, 0.85);
});

test('buildGraphAsync populates sideEffects', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-graph-behavior-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'booking.service.ts'),
    [
      'class BookingService {',
      '  async create(repo: any, mailer: any) {',
      '    await repo.save({});',
      '    await mailer.send({});',
      '  }',
      '}',
    ].join('\n')
  );
  const graph = await buildGraphAsync(dir);
  assert.ok(graph.sideEffects, 'graph.sideEffects should be defined');
  const effects = graph.sideEffects!['BookingService.create'] ?? [];
  assert.ok(effects.some(e => e.kind === 'db.write'));
  assert.ok(effects.some(e => e.kind === 'email.send'));
});

test('renderBehaviorChecklist deduplicates and sorts by confidence', t => {
  const source = [
    'class Svc {',
    '  async run(repo: any) {',
    '    await repo.save({});',
    '    if (true) {',
    '      await repo.save({});',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-render-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 's.ts'), source);
  const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  project.addSourceFileAtPath(path.join(tmp, 'src', 's.ts'));
  const effects = extractSideEffects(project.getSourceFiles()[0]!, tmp).get('Svc.run') ?? [];
  const rendered = renderBehaviorChecklist(effects);
  const writes = rendered.split('\n').filter(line => line.includes('Writes'));
  assert.equal(writes.length, 1, `expected one Writes line, got:\n${rendered}`);
  assert.ok(writes[0]!.includes('100%'), `expected highest confidence, got: ${writes[0]}`);
});

test('extractSideEffects includes calls inside inline transaction callback', t => {
  const source = [
    'class BookingService {',
    '  async create(dataSource: any, repo: any) {',
    '    return dataSource.transaction(async (manager: any) => {',
    '      await repo.save({});',
    '    });',
    '  }',
    '}',
  ].join('\n');
  const { project, dir } = makeProject(t, source);
  const effects = extractSideEffects(project.getSourceFiles()[0]!, dir);
  const list = findEffects(effects, 'BookingService.create');
  const writes = list.filter(e => e.kind === 'db.write');
  assert.ok(writes.length >= 1, `expected db.write inside transaction callback, got: ${JSON.stringify(list)}`);
});

function extractEffects(t: TestContext, source: string) {
  const { project, dir } = makeProject(t, source);
  return extractSideEffects(project.getSourceFiles()[0]!, dir);
}

// ===================== Fix 1: db.read / db.write noise rejection =====================

test('extractSideEffects noise: arr.find / lodash.find / [1,2,3].count are not db.read', t => {
  const source = [
    'class Svc {',
    '  async run(arr: number[], users: any[], lodash: any) {',
    '    arr.find(x => x > 0);',
    '    lodash.find(users, { active: true });',
    '    return [1, 2, 3].count();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'Svc.run').filter(e => e.kind === 'db.read');
  assert.equal(reads.length, 0, `expected 0 db.read, got: ${JSON.stringify(reads)}`);
});

test('extractSideEffects detects db.read via unambiguous repo method', t => {
  const source = [
    'class Svc {',
    '  async count(repo: any) {',
    '    return repo.count({ active: true });',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'Svc.count').filter(e => e.kind === 'db.read');
  assert.equal(reads.length, 1);
});

test('extractSideEffects detects db.write via firstStringArg entity name', t => {
  const source = [
    'class Svc {',
    '  async create(repo: any, data: any) {',
    '    await repo.save("Booking", data);',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'Svc.create').filter(e => e.kind === 'db.write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.target, 'Booking');
});

test('extractSideEffects noise: factory.create / manager.create / builder.persist are not db.write', t => {
  const source = [
    'class Svc {',
    '  async build(factory: any, manager: any, builder: any) {',
    '    factory.create({});',
    '    manager.create({});',
    '    builder.persist({});',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'Svc.build').filter(e => e.kind === 'db.write');
  assert.equal(writes.length, 0, `expected 0 db.write, got: ${JSON.stringify(writes)}`);
});

// ===================== Fix 3: per-kind coverage (positive + noise each) =====================

test('extractSideEffects detects db.delete', t => {
  const source = [
    'class Svc {',
    '  async remove(repo: any, id: any) {',
    '    await repo.delete(id);',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const deletes = findEffects(effects, 'Svc.remove').filter(e => e.kind === 'db.delete');
  assert.equal(deletes.length, 1);
});

test('extractSideEffects noise: arr.splice is not db.delete', t => {
  const source = [
    'class Svc {',
    '  async trim(arr: any[]) {',
    '    return arr.splice(0, 1);',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const deletes = findEffects(effects, 'Svc.trim').filter(e => e.kind === 'db.delete');
  assert.equal(deletes.length, 0);
});

test('extractSideEffects detects cache.read via cache.get', t => {
  const source = [
    'class Svc {',
    '  async load(cache: any) {',
    '    return cache.get("user:42");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'Svc.load').filter(e => e.kind === 'cache.read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.target, 'user:42');
});

test('extractSideEffects noise: user.get is not cache.read', t => {
  const source = [
    'class Svc {',
    '  async load(user: any) {',
    '    return user.get("name");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'Svc.load').filter(e => e.kind === 'cache.read');
  assert.equal(reads.length, 0);
});

test('extractSideEffects detects cache.write via cache.set', t => {
  const source = [
    'class Svc {',
    '  async store(cache: any) {',
    '    await cache.set("k", "v", 60);',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'Svc.store').filter(e => e.kind === 'cache.write');
  assert.equal(writes.length, 1);
});

test('extractSideEffects noise: arr.set is not cache.write', t => {
  const source = [
    'class Svc {',
    '  async reset(arr: any[]) {',
    '    arr.length = 0;',
    '    return arr;',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'Svc.reset').filter(e => e.kind === 'cache.write');
  assert.equal(writes.length, 0);
});

test('extractSideEffects detects cache.invalidate via cache.del', t => {
  const source = [
    'class Svc {',
    '  async clear(cache: any) {',
    '    await cache.del("k");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const invalidates = findEffects(effects, 'Svc.clear').filter(e => e.kind === 'cache.invalidate');
  assert.equal(invalidates.length, 1);
});

test('extractSideEffects noise: obj.del is not cache.invalidate', t => {
  const source = [
    'class Svc {',
    '  async drop(obj: any) {',
    '    return obj.del();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const invalidates = findEffects(effects, 'Svc.drop').filter(e => e.kind === 'cache.invalidate');
  assert.equal(invalidates.length, 0);
});

test('extractSideEffects detects queue.publish via queue.add', t => {
  const source = [
    'class Svc {',
    '  async enqueue(queue: any) {',
    '    await queue.add("booking:create", { id: 1 });',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const pubs = findEffects(effects, 'Svc.enqueue').filter(e => e.kind === 'queue.publish');
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0]!.target, 'booking:create');
});

test('extractSideEffects noise: arr.push is not queue.publish', t => {
  const source = [
    'class Svc {',
    '  async grow(arr: number[]) {',
    '    arr.push(1);',
    '    return arr.length;',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const pubs = findEffects(effects, 'Svc.grow').filter(e => e.kind === 'queue.publish');
  assert.equal(pubs.length, 0);
});

test('extractSideEffects detects fs.read via bare readFile', t => {
  const source = [
    'function loadConfig() {',
    '  return readFile("config.json");',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'loadConfig').filter(e => e.kind === 'fs.read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.target, 'config.json');
});

test('extractSideEffects noise: arr.pop is not fs.read', t => {
  const source = [
    'class Svc {',
    '  async drain(arr: any[]) {',
    '    return arr.pop();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const reads = findEffects(effects, 'Svc.drain').filter(e => e.kind === 'fs.read');
  assert.equal(reads.length, 0);
});

test('extractSideEffects detects fs.write via bare writeFile', t => {
  const source = [
    'function saveConfig(data: any) {',
    '  writeFile("config.json", data);',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'saveConfig').filter(e => e.kind === 'fs.write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.target, 'config.json');
});

test('extractSideEffects noise: arr.push is not fs.write', t => {
  const source = [
    'class Svc {',
    '  async grow(arr: any[]) {',
    '    arr.push({ x: 1 });',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'Svc.grow').filter(e => e.kind === 'fs.write');
  assert.equal(writes.length, 0);
});

test('extractSideEffects detects transaction.start via dataSource.transaction', t => {
  const source = [
    'class Svc {',
    '  async run(dataSource: any) {',
    '    return dataSource.transaction(async () => 1);',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'Svc.run').filter(e => e.kind === 'transaction.start');
  assert.equal(txns.length, 1);
});

test('extractSideEffects noise: bare transaction() is not transaction.start', t => {
  const source = [
    'function init() {',
    '  transaction("init");',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'init').filter(e => e.kind === 'transaction.start');
  assert.equal(txns.length, 0);
});

test('extractSideEffects detects transaction.commit via commitTransaction', t => {
  const source = [
    'class Svc {',
    '  async commit(dataSource: any) {',
    '    await dataSource.commitTransaction();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'Svc.commit').filter(e => e.kind === 'transaction.commit');
  assert.equal(txns.length, 1);
});

test('extractSideEffects noise: bare commitTransaction() is not transaction.commit', t => {
  const source = [
    'function finalize() {',
    '  commitTransaction();',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'finalize').filter(e => e.kind === 'transaction.commit');
  assert.equal(txns.length, 0);
});

test('extractSideEffects detects transaction.rollback', t => {
  const source = [
    'class Svc {',
    '  async rollback(dataSource: any) {',
    '    await dataSource.rollbackTransaction();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'Svc.rollback').filter(e => e.kind === 'transaction.rollback');
  assert.equal(txns.length, 1);
});

test('extractSideEffects noise: bare rollbackTransaction() is not transaction.rollback', t => {
  const source = [
    'function revert() {',
    '  rollbackTransaction();',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const txns = findEffects(effects, 'revert').filter(e => e.kind === 'transaction.rollback');
  assert.equal(txns.length, 0);
});

test('extractSideEffects detects lock.acquire on lock receiver', t => {
  const source = [
    'class Svc {',
    '  async run(lock: any) {',
    '    await lock.acquire();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const locks = findEffects(effects, 'Svc.run').filter(e => e.kind === 'lock.acquire');
  assert.equal(locks.length, 1);
});

test('extractSideEffects noise: worker.acquire is not lock.acquire', t => {
  const source = [
    'class Svc {',
    '  async run(worker: any) {',
    '    return worker.acquire();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const locks = findEffects(effects, 'Svc.run').filter(e => e.kind === 'lock.acquire');
  assert.equal(locks.length, 0);
});

test('extractSideEffects detects lock.release on lock receiver', t => {
  const source = [
    'class Svc {',
    '  async run(lock: any) {',
    '    await lock.release();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const locks = findEffects(effects, 'Svc.run').filter(e => e.kind === 'lock.release');
  assert.equal(locks.length, 1);
});

test('extractSideEffects noise: worker.release is not lock.release', t => {
  const source = [
    'class Svc {',
    '  async run(worker: any) {',
    '    return worker.release();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const locks = findEffects(effects, 'Svc.run').filter(e => e.kind === 'lock.release');
  assert.equal(locks.length, 0);
});

test('extractSideEffects detects log.write on logger receiver', t => {
  const source = [
    'class Svc {',
    '  async run(logger: any) {',
    '    logger.info("hello");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const logs = findEffects(effects, 'Svc.run').filter(e => e.kind === 'log.write');
  assert.equal(logs.length, 1);
});

test('extractSideEffects noise: result.info is not log.write', t => {
  const source = [
    'class Svc {',
    '  async run(result: any) {',
    '    return result.info("x");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const logs = findEffects(effects, 'Svc.run').filter(e => e.kind === 'log.write');
  assert.equal(logs.length, 0);
});

test('extractSideEffects detects metric.record on metrics receiver', t => {
  const source = [
    'class Svc {',
    '  async run(metrics: any) {',
    '    metrics.increment("bookings.created");',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const m = findEffects(effects, 'Svc.run').filter(e => e.kind === 'metric.record');
  assert.equal(m.length, 1);
  assert.equal(m[0]!.target, 'bookings.created');
});

test('extractSideEffects noise: obj.increment is not metric.record', t => {
  const source = [
    'class Svc {',
    '  async run(obj: any) {',
    '    return obj.increment();',
    '  }',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const m = findEffects(effects, 'Svc.run').filter(e => e.kind === 'metric.record');
  assert.equal(m.length, 0);
});

// ===================== Fix 2: http.in via @Get/@Post decorators =====================

test('extractSideEffects detects http.in via @Get and @Post decorators', t => {
  const source = [
    'function Get(_path: string): MethodDecorator { return () => {}; }',
    'function Post(_path: string): MethodDecorator { return () => {}; }',
    'class BookingController {',
    '  @Get("/booking/:id")',
    '  getOne() {}',
    '  @Post("/booking")',
    '  create() {}',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const getIn = findEffects(effects, 'BookingController.getOne').filter(e => e.kind === 'http.in');
  const postIn = findEffects(effects, 'BookingController.create').filter(e => e.kind === 'http.in');
  assert.equal(getIn.length, 1);
  assert.equal(getIn[0]!.target, '/booking/:id');
  assert.equal(postIn.length, 1);
  assert.equal(postIn[0]!.target, '/booking');
});

test('extractSideEffects noise: plain method (no HTTP decorator) is not http.in', t => {
  const source = [
    'class BookingController {',
    '  helper() {}',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const ins = findEffects(effects, 'BookingController.helper').filter(e => e.kind === 'http.in');
  assert.equal(ins.length, 0);
});

// ===================== Fix 2: queue.consume via @Processor/@Subscribe decorators =====================

test('extractSideEffects detects queue.consume via @Processor decorator', t => {
  const source = [
    'function Processor(_name: string): MethodDecorator { return () => {}; }',
    'class BookingWorker {',
    '  @Processor("booking-queue")',
    '  handle() {}',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const consumes = findEffects(effects, 'BookingWorker.handle').filter(e => e.kind === 'queue.consume');
  assert.equal(consumes.length, 1);
  assert.equal(consumes[0]!.target, 'booking-queue');
});

test('extractSideEffects noise: plain method (no queue decorator) is not queue.consume', t => {
  const source = [
    'class Worker {',
    '  run() {}',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const consumes = findEffects(effects, 'Worker.run').filter(e => e.kind === 'queue.consume');
  assert.equal(consumes.length, 0);
});

// ===================== Fix 4: setTimeout / setInterval / queueMicrotask inline callbacks =====================

test('extractSideEffects treats setTimeout arrow as inline callback (Fix 4)', t => {
  const source = [
    'function poll() {',
    '  setTimeout(() => {',
    '    repo.save("Booking", { id: 1 });',
    '  }, 1000);',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'poll').filter(e => e.kind === 'db.write');
  assert.equal(writes.length, 1, `expected 1 db.write attributed to poll, got: ${JSON.stringify(findEffects(effects, 'poll'))}`);
});

test('extractSideEffects treats setInterval arrow as inline callback (Fix 4)', t => {
  const source = [
    'function heartbeat() {',
    '  setInterval(() => {',
    '    metrics.increment("heartbeat.tick");',
    '  }, 5000);',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const m = findEffects(effects, 'heartbeat').filter(e => e.kind === 'metric.record');
  assert.equal(m.length, 1, `expected 1 metric.record attributed to heartbeat, got: ${JSON.stringify(findEffects(effects, 'heartbeat'))}`);
});

test('extractSideEffects treats queueMicrotask arrow as inline callback (Fix 4)', t => {
  const source = [
    'function defer() {',
    '  queueMicrotask(() => {',
    '    cache.set("k", "v");',
    '  });',
    '}',
  ].join('\n');
  const effects = extractEffects(t, source);
  const writes = findEffects(effects, 'defer').filter(e => e.kind === 'cache.write');
  assert.equal(writes.length, 1, `expected 1 cache.write attributed to defer, got: ${JSON.stringify(findEffects(effects, 'defer'))}`);
});

// ===================== Fix 5: deriveTargetFromReceiver cosmetic =====================

test('deriveTargetFromReceiver wraps degenerate receivers in angle brackets (Fix 5)', t => {
  // Case A: repo.save(b) → target <repo> (no entity suffix to strip)
  const srcA = [
    'class A {',
    '  async run(repo: any, b: any) {',
    '    repo.save(b);',
    '  }',
    '}',
  ].join('\n');
  const writesA = findEffects(extractEffects(t, srcA), 'A.run').filter(e => e.kind === 'db.write');
  assert.equal(writesA.length, 1);
  assert.equal(writesA[0]!.target, '<repo>');

  // Case B: bookingRepo.save(b) → target Booking (rich receiver stripped)
  const srcB = [
    'class B {',
    '  async run(bookingRepo: any, b: any) {',
    '    bookingRepo.save(b);',
    '  }',
    '}',
  ].join('\n');
  const writesB = findEffects(extractEffects(t, srcB), 'B.run').filter(e => e.kind === 'db.write');
  assert.equal(writesB.length, 1);
  assert.equal(writesB[0]!.target, 'Booking');

  // Case C: manager.save(b) → target <manager> (known degenerate)
  const srcC = [
    'class C {',
    '  async run(manager: any, b: any) {',
    '    manager.save(b);',
    '  }',
    '}',
  ].join('\n');
  const writesC = findEffects(extractEffects(t, srcC), 'C.run').filter(e => e.kind === 'db.write');
  assert.equal(writesC.length, 1);
  assert.equal(writesC[0]!.target, '<manager>');
});