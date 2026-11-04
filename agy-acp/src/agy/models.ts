// The model list: what `agy models` prints, and the rules that turn a client's choice into flags.
//
// `agy models` (agy 1.4.2) writes one `<id>\t<Display Name>` line per model to stdout - the same
// ids `--model` takes - and it needs credentials: unauthenticated it exits 1 with "Please sign in to
// view available models". The list is therefore fetched once per process, behind a timeout, and a
// failure is a supported state rather than an accident: the session then advertises only the model
// agy's `init` reported and stops claiming to know the rest (agy remains the authority at startup -
// the recorded `bad-model-id` fixture shows it refusing an unknown id with the available list).
//
// Effort is the other half: `agy --help` documents `--effort low|medium|high|xhigh|max`, and the
// ids above carry an effort suffix of their own. Two combinations die at agy startup (recorded
// probes): an effort a model does not have, and an effort-qualified id paired with a different
// `--effort` ("--model gemini-3.8-flash-low conflicts with --effort=high"). Only agy knows which
// efforts a given model supports, so the conflict agy-acp can PREDICT is refused up front and every
// other pair is passed through for agy to judge.

import type { AgyArgv } from "./args.ts";
import { spawnProcessGroup } from "../lib/child-process.ts";

/** The `--effort` values `agy --help` documents (1.4.2). */
export const AGY_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The sentinel meaning "no flag at all - whatever agy picks when it is given none". */
export const AGY_DEFAULT_CHOICE = "default";

/** How long `agy models` may take before the list is written off (it is a network call). */
export const DEFAULT_MODELS_TIMEOUT_MS = 30_000;

/** One model as `agy models` lists it: the id `--model` takes, and the display name. */
export interface AgyModel {
	modelId: string;
	name: string;
}

export interface ModelCatalog {
	/** The list, fetched once and cached; `null` when it cannot be had (logged once, at the failure). */
	list(): Promise<AgyModel[] | null>;
	/** The settled answer without awaiting it (`null` = not fetched, or failed). */
	snapshot(): AgyModel[] | null;
	/**
	 * Why the listing could not be had (`null` while it has not failed). `session/new` puts this in
	 * `_meta.models` verbatim: "no list" is one fact, and "no list because agy said sign in" is a
	 * different one the client can act on, so the reason must not be flattened into a static note.
	 */
	failure(): string | null;
}

/**
 * `agy models` stdout: `id<TAB>Display Name` per line. Anything that is not shaped like that -
 * a spinner fragment, a blank line, a line whose id contains whitespace - is not a model, and a
 * listing that yields none is treated as no listing at all (the caller falls back).
 */
export function parseModelsTable(stdout: string): AgyModel[] {
	const models: AgyModel[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const [, modelId, name] = /^([^\s\t]+)\t+(.*)$/.exec(trimmed) ?? [];
		// The line is trimmed before the match, so `(.*)` cannot come back empty: a row whose name is
		// missing has no tab left by then and is skipped with everything else that is not a model row.
		if (modelId === undefined || name === undefined) continue;
		models.push({ modelId, name: name.trim() });
	}
	return models;
}

/** Runs `[...argv, "models"]` in `env`, bounded by `timeoutMs`; throws when it yields no model. */
export function listAgyModels(argv: AgyArgv, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<AgyModel[]> {
	return new Promise((resolve, reject) => {
		const child = spawnProcessGroup({
			command: argv[0],
			args: [...argv.slice(1), "models"],
			env,
			// Named at the call site per the spawn gate: this one is a network call, not a `--version`.
			timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			reject(new Error(`${message}; stderr: ${stderr.trim() || "(empty)"}`));
		};
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		// The spawn timeout SIGTERMs the child's pid once; a binary that ignores it must not hold the
		// session/new hostage, so the watchdog kills the group and says so (agy/version.ts, same shape).
		const watchdog = setTimeout(() => {
			if (child.pid !== undefined)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// the group is already gone
				}
			fail(`agy models timed out after ${timeoutMs} ms`);
		}, timeoutMs);
		watchdog.unref();
		child.on("error", (err: Error) => fail(`cannot run ${argv[0]} models: ${err.message}`));
		// "close" (not "exit"): stdout is fully delivered before the terminal state.
		child.on("close", (code, signal) => {
			const models = parseModelsTable(stdout);
			if (code === 0 && models.length > 0) {
				if (settled) return;
				settled = true;
				clearTimeout(watchdog);
				resolve(models);
				return;
			}
			fail(`agy models exited with code=${code} signal=${signal ?? "none"}, ${models.length} model(s) listed`);
		});
	});
}

/**
 * The per-process model list. `list()` fetches once and caches the answer, success or failure: a
 * second `session/new` must not pay for - or hammer - a network call that already failed, and the
 * fallback (advertise what `init` reported) is complete on its own. A client that picks a model
 * anyway is not blocked by a listing that never worked: agy refuses an unknown id at startup with
 * the available list, which the session reports as its own startup error.
 */
export function makeModelCatalog(argv: AgyArgv, env: NodeJS.ProcessEnv, timeoutMs: number, log: (line: string) => void): ModelCatalog {
	let pending: Promise<AgyModel[] | null> | null = null;
	let settled: AgyModel[] | null = null;
	let reason: string | null = null;
	return {
		list() {
			pending ??= listAgyModels(argv, timeoutMs, env).then(
				(models) => {
					settled = models;
					return models;
				},
				(err: Error) => {
					reason = err.message;
					log(`agy models failed - advertising only what agy reports per session: ${err.message}`);
					return null;
				},
			);
			return pending;
		},
		snapshot: () => settled,
		failure: () => reason,
	};
}

/** Is this a value `--effort` accepts (or the sentinel that means "ask for none")? */
export function isEffort(value: string): boolean {
	return value === AGY_DEFAULT_CHOICE || AGY_EFFORTS.includes(value);
}

/** Does this model id carry an effort of its own (every id `agy models` printed in 1.4.2 does)? */
export function modelEffort(modelId: string): string | undefined {
	const suffix = modelId.split("-").pop();
	return suffix !== undefined && AGY_EFFORTS.includes(suffix) ? suffix : undefined;
}

/**
 * The pair agy is known to refuse: an effort-qualified model id and a different `--effort`
 * ("--model gemini-3.8-flash-low conflicts with --effort=high"). Refusing it here is what keeps a
 * selection from breaking every later turn with a startup error the client cannot act on. Any other
 * pair goes through: per-model effort support is not on the documented surface, so agy judges it.
 */
export function effortConflict(modelId: string, effort: string): string | null {
	if (effort === AGY_DEFAULT_CHOICE || modelId === AGY_DEFAULT_CHOICE) return null;
	const carried = modelEffort(modelId);
	if (carried === undefined || carried === effort) return null;
	return `agy refuses --model ${modelId} together with --effort ${effort}: the model id carries ${carried} effort`;
}
