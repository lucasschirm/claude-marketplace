// `agy --version` gate.
//
// The stream contract has no schema version, so the agy version is the only drift signal: the
// fixtures were recorded against a tested version, and any other version is at best untested; an
// untested version produces a warning, and `AGY_ACP_STRICT_VERSION=1` turns it into a refusal.

import type { AgyArgv } from "./args.ts";
import { envFlag } from "../config.ts";
import { runAgyOneShot } from "./one-shot.ts";

/** Versions the fixtures and driver were recorded and tested against. */
export const TESTED_AGY_VERSIONS = ["1.4.2"];

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AgyVersionStatus {
	/** The version the binary printed (first token of the first non-empty stdout line). */
	version: string;
	/** True when the version is in TESTED_AGY_VERSIONS. */
	tested: boolean;
	/** True when `AGY_ACP_STRICT_VERSION=1` refuses this version. */
	strictRefusal: boolean;
	/** The warning to surface, or null when the version is tested. */
	warning: string | null;
}

/** Runs `argv` (e.g. `["agy", "--version"]`) in `env`, bounded by `timeoutMs`, and judges the printed version. Throws when the binary cannot be run, times out, or prints no version. */
export async function checkAgyVersion(
	argv: AgyArgv,
	env: NodeJS.ProcessEnv,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgyVersionStatus> {
	const version = await runVersionCommand(argv, timeoutMs, env);
	const tested = TESTED_AGY_VERSIONS.includes(version);
	// The env the caller handed us, never this process's: a session can be launched with its own
	// environment, and the strict-version refusal belongs to that session, not to whoever spawned it.
	const strict = envFlag(env, "AGY_ACP_STRICT_VERSION");
	const warning = tested ? null : `agy ${version} is untested; agy-acp is tested against ${TESTED_AGY_VERSIONS.join(", ")}`;
	return { version, tested, strictRefusal: !tested && strict, warning };
}

/** The first token of the first non-empty stdout line, or the failure that explains why there is none. */
async function runVersionCommand(argv: AgyArgv, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
	const r = await runAgyOneShot(argv, timeoutMs, env);
	const context = `stderr: ${r.stderr.trim() || "(empty)"}`;
	if (r.spawnError !== null) {
		throw new Error(`cannot run ${argv[0]}: ${r.spawnError.message}; ${context}`);
	}
	if (r.timedOut) {
		throw new Error(`agy --version timed out after ${timeoutMs} ms; ${context}`);
	}
	const version = r.stdout
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "")
		?.split(/\s+/)[0];
	if (r.code === 0 && version !== undefined && version !== "") {
		return version;
	}
	throw new Error(
		`agy --version exited with code=${r.code} signal=${r.signal ?? "none"} output=${JSON.stringify(r.stdout.trim())}; ${context}`,
	);
}
