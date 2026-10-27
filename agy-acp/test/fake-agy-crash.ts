#!/usr/bin/env node
// A fake `agy` for the session-layer mid-turn crash test (test-sessions.ts):
//
//   - first launch (no `--conversation`): emits init (the conversation id) on the first stdin
//     line, then - when the user line arrives - one agent_response delta, a stderr marker, and
//     exit 137 without a `result`: a crash mid-turn;
//   - relaunch (with `--conversation <id>`): emits init on the first line, the `RESUMED` turn on
//     the user line, a SUCCESS result, then waits at the turn boundary until stdin closes
//     (exit 0);
//   - `--version` prints 1.4.2 (the tested version, so the server's version gate passes).
//
// FAKE_AGY_RESUME_MISMATCH=1: on the relaunch the init reports a different conversation id -
// simulating an agy that could not find the conversation and started a fresh one (its counters
// would restart near zero; the server must refuse such a resume, not accept it).
//
// The relaunch is accepted only with the exact expected `--conversation` value (and the basic
// headless flag vector, like the fixture fake): a drifted respawn argv fails the test.

const CONVERSATION_ID = "0c5b1f3e-1111-2222-3333-444455556666";

const argv = process.argv.slice(2);

function out(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (argv[0] === "--version") {
	process.stdout.write("1.4.2\n");
	process.exit(0);
}

const flag = (name: string, value?: string) => {
	const i = argv.indexOf(name);
	return i >= 0 && (value === undefined || argv[i + 1] === value);
};
if (!flag("-p=") || !flag("--input-format", "stream-json") || !flag("--output-format", "stream-json")) {
	process.stderr.write("fake-agy-crash: expected the headless stream-json flag vector\n");
	process.exit(2);
}

const convIndex = argv.indexOf("--conversation");
const resumed = convIndex >= 0;
if (resumed && argv[convIndex + 1] !== CONVERSATION_ID) {
	process.stderr.write(`fake-agy-crash: respawn argv drifted: --conversation ${argv[convIndex + 1]} (want ${CONVERSATION_ID})\n`);
	process.exit(2);
}

const initEvent = {
	event: "init",
	conversation_id: resumed && process.env.FAKE_AGY_RESUME_MISMATCH === "1" ? "9f9f9f9f-1111-2222-3333-444455556666" : CONVERSATION_ID,
	init: { model: "fake-crash-model", cwd: process.cwd(), tools: [], permission_mode: "request-review" },
};

let keepAlive: ReturnType<typeof setInterval> | null = null;
let initSent = false;
let turnEmitted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => {
	// Sitting at the turn boundary, the process exits when stdin closes (the recorded agy model).
	if (keepAlive) clearInterval(keepAlive);
	process.exit(0);
});
process.stdin.on("data", (d: string) => {
	for (const line of d.split("\n")) {
		if (line.trim() === "") continue;
		if (!initSent) {
			// Real agy emits init after the first stdin line - the probe exploits that.
			initSent = true;
			out(initEvent);
		}
		if (!turnEmitted && line.includes('"event":"user"')) {
			turnEmitted = true;
			if (resumed) {
				// The conversation's step numbering continues the first process (which used 0 and 1).
				setTimeout(() => {
					out({
						event: "step_update",
						step_update: { conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "user_input" },
					});
					out({
						event: "step_update",
						step_update: { conversation_id: CONVERSATION_ID, step_index: 3, state: "ACTIVE", step_type: "agent_response" },
					});
					out({
						event: "step_update",
						step_update: {
							conversation_id: CONVERSATION_ID,
							step_index: 3,
							state: "DONE",
							step_type: "agent_response",
							text_delta: "RESUMED",
							usage: { input_tokens: 500, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 550 },
						},
					});
					out({
						event: "result",
						result: {
							conversation_id: CONVERSATION_ID,
							status: "SUCCESS",
							response: "RESUMED\n",
							num_turns: 1,
							duration_seconds: 1.5,
							usage: { input_tokens: 500, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 550 },
						},
					});
					keepAlive = setInterval(() => {}, 1000);
				}, 20);
			} else {
				setTimeout(() => {
					out({
						event: "step_update",
						step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: "DONE", step_type: "user_input" },
					});
					out({
						event: "step_update",
						step_update: { conversation_id: CONVERSATION_ID, step_index: 1, state: "ACTIVE", step_type: "agent_response" },
					});
					setTimeout(() => {
						process.stderr.write("simulated crash: killed mid-turn\n");
						process.exit(137);
					}, 60);
				}, 20);
			}
		}
	}
});
