/**
 * Next.js server boot hook. Runs once per server process (or once per HMR
 * reload in dev). We use this to start the in-process price-refresh interval
 * when the deploy environment is configured for `setInterval` mode (typically
 * localhost). Production/dev deploys use cron-job.org instead, in which case
 * this hook is a no-op.
 *
 * See `config/cronjob_config.ts` for the env → timing-source mapping.
 */

declare global {
  // eslint-disable-next-line no-var
  var __altairPriceIntervalStarted: boolean | undefined;
}

export async function register() {
  // Only run on the Node.js runtime, not the Edge runtime.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Guard against HMR / repeat registration in dev.
  if (global.__altairPriceIntervalStarted) return;
  global.__altairPriceIntervalStarted = true;

  // Dynamic imports so Edge/build-time evaluation doesn't pull in MongoDB.
  const { resolveTimingSource } = await import('./config/cronjob_config');
  const timingSource = resolveTimingSource();

  if (timingSource !== 'setInterval') {
    console.log('[instrumentation] timingSource is', timingSource, '— skipping in-process price interval');
    return;
  }

  const [{ PRICE_RULES }, { refreshAllTokenPrices, refreshPricesIfStale }] = await Promise.all([
    import('./config/blockchain_config'),
    import('@/lib/priceService'),
  ]);

  const periodMs = PRICE_RULES.fetchAllConditions.periodically * 60_000;

  // Boot-time staleness check: fire immediately if data is older than `periodically`
  // minutes (or empty). The in-flight guard inside refreshAllTokenPrices makes this
  // safe to call alongside the interval below.
  refreshPricesIfStale()
    .then((res) => {
      console.log('[instrumentation] boot staleness check', {
        triggered: res.triggered,
        maxPriceUpdatedAt: res.maxPriceUpdatedAt,
      });
    })
    .catch((err) => {
      console.error('[instrumentation] boot staleness check failed', err);
    });

  const interval = setInterval(() => {
    refreshAllTokenPrices().catch((err) => {
      console.error('[instrumentation] periodic refreshAllTokenPrices failed', err);
    });
  }, periodMs);
  (interval as unknown as { unref?: () => void }).unref?.();

  console.log('[instrumentation] in-process price refresh interval registered', {
    periodMs,
    periodMinutes: PRICE_RULES.fetchAllConditions.periodically,
  });
}
