/**
 * index.ts — barrel export for the intents module.
 */
export {
  getIntent,
  hasIntent,
  listIntents,
  tryGetIntent,
  getRegistry,
  type RegisteredIntentName,
  type IntentRecord,
} from './registry.js';
export {
  runIntentAsync,
  type RunIntentInput,
  type RunIntentPayload,
} from './runner.js';
