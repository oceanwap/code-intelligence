import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildGraphAsync } from '../src/graph.js';

function makeTempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-graph-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('buildGraph tracks TypeScript implementations and method overrides', async t => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'workers.ts'),
    [
      'interface Worker {',
      '  run(): void;',
      '}',
      '',
      'interface AdvancedWorker extends Worker {',
      '  run(): void;',
      '}',
      '',
      'class BaseWorker {',
      '  run() {',
      '    helper();',
      '  }',
      '}',
      '',
      'class ConcreteWorker extends BaseWorker implements AdvancedWorker {',
      '  run() {',
      '    helper();',
      '  }',
      '}',
      '',
      'function helper() {',
      '  return;',
      '}',
      '',
    ].join('\n')
  );

  const graph = await buildGraphAsync(dir);

  assert.deepEqual(graph.supertypes['AdvancedWorker'], ['Worker']);
  assert.deepEqual(new Set(graph.supertypes['ConcreteWorker']), new Set(['BaseWorker', 'AdvancedWorker']));
  assert.deepEqual(new Set(graph.subtypes['Worker']), new Set(['AdvancedWorker']));
  assert.deepEqual(new Set(graph.implementations['Worker']), new Set(['AdvancedWorker', 'ConcreteWorker']));
  assert.deepEqual(new Set(graph.implementations['Worker.run']), new Set(['AdvancedWorker.run', 'ConcreteWorker.run']));
  assert.deepEqual(new Set(graph.implementations['BaseWorker.run']), new Set(['ConcreteWorker.run']));
  assert.deepEqual(new Set(graph.implementedFrom['ConcreteWorker.run']), new Set(['Worker.run', 'AdvancedWorker.run', 'BaseWorker.run']));
  assert.ok(graph.callers['helper']?.includes('BaseWorker.run'));
  assert.ok(graph.callers['helper']?.includes('ConcreteWorker.run'));
  assert.ok(graph.callSites?.['BaseWorker.run']?.some(site => site.symbol === 'helper' && site.line === 11));
  assert.ok(graph.calledBySites?.['helper']?.some(site => site.symbol === 'ConcreteWorker.run' && site.line === 17));
});

test('buildGraph tracks PHP implementations and method overrides', async t => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'runner.php'),
    [
      '<?php',
      '',
      'namespace App;',
      '',
      'interface Runner {',
      '    public function run();',
      '}',
      '',
      'interface AdvancedRunner extends Runner {',
      '    public function run();',
      '}',
      '',
      'class BaseRunner {',
      '    public function run() {',
      '        return helper();',
      '    }',
      '}',
      '',
      'class ConcreteRunner extends BaseRunner implements AdvancedRunner {',
      '    public function run() {',
      '        return helper();',
      '    }',
      '}',
      '',
      'function helper() {',
      '    return true;',
      '}',
      '',
    ].join('\n')
  );

  const graph = await buildGraphAsync(dir);

  assert.deepEqual(new Set(graph.supertypes['App\\ConcreteRunner']), new Set(['App\\BaseRunner', 'App\\AdvancedRunner']));
  assert.deepEqual(new Set(graph.implementations['App\\Runner']), new Set(['App\\AdvancedRunner', 'App\\ConcreteRunner']));
  assert.deepEqual(new Set(graph.implementations['App\\Runner::run']), new Set(['App\\AdvancedRunner::run', 'App\\ConcreteRunner::run']));
  assert.deepEqual(new Set(graph.implementations['App\\BaseRunner::run']), new Set(['App\\ConcreteRunner::run']));
  assert.deepEqual(new Set(graph.implementedFrom['App\\ConcreteRunner::run']), new Set(['App\\Runner::run', 'App\\AdvancedRunner::run', 'App\\BaseRunner::run']));
  assert.ok(graph.callers['helper']?.includes('App\\BaseRunner::run'));
  assert.ok(graph.callers['helper']?.includes('App\\ConcreteRunner::run'));
  assert.ok(graph.callSites?.['App\\BaseRunner::run']?.some(site => site.symbol === 'helper' && site.line === 15));
  assert.ok(graph.calledBySites?.['helper']?.some(site => site.symbol === 'App\\ConcreteRunner::run' && site.line === 21));
});

test('buildGraph detects TypeORM entity relation decorators', async t => {
  const dir = makeTempDir(t);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'entities.ts'),
    [
      "import { Entity, ManyToOne, OneToMany, ManyToMany } from 'typeorm';",
      '',
      '@Entity()',
      'class Contact {',
      '  @ManyToOne(() => Lead)',
      '  lead: Lead;',
      '',
      '  @OneToMany(() => Account, account => account.contact)',
      '  accounts: Account[];',
      '}',
      '',
      '@Entity()',
      'class Lead {',
      '  @OneToMany(() => Contact, contact => contact.lead)',
      '  contacts: Contact[];',
      '}',
      '',
      '@Entity()',
      'class Account {',
      '  @ManyToOne("Contact")',
      '  contact: Contact;',
      '',
      '  @ManyToMany(() => Tag, tag => tag.accounts)',
      '  tags: Tag[];',
      '}',
      '',
      '@Entity()',
      'class Tag {',
      '  @ManyToMany(() => Account, account => account.tags)',
      '  accounts: Account[];',
      '}',
      '',
    ].join('\n')
  );

  const graph = await buildGraphAsync(dir);

  assert.ok(graph.symbols['Contact']?.includes('Lead'));
  assert.ok(graph.symbols['Contact']?.includes('Account'));
  assert.ok(graph.symbols['Lead']?.includes('Contact'));
  assert.ok(graph.symbols['Account']?.includes('Contact'));
  assert.ok(graph.symbols['Account']?.includes('Tag'));
  assert.ok(graph.symbols['Tag']?.includes('Account'));

  assert.ok(graph.callers['Lead']?.includes('Contact'));
  assert.ok(graph.callers['Account']?.includes('Contact'));
  assert.ok(graph.callers['Contact']?.includes('Lead'));
  assert.ok(graph.callers['Tag']?.includes('Account'));

  assert.deepEqual(graph.entityRelations?.['Account'], ['Contact', 'Tag']);
});