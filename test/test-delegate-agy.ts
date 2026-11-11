// Run with: node --test test/test-delegate-agy.ts
//
// The `agy` driver: what the tool admits, how the adapter is spawned, which option answers a permission
// decision, and what the install check says. It is a unit file on purpose — `agy` and `agy-acp` are not
// installed on the CI box, and every assertion here is about the driver's own claims. The wire behavior of
// the adapter is covered by `agy-acp`'s own suites.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admit, agentDescription, describeAgents, findAgent, guardedClis, modelDescription } from "../extensions/lib/delegate/registry.ts";
import { driverCli } from "../extensions/lib/delegate/process.ts";
import {
	AGY_DEFAULT_MODE,
	AGY_TESTED_VERSION,
	agyDriver,
	agyLaunchPlan,
	pickAgyPermissionOption,
	probeAgyHealth,
	resetAgyHealthCache,
} from "../extensions/lib/delegate/drivers/agy.ts";
import { devinLaunchPlan } from "../extensions/lib/delegate/drivers/devin.ts";
import { resetCommandAvailabilityForTests } from "../extensions/lib/nonblocking.ts";
import { TESTED_AGY_VERSIONS } from "../agy-acp/src/agy/version.ts";
import { AGY_EFFORTS } from "../agy-acp/src/agy/models.ts";
import { AGY_ACP_MODE_IDS } from "../agy-acp/src/permission.ts";
import { CANONICAL_MODES } from "../extensions/lib/delegate/permissions.ts";

