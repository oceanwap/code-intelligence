/**
 * index.ts — barrel export for the recommend module.
 */
export {
  recommendNextAsync,
  coldStartDefault,
  type Recommendation,
  type RecommendOptions,
} from './cooccur.js';
export {
  isRecommendEnabled,
  withRecommendedNext,
  attachRecommendedNext,
  RECOMMEND_ENV_KEY,
  type McpServerLike,
  type ToolHandler,
} from './post-call.js';
