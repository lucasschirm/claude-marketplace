// Run with: node --test test/test-orca-status.ts
//
// `formatAllWorkersAndRuns()` is the text `orca_orchestration_status({all:true})` and
// `orca_orchestration_observe({all:true})` hand to the model. A failed `worker-list` used to render
// as "No live workers currently active." — the exact lie F3 exists to remove, one level above
// execOrca(): a coordinator that believes nothing is running dispatches a second worker for work
// that is already in flight.
import { after, test } from "node:test";
import * as assert from "node:assert";
import { formatAllWorkersAndRuns } from "../extensions/orca-orchestration.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalOrcaCmd = process.env.ORCA_CLI_COMMAND;
const created: string[] = [];

after(() => {
	// Never leave a fake `orca` resolvable: later suites in this process would exec it.
	if (originalOrcaCmd === undefined) delete process.env.ORCA_CLI_COMMAND;
	else process.env.ORCA_CLI_COMMAND = originalOrcaCmd;
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `orca` whose reply depends on the arguments, so one command can succeed while the other
 * fails. `ORCA_CLI_COMMAND` is honoured by resolveOrcaCmd(), so no live Orca backend is needed.
 * A success body must be a whole envelope (`{"ok":true,"result":{…}}`): a bare payload has no `ok`
 * field and is correctly treated as a failure.
 */
function fakeOrca(script: string): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-status-fake-"));
	created.push(dir);
	const file = path.join(dir, "orca");
	fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.ORCA_CLI_COMMAND = file;
}

const skipOnWindows = process.platform === "win32" ? { skip: "sh fixture" } : {};

test('a failed worker-list is reported, never collapsed into "no live workers"', skipOnWindows, async () => {
	// exit 0 with a traceback on stdout: the shape that used to parse-fail into ok:true.
	fakeOrca(`printf '%s\\n' 'Traceback (most recent call last): boom'`);
	const text = await formatAllWorkersAndRuns(process.cwd());

	// the parse message itself spans lines, so `.*` would not reach the code
	assert.match(text, /Unable to list workers:[\s\S]*\(BAD_JSON\)/);
	assert.doesNotMatch(text, /No live workers currently active\./);
	// The count is unknown, not zero: "(0)" is the number a coordinator acts on.
	assert.match(text, /Active \/ Live Workers \(unknown\)/);
	assert.match(text, /Recent Runs \(unknown\)/);
});

test("one failing list does not make the verified-empty one look equally unknown", skipOnWindows, async () => {
	fakeOrca(
		'case "$*" in\n' +
			'*worker-list*) printf \'%s\\n\' \'{"ok":true,"result":{"workers":[]}}\' ;;\n' +
			"*) printf '%s\\n' 'not json at all' ;;\n" +
			"esac",
	);
	const text = await formatAllWorkersAndRuns(process.cwd());

	// worker-list genuinely returned an empty list, so the empty statement is honest...
	assert.match(text, /Active \/ Live Workers \(0\)/);
	assert.match(text, /No live workers currently active\./);
	// ...while the run-list failure is surfaced instead of "No Runs registered.".
	assert.match(text, /Recent Runs \(unknown\)/);
	assert.match(text, /Unable to list Runs:[\s\S]*\(BAD_JSON\)/);
	assert.doesNotMatch(text, /No Runs registered\./);
});
