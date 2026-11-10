// How the suites spawn the server and the hook. By default: `node <script>` (script mode). With
// AGY_ACP_TEST_BIN set (a built SEA binary, `cd agy-acp && npm run build:sea`), the suites run
// the binary itself: the server is the binary without extra args, the hook is the binary re-
// executed with `--bridge-hook` (issue #58's acceptance: the component suite and the hook tests
// must pass against the single executable, with the fake agy).
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** The binary to spawn, or undefined for script mode. */
export const BIN = process.env.AGY_ACP_TEST_BIN?.trim() || undefined;
export const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "bridge-hook.ts");

/** How the suites spawn the server: [executable, argv]. */
export function serverSpawnArgs(extra: string[] = []): [string, string[]] {
	return BIN ? [BIN, extra] : [process.execPath, [MAIN, ...extra]];
}

/** How the suites spawn the hook: [executable, argv]. */
export function hookSpawnArgs(): [string, string[]] {
	return BIN ? [BIN, ["--bridge-hook"]] : [process.execPath, [HOOK]];
}

/** How the suites' bridge layouts name the hook (the SEA layout has no hook file, only the flag). */
export function layoutInvocation(): { node: string; hookFile?: string; hookArgs?: string[] } {
	return BIN ? { node: BIN, hookArgs: ["--bridge-hook"] } : { node: process.execPath, hookFile: HOOK };
}

/**
 * The SEA prints Node's "Single executable application is an experimental feature" warning to stderr
 * on every start - a runtime property, not an agy-acp diagnostic. Tests that assert on stderr strip
 * it (and nothing else) so script mode and binary mode see the same surface.
 */
export function stripSeaWarning(stderr: string): string {
	return stderr
		.split("\n")
		.filter((l) => !/ExperimentalWarning: Single executable application|\(Use .* --trace-warnings.*\)/.test(l))
		.join("\n")
		.trim();
}
