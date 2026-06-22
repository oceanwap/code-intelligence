import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeArchitecture, findDependencyPath } from '../src/cognition/architecture/analyzer.js';
import type { GraphData } from '../src/graph.js';

function makeGraph(): GraphData {
  return {
    symbols: {
      'AdminService.run': ['SharedUtil.format'],
      'SharedUtil.format': [],
      'UiComponent.render': ['SharedUtil.format'],
    },
    callers: {
      'SharedUtil.format': ['AdminService.run', 'UiComponent.render'],
    },
    files: {
      'packages/admin/src/services/admin.service.ts': ['@travelerwe/shared'],
      'packages/shared/src/util.ts': [],
      'packages/admin-ui/src/components/UiComponent.tsx': ['@travelerwe/shared'],
    },
    symbolFile: {
      AdminService: 'packages/admin/src/services/admin.service.ts',
      'AdminService.run': 'packages/admin/src/services/admin.service.ts',
      SharedUtil: 'packages/shared/src/util.ts',
      'SharedUtil.format': 'packages/shared/src/util.ts',
      UiComponent: 'packages/admin-ui/src/components/UiComponent.tsx',
      'UiComponent.render': 'packages/admin-ui/src/components/UiComponent.tsx',
    },
    supertypes: {},
    subtypes: {},
    implementations: {},
    implementedFrom: {},
    resolvedImports: {
      'packages/admin/src/services/admin.service.ts': ['packages/shared/src/util.ts'],
      'packages/admin-ui/src/components/UiComponent.tsx': ['packages/shared/src/util.ts'],
    },
  } as GraphData;
}

test('analyzeArchitecture creates per-package zones', () => {
  const snapshot = analyzeArchitecture(makeGraph());
  const zones = new Map(snapshot.zones.map(zone => [zone.name, zone.modules]));

  assert.ok(zones.has('packages/admin'), 'expected packages/admin zone');
  assert.ok(zones.has('packages/admin-ui'), 'expected packages/admin-ui zone');
  assert.ok(zones.has('packages/shared'), 'expected packages/shared zone');

  assert.ok(zones.get('packages/admin')?.some(module => module.includes('packages/admin')));
  assert.ok(zones.get('packages/admin-ui')?.some(module => module.includes('packages/admin-ui')));
  assert.ok(zones.get('packages/shared')?.some(module => module.includes('packages/shared')));

  // No monolithic application zone should swallow packages.
  assert.ok(!zones.has('application'), 'application zone should not exist for monorepo packages');
});

test('findDependencyPath traverses resolved workspace imports', () => {
  const snapshot = analyzeArchitecture(makeGraph());
  const adminModule = snapshot.modules.find(module => module.name.startsWith('packages/admin/src'))!;
  const sharedModule = snapshot.modules.find(module => module.name.startsWith('packages/shared/src'))!;

  const path = findDependencyPath(snapshot, adminModule.name, sharedModule.name);
  assert.ok(path);
  assert.equal(path?.to, sharedModule.name);
  assert.ok(path?.path.length >= 2);
});
