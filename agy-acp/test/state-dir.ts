// Where a test run keeps its session records (issue #56).
//
// Importing this for its effect points `AGY_ACP_STATE_DIR` at a directory of this test process's own,
// for two reasons that are not cosmetic:
//
//   - **a test run has no business writing to `~/.local/state/agy-acp`.** The store is real state: a
//     suite that left records there would show up in the operator's `session/list` tomorrow.
//   - **the fixture conversations all report the same id**, and suites run in parallel processes under
//     `node --test`. Sharing one store, they would take each other's conversation locks and fail with
//     `session_in_use` for a reason that has nothing to do with what either of them is testing.
//
// Children inherit it through `process.env`, which is what the suites that spawn `main.ts` need; a test
// that wants a store of its own (a restart, a second "process") builds a `SessionStore` with an explicit
// root and does not go through this at all.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TEST_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-state-"));
process.env.AGY_ACP_STATE_DIR = TEST_STATE_ROOT;
process.on("exit", () => fs.rmSync(TEST_STATE_ROOT, { recursive: true, force: true }));
