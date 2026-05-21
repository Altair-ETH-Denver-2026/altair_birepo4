export type TimingSource = 'cron-job.org' | 'setInterval';
export type BackendEnv = 'localhost' | 'dev' | 'prod';

export const TIMING_SOURCES: Record<BackendEnv, TimingSource> = {
    localhost: 'setInterval',
    dev: 'cron-job.org',
    prod: 'cron-job.org',
};

/**
 * Resolve which deploy environment the backend process is running in.
 *
 * Resolution order:
 *   1. `BACKEND_ENV` env var if explicitly set to 'localhost' | 'dev' | 'prod' — covers
 *      cases where NODE_ENV alone can't distinguish dev from prod (both run with NODE_ENV=production).
 *   2. `NODE_ENV === 'development'` → 'localhost'.
 *   3. Fallback → 'prod' (safer default — keeps setInterval out of an unidentified production deploy).
 */
export function resolveBackendEnv(): BackendEnv {
  const explicit = process.env.BACKEND_ENV?.trim().toLowerCase();
  if (explicit === 'localhost' || explicit === 'dev' || explicit === 'prod') {
    return explicit;
  }
  if (process.env.NODE_ENV === 'development') {
    return 'localhost';
  }
  return 'prod';
}

export function resolveTimingSource(): TimingSource {
  const env = resolveBackendEnv();
  return TIMING_SOURCES[env];
}
