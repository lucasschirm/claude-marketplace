// `agy --version` gate.
//
// The stream contract has no schema version, so the agy version is the only drift signal: the
// fixtures were recorded against a tested version, and any other version is at best untested.
// Untested produces a warning; `AGY_ACP_STRICT_VERSION=1` turns it into a refusal, which a host
// that must not run on an unknown agy can set.

import { spawnProcessGroup } from "../lib/child-process.ts";

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

/**
 * Runs `argv[0] argv[1..n]` (e.g. `["agy", "--version"]`), bounded by `timeoutMs`, and judges the
 * printed version. Throws when the binary cannot be run, times out, or prints no version.
 */
export async function checkAgyVersion(argv: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<AgyVersionStatus> {
	const version = await runVersionCommand(argv, timeoutMs);
	const tested = TESTED_AGY_VERSIONS.includes(version);
	const strict = process.env.AGY_ACP_STRICT_VERSION === "1";
	const warning = tested ? null : `agy ${version} is untested; agy-acp is tested against ${TESTED_AGY_VERSIONS.join(", ")}`;
	return { version, tested, strictRefusal: !tested && strict, warning };
}

function runVersionCommand(argv: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawnProcessGroup({
			command: argv[0],
			args: argv.slice(1),
			env: process.env,
			// --version exits on its own; the bound is for a hung binary, not for work.
			timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			reject(new Error(`${message}; stderr: ${stderr.trim() || "(empty)"}`));
		};
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			const version = stdout
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l !== "")
				?.split(/\s+/)[0];
			if (code === 0 && version) resolve(version);
			else fail(`agy --version exited with code=${code} signal=${signal ?? "none"} output=${JSON.stringify(stdout.trim())}`);
		};
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (err: Error) => fail(`cannot run ${argv[0]}: ${err.message}`));
		// A hung binary dies on the spawn timeout (above), and its exit lands here.
		child.on("exit", (code, signal) => finish(code, signal));
	});
}
