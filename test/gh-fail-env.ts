// Scale the shared GitHub backoff down for E2E tests (fast 1.5 s x 5, then slow 8 s).
// Must be imported before any extension that loads the ghHealth singleton, which reads
// these env vars at module load time.
process.env.PI_GH_HEALTH_FAST_MS = "1500";
process.env.PI_GH_HEALTH_FAST_RETRIES = "5";
process.env.PI_GH_HEALTH_SLOW_MS = "8000";
export {};
