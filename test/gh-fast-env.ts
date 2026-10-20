// Scale the shared GitHub backoff down for the branch-observer E2E test
// (fast 0.5 s x 5, then slow 2 s). Test 5's auth failure degrades the shared
// state; test 10's merge detection must still get a slot quickly.
// Must be imported before any extension that loads the ghHealth singleton, which
// reads these env vars at module load time.
process.env.PI_GH_HEALTH_FAST_MS = "500";
process.env.PI_GH_HEALTH_FAST_RETRIES = "5";
process.env.PI_GH_HEALTH_SLOW_MS = "2000";
export {};
