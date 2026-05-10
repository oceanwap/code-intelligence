import * as path from 'path';

export interface CognitionConfig {
  failure: {
    unstableModuleThreshold: number;
    recurringFailureBoundaryCount: number;
  };
  constraints: {
    unstableImportInstabilityThreshold: number;
    unstableImportWeightThreshold: number;
  };
  evolution: {
    maxTrendPoints: number;
    couplingNormalization: number;
    bugNormalization: number;
    churnNormalization: number;
  };
  governance: {
    unstableModuleThreshold: number;
    staleDecayThreshold: number;
    staleConfidenceThreshold: number;
    changeDecayWindowDays: number;
    bugDecayWindowDays: number;
    docDecayWindowDays: number;
  };
  policy: {
    hardPolicyEnabled: boolean;
    blockOnSeverity: 'high' | 'medium' | 'low' | 'none';
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const DEFAULT_CONFIG: CognitionConfig = {
  failure: {
    unstableModuleThreshold: 0.65,
    recurringFailureBoundaryCount: 3,
  },
  constraints: {
    unstableImportInstabilityThreshold: 0.75,
    unstableImportWeightThreshold: 2,
  },
  evolution: {
    maxTrendPoints: 30,
    couplingNormalization: 8,
    bugNormalization: 6,
    churnNormalization: 12,
  },
  governance: {
    unstableModuleThreshold: 0.7,
    staleDecayThreshold: 0.6,
    staleConfidenceThreshold: 0.35,
    changeDecayWindowDays: 365,
    bugDecayWindowDays: 420,
    docDecayWindowDays: 540,
  },
  policy: {
    hardPolicyEnabled: false,
    blockOnSeverity: 'none',
  },
};

function configFile(projectRoot: string): string {
  return path.join(projectRoot, '.code-intelligence', 'cognition-config.json');
}

function mergeConfig(base: CognitionConfig, override: DeepPartial<CognitionConfig>): CognitionConfig {
  return {
    failure: {
      ...base.failure,
      ...override.failure,
    },
    constraints: {
      ...base.constraints,
      ...override.constraints,
    },
    evolution: {
      ...base.evolution,
      ...override.evolution,
    },
    governance: {
      ...base.governance,
      ...override.governance,
    },
    policy: {
      ...base.policy,
      ...override.policy,
    },
  };
}

export async function loadCognitionConfigAsync(projectRoot: string): Promise<CognitionConfig> {
  const file = configFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return DEFAULT_CONFIG;
    const raw = JSON.parse(await bunFile.text()) as DeepPartial<CognitionConfig>;
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveCognitionConfigAsync(projectRoot: string, config: DeepPartial<CognitionConfig>): Promise<CognitionConfig> {
  const merged = mergeConfig(DEFAULT_CONFIG, config);
  await Bun.write(configFile(projectRoot), JSON.stringify(merged, null, 2));
  return merged;
}

export function defaultCognitionConfig(): CognitionConfig {
  return DEFAULT_CONFIG;
}