// The matcher patterns live at module scope: biome's useTopLevelRegex rule counts a literal
// recompiled per call, and every one of these runs inside a test body.
const NO_RESUME_RE = /no-resume/;
const BLOCKS_ACP_AGY_CLI_RE = /blocks-agy-acp\+agy-cli/;
const AGY_ACP_ALLOW_BYPASS_RE = /AGY_ACP_ALLOW_BYPASS/;
const ACCEPT_EDITS_RE = /accept-edits/;
const AGY_ACP_RE = /agy-acp/;
const NPM_INSTALL_RE = /npm install/;
const AGY_CLI_WHICH_IS_NOT_ON_PATH_RE = /agy` CLI, which is not on PATH/;
const AGY_ACP_COMMAND_RE = /AGY_ACP_COMMAND/;
const UNTESTED_RE = /untested/;
const COULD_NOT_READ_RE = /could not read/;

const ok = (r: ReturnType<typeof admit>) => {
	assert.strictEqual(r.ok, true, `expected admission to succeed: ${r.ok ? "" : r.error}`);
	if (r.ok) {
		return r;
	}
	throw new Error("unreachable");
};

/** The three options `agy-acp` offers, verbatim (`agy-acp/src/permission.ts`). */
const AGY_OPTIONS = [
	{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
	{ optionId: "allow_always", kind: "allow_always", name: "Always allow" },
	{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
];

/** A PATH holding stub binaries, so the install check can be run against a machine that does not have agy. */
function fakeBin(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
	for (const [name, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}
	return dir;
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const keys = Object.keys(env);
	const saved = new Map(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) {
		if (env[k] === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = env[k];
		}
	}
	resetCommandAvailabilityForTests();
	resetAgyHealthCache();
	try {
		await fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
		resetCommandAvailabilityForTests();
		resetAgyHealthCache();
	}
}

// --- registration and admission ---

test("agy is a registered agent, and the tool text says so", () => {
	assert.strictEqual(findAgent("agy").ok, true);
	assert.ok(agentDescription().includes("agy"), "the generated `agent` description mentions it");
	assert.ok(agentDescription().includes("agy-acp"), "and names the binary it launches");
	const line = describeAgents().find((l) => l.startsWith("agy"));
	assert.ok(line, `/delegate agents lists it: ${describeAgents().join(" | ")}`);
	// The capability line is what a human reads before choosing, so the two limits that matter most are here.
	assert.match(line, NO_RESUME_RE);
	assert.match(line, BLOCKS_ACP_AGY_CLI_RE);
});

test("`auto` is a mode the tool advertises, so agy answers it instead of refusing it", () => {
	// Devin and Claude both accept `auto`; a driver that does not know it makes one agent reject a mode
	// string the tool description offers. agy has no agent-judged tier, so it lands on `default` — the
	// stricter direction, which is the only one a mode mapping may go.
	assert.strictEqual(ok(admit({ agent: "agy", prompt: "x", mode: "auto" })).selection.mode, "auto");
	assert.deepStrictEqual(agyDriver.resolveMode("auto"), { ok: true, modeId: "default" });
	assert.deepStrictEqual(agyDriver.resolveMode("smart"), { ok: true, modeId: "default" });
});

test("the default mode is the one agy always offers, not the tool's historical one", () => {
	const r = ok(admit({ agent: "agy", prompt: "x" }));
	assert.strictEqual(r.selection.mode, AGY_DEFAULT_MODE);
	assert.strictEqual(agyDriver.defaultMode(), "accept-edits");
	// `dangerous` is the default for Devin and Claude. Making it agy's default too would make the ordinary
	// call fail on a machine whose operator never enabled bypass, which is not a default.
	assert.notStrictEqual(agyDriver.defaultMode(), "dangerous");
});

test("bypass is refused while the operator has not enabled it, and named when they have", async () => {
	await withEnv({ AGY_ACP_ALLOW_BYPASS: undefined }, () => {
		const r = admit({ agent: "agy", mode: "dangerous", prompt: "x" });
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.strictEqual(r.code, "INVALID_MODE");
			// The refusal has to be actionable: the knob, and what to use instead.
			assert.match(r.error, AGY_ACP_ALLOW_BYPASS_RE);
			assert.match(r.error, ACCEPT_EDITS_RE);
		}
		return Promise.resolve();
	});
	await withEnv({ AGY_ACP_ALLOW_BYPASS: "1" }, () => {
		assert.strictEqual(ok(admit({ agent: "agy", mode: "dangerous", prompt: "x" })).selection.mode, "dangerous");
		return Promise.resolve();
	});
});

test("effort is agy's own vocabulary, and a level it lacks is refused before a slot", () => {
	for (const level of ["low", "medium", "high", "xhigh", "max"]) {
		assert.strictEqual(ok(admit({ agent: "agy", thinking: level, prompt: "x" })).selection.thinking, level);
	}
	// `off` and `minimal` are canonical levels (Claude has no `off`, Devin has none at all). Refusing names
	// what the agent offers instead of spawning a session that answers -32602.
	for (const level of ["off", "minimal"]) {
		const r = admit({ agent: "agy", thinking: level, prompt: "x" });
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.strictEqual(r.code, "THINKING_UNAVAILABLE");
		}
	}
});

test("models are unknown here and refused by the adapter, which is the honest arrangement", () => {
	// `agy models` is account-specific; a hardcoded list would be a lie about someone else's install. The
	// check happens in `agy-acp` at session/new, against the list agy itself reported.
	const cat = agyDriver.models();
	assert.deepStrictEqual(cat.values, []);
	assert.strictEqual(cat.onUnknown, "warn");
	assert.strictEqual(ok(admit({ agent: "agy", model: "gemini-3-pro-high", prompt: "x" })).warnings.length, 0);
	assert.ok(modelDescription().includes(`agy defaults to '${cat.default}'`), "the tool text states the default");
});

// --- the spawn argv ---

test("the argv per backend: the selection travels as flags on the adapter", () => {
	// The acceptance item is "spawn argv per backend", and this is the whole difference between two drivers
	// that share one transport: same selection, different argv.
	assert.deepStrictEqual(devinLaunchPlan({ model: "swe-2-max", mode: "dangerous" }, "/repo"), {
		command: "devin",
		args: ["acp", "--model", "swe-2-max"],
		env: { DEVIN_MODEL: "swe-2-max" },
		label: "devin acp",
		clientInfo: { name: "pi-delegate-task", version: "1.0" },
	});
	assert.deepStrictEqual(agyLaunchPlan({ mode: "accept-edits" }, "/repo").args, []);
	assert.deepStrictEqual(agyLaunchPlan({ model: "gemini-3-pro", mode: "ask" }, "/repo").args, ["--model", "gemini-3-pro"]);
	assert.deepStrictEqual(agyLaunchPlan({ thinking: "xhigh", mode: "ask" }, "/repo").args, ["--effort", "xhigh"]);
	assert.deepStrictEqual(agyLaunchPlan({ model: "gemini-3-pro", thinking: "max", mode: "ask" }, "/repo").args, [
		"--model",
		"gemini-3-pro",
		"--effort",
		"max",
	]);
});

test("the agy plan sets no environment, because every knob in it is the operator's", () => {
	const plan = agyLaunchPlan({ model: "m", thinking: "low", mode: "ask" }, "/repo");
	assert.deepStrictEqual(plan.env, {});
	assert.strictEqual(plan.command, "agy-acp");
	// An inherited AGY_ACP_MODEL is answered by an explicit flag, not by an empty env entry: `agy-acp`
	// resolves `launch.model ?? env.model`, so the flag is what wins.
	assert.strictEqual(agyLaunchPlan({ model: "explicit", mode: "ask" }, "/repo").args.join(" "), "--model explicit");
});

test("the model sentinel `default` is passed as the sentinel, not as a model named default", () => {
	// `agy-acp` treats `default` as "agy picks" (`AGY_DEFAULT_CHOICE`), so a caller who types it means that
	// and gets it, rather than a refusal about an id nobody has.
	const args = agyLaunchPlan({ model: "default", mode: "ask" }, "/repo").args;
	assert.deepStrictEqual(args, ["--model", "default"]);
});

// --- permission mapping ---

test("agy's three options answer the three decisions, by id", () => {
	assert.strictEqual(pickAgyPermissionOption(AGY_OPTIONS, "allow"), "allow_once");
	// `allow_always` here is an in-memory, per-session grant (`permission-gate.ts`), which is what
	// `allow_session` asks for — so this driver maps it, and says so in `permission()`.
	assert.strictEqual(pickAgyPermissionOption(AGY_OPTIONS, "allow_session"), "allow_always");
	assert.strictEqual(pickAgyPermissionOption(AGY_OPTIONS, "reject"), "reject_once");
	assert.strictEqual(agyDriver.permission().degradesAllowSession, false);
});

test("an option the caller was not offered is never chosen, whatever it claims to be", () => {
	// The hostile shape: a trust prompt wearing an `allow_once` label. Matching by `kind` would approve a
	// workspace-wide trust decision the caller never saw.
	const hostile = [
		{ optionId: "trust_workspace", kind: "allow_once", name: "Trust this folder" },
		{ optionId: "allow_always_project", kind: "allow_always", name: "Always allow in project" },
	];
	assert.strictEqual(pickAgyPermissionOption(hostile, "allow"), undefined);
	assert.strictEqual(pickAgyPermissionOption(hostile, "allow_session"), undefined);
	assert.strictEqual(pickAgyPermissionOption(hostile, "reject"), undefined);
	// Absent `allow_always` narrows rather than failing: a session rule the agent cannot make becomes one
	// approval, which is never more than the caller agreed to.
	assert.strictEqual(
		pickAgyPermissionOption(
			[
				{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
				{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
			],
			"allow_session",
		),
		"allow_once",
	);
});

test("the shared policy keeps the same rule for the other drivers", () => {
	// Pinned here because `agy` is the driver that *does* map a fourth id: the default must not acquire its
	// vocabulary by accident.
	const r = agyDriver.permission().pickOption([{ optionId: "allow_always", kind: "allow_once", name: "mislabelled" }], "allow");
	assert.strictEqual(r, undefined, "even agy's `allow` answers only `allow_once`");
});

// --- the install check ---

test("a missing adapter is reported as a missing adapter, with the fix", async () => {
	const empty = fakeBin({});
	await withEnv({ PATH: empty, AGY_ACP_COMMAND: undefined }, async () => {
		const health = await probeAgyHealth();
		assert.strictEqual(health.ok, false);
		if (!health.ok) {
			assert.match(health.error, AGY_ACP_RE);
			assert.match(health.hint ?? "", NPM_INSTALL_RE);
		}
	});
});

test("an adapter without the CLI behind it says so, and names the knob that points elsewhere", async () => {
	const bin = fakeBin({ "agy-acp": "exit 0" });
	await withEnv({ PATH: bin, AGY_ACP_COMMAND: undefined }, async () => {
		const health = await probeAgyHealth();
		assert.strictEqual(health.ok, false);
		if (!health.ok) {
			assert.match(health.error, AGY_CLI_WHICH_IS_NOT_ON_PATH_RE);
			assert.match(health.hint ?? "", AGY_ACP_COMMAND_RE);
		}
	});
});

test("the tested version is quiet, an untested one is a note, and an unreadable one is a note too", async () => {
	const tested = fakeBin({ "agy-acp": "exit 0", agy: 'echo "1.4.2"' });
	await withEnv({ PATH: tested, AGY_ACP_COMMAND: undefined }, async () => {
		const health = await probeAgyHealth();
		assert.deepStrictEqual(health, { ok: true });
	});
	const untested = fakeBin({ "agy-acp": "exit 0", agy: 'echo "9.9.9"' });
	await withEnv({ PATH: untested, AGY_ACP_COMMAND: undefined }, async () => {
		const health = await probeAgyHealth();
		assert.strictEqual(health.ok, true, "an untested version warns, it does not refuse");
		if (health.ok) {
			assert.match(health.note ?? "", UNTESTED_RE);
		}
	});
	const silent = fakeBin({ "agy-acp": "exit 0", agy: "exit 3" });
	await withEnv({ PATH: silent, AGY_ACP_COMMAND: undefined }, async () => {
		const health = await probeAgyHealth();
		assert.strictEqual(health.ok, true, "a probe that answered nothing has not established that anything is wrong");
		if (health.ok) {
			assert.match(health.note ?? "", COULD_NOT_READ_RE);
		}
	});
});

test("AGY_ACP_COMMAND is the binary the check asks about, because it is the one the adapter runs", async () => {
	// The adapter resolves `AGY_ACP_COMMAND ?? "agy"`; a check that looked for `agy` while the sessions ran
	// a differently-named wrapper would refuse a working machine.
	const bin = fakeBin({ "agy-acp": "exit 0", "agy-nightly": 'echo "1.4.2"' });
	await withEnv({ PATH: bin, AGY_ACP_COMMAND: "agy-nightly" }, async () => {
		assert.deepStrictEqual(await probeAgyHealth(), { ok: true });
	});
});

test("the install check is cached, so a burst of delegations does not spawn a CLI each", async () => {
	const calls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-count-")), "count");
	const bin = fakeBin({ "agy-acp": "exit 0", agy: `echo x >> ${calls}\necho "1.4.2"` });
	await withEnv({ PATH: bin, AGY_ACP_COMMAND: undefined }, async () => {
		await probeAgyHealth(1_000);
		await probeAgyHealth(2_000);
		assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "one probe, two calls");
		// Past the TTL the answer is re-asked: an install that appears later must be noticed.
		await probeAgyHealth(70_000);
		assert.strictEqual(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
	});
});

// --- cross-tree agreement ---

test("the version this driver assumes is the version agy-acp assumes", () => {
	// The two trees ship separately, so the number is duplicated — and this is what stops the duplication
	// from drifting into a version gate that quietly stopped gating.
	assert.deepStrictEqual(TESTED_AGY_VERSIONS, [AGY_TESTED_VERSION]);
});

test("the effort levels this driver offers are the adapter's, exactly", () => {
	// Duplicated because `extensions/` installs without `agy-acp/` beside it, and a copy nobody compares is
	// a claim: a level the adapter gained would be refused at admission here forever, with no failing test
	// to say why.
	assert.deepStrictEqual([...(agyDriver.capabilities().thinkingLevels?.() ?? [])], [...AGY_EFFORTS]);
});

test("every mode this driver resolves to is a mode agy-acp advertises", async () => {
	// The alias table's targets are the second half of the same duplication. A mode id the adapter renames
	// would not fail until `session/set_mode` on a live delegation, which surfaces as a warning on a run
	// that is already billed.
	for (const canonical of [...CANONICAL_MODES, "auto", "manual"]) {
		const r = agyDriver.resolveMode(canonical);
		if (!r.ok) {
			// Exactly one refusal is a feature rather than drift, and it is the operator's gate, not the table.
			assert.strictEqual(canonical, "dangerous", `${canonical} refused: ${r.error}`);
			assert.match(r.error, AGY_ACP_ALLOW_BYPASS_RE);
			continue;
		}
		assert.ok(
			AGY_ACP_MODE_IDS.includes(r.modeId),
			`${canonical} maps to '${r.modeId}', which agy-acp does not advertise (${AGY_ACP_MODE_IDS.join(", ")})`,
		);
	}
	// With the gate open the fourth id is reachable too, so the table is checked against all four.
	await withEnv({ AGY_ACP_ALLOW_BYPASS: "1" }, () => {
		const r = agyDriver.resolveMode("dangerous");
		assert.ok(r.ok && AGY_ACP_MODE_IDS.includes(r.modeId), "bypass must be a real mode id");
		return Promise.resolve();
	});
	assert.ok(AGY_ACP_MODE_IDS.includes(agyDriver.defaultMode()), "the default mode must be a real one");
});

test("the guarded CLI list covers the CLI and the adapter, and not the host's own CLI", () => {
	const guarded = guardedClis();
	assert.ok(guarded.includes("agy"), "agy itself cannot be run around the queue");
	assert.ok(guarded.includes("agy-acp"), "nor the adapter that would run it");
	assert.ok(guarded.includes("devin"));
	assert.ok(!guarded.includes("claude"), "claude is the operator's CLI, and pi may be driving it");
});

test("the pid-recycle guard is given the binary the spawned process actually is", () => {
	// The same `cli` field feeds two guards, and they want different names: the bash guard wants every name
	// the work answers to (`agy` + `agy-acp`), while the pid guard substring-matches `/proc/<pid>/cmdline`
	// before killing a pid recorded some time ago, and wants the one the process *is*. `agy` there is three
	// characters wide — this workspace's own path contains it three times, so a recycled pid running
	// anything under it would have been SIGKILLed as an `agy` process.
	assert.strictEqual(driverCli("agy"), "agy-acp");
	assert.deepStrictEqual(
		guardedClis().filter((c) => c.startsWith("agy")),
		["agy-acp", "agy"],
	);
});

test("the capability claims that a wire feature would have to earn", () => {
	const caps = agyDriver.capabilities();
	// `agy-acp` answers session/load only from sub-issue #56 (on `dev`), and this engine's reattach is
	// "prompt the recorded id", which its registry refuses. Claiming resume would let a follow-up promise
	// a continuation nothing restores.
	assert.strictEqual(caps.resume, false);
	assert.strictEqual(caps.plans, false, "agy-acp emits no plan update");
	assert.strictEqual(caps.cancel, true);
	assert.strictEqual(caps.permissions, true);
	assert.strictEqual(caps.worktree, "host");
	assert.strictEqual(typeof agyDriver.backfill, "undefined", "no reading another program's session store");
});
