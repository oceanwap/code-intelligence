#!/usr/bin/env bun

// Bun-native entrypoint: execute the TypeScript CLI directly.
await import(new URL('../src/cli.ts', import.meta.url).href);
