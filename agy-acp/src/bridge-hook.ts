#!/usr/bin/env node
// The agy PreToolUse hook the session bridge dials, in script mode. The behaviour - fail-closed by
// construction (one JSON decision on stdout, always, before exit 0), the no-retry wording, the
// deadline ladder - is in hook-run.ts, which the SEA binary re-executes as `<binary> --bridge-hook`
// instead of this file; that is what keeps the single executable free of a second file and of a
// Node dependency. agy runs this via `sh -c "exec <node> <abs>/bridge-hook.ts"` (the `exec` matters:
// without it a timeout kills the sh and leaves this process running); stdin is the payload JSON,
// stdout is the decision.

import { runBridgeHook } from "./hook-run.ts";

runBridgeHook();
