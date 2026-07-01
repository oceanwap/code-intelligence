/**
 * Module declaration for `proper-lockfile` (MIT, ~3 KB, no native
 * bindings). The package ships JS-only; we declare the surface we use
 * here so TypeScript can type-check the call site without pulling in
 * the full external type surface.
 */

declare module 'proper-lockfile' {
  /** Options accepted by `lockfile.lock`. We only use a subset. */
  export interface LockOptions {
    /** Resolve symlinks. Default `true`. Must be `false` to lock files that don't exist yet. */
    realpath?: boolean;
    /** Alternative lockfile location. Defaults to `<file>.lock`. */
    lockfilePath?: string;
    /** Milliseconds before a held lock is considered stale and force-taken. Default 10000. */
    stale?: number;
    /** Retry policy when the lock is held by another process. */
    retries?:
      | number
      | {
          /** Number of retries. Default 5. */
          retries: number;
          /** Initial backoff in ms. Default 10. */
          minTimeout?: number;
          /** Max backoff in ms. Default 200. */
          maxTimeout?: number;
          /** Backoff factor. Default 1.5. */
          factor?: number;
        };
  }

  /** Acquire an advisory file lock. Resolves to a release function. */
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;

  /** Release an advisory file lock. */
  export function unlock(file: string, options?: LockOptions): Promise<void>;

  /** Test whether the file is currently locked. */
  export function check(file: string, options?: LockOptions): Promise<boolean>;
}