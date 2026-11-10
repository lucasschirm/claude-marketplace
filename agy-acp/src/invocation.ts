// How this process was invoked, and how the bridge's hooks.json must start the hook.
//
// Two ways to run agy-acp: as the plain script (Node >= 23.6 runs the .ts sources directly), or as
// a Node single executable (SEA). The only difference that matters here is the hook: in script mode
// the hook is the file `bridge-hook.ts` next to the entry, and in SEA mode there is no such file
// on disk - the binary re-executes itself in hook mode (`<binary> --bridge-hook`), which is why the
// SEA ships no second file and no Node dependency.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface HookInvocation {
	/** The executable that runs the hook (our own binary, in both modes). */
	node: string;
	/** The hook script to run (script mode); absent when the binary re-executes itself. */
	hookFile?: string;
	/** Extra argv for the hook (the `--bridge-hook` flag in SEA mode). */
	hookArgs: string[];
}

/**
 * The direct-run check (a library import must not start the server). `entryUrl` is the entry
 * module's URL (main.ts's `import.meta.url`); it is undefined in the SEA's CJS module, which is
 * how the SEA is told apart from a plain import: the binary is always run directly. The same
 * read applies to a program that `require`s the CJS bundle: it starts the server in its own
 * process - the bundle is a build intermediate, not a supported import target.
 */
export function isDirectRun(entryUrl: string | undefined): boolean {
	const invoked = process.argv[1];
	if (!invoked) return false;
	try {
		return fs.realpathSync(invoked) === fileURLToPath(entryUrl ?? "");
	} catch {
		try {
			return path.resolve(invoked) === fileURLToPath(entryUrl ?? "");
		} catch {
			// entryUrl is undefined (the SEA's CJS module): the binary is always run directly
			return true;
		}
	}
}

/**
 * The hook's default invocation: the bundled `bridge-hook.ts` (script mode) or the program's own
 * `--bridge-hook` (SEA mode, where the hook file is not on disk either). The re-exec target is
 * `process.execPath`: in a real SEA that is the resolved binary path in every invocation form
 * (absolute, relative, PATH lookup, symlink). `argv[1]` cannot be used - it is the raw
 * invocation string, so under a PATH lookup it is just the bare name, and resolving it against
 * the working directory names a path that does not exist (a hooks.json written for it kills the
 * bridge). `node <binary>` is not a runnable form (the ELF does not parse), so the `node`
 * interpreter in `execPath` is never a misread here.
 */
export function defaultHookInvocation(): HookInvocation {
	const hookFile = scriptHookFile();
	if (hookFile !== null) return { node: process.execPath, hookFile, hookArgs: [] };
	return { node: process.execPath, hookArgs: ["--bridge-hook"] };
}

/** The shipped hook file: the one next to the sources. Null when it is not a real file (SEA). */
export function scriptHookFile(): string | null {
	try {
		const p = fileURLToPath(new URL("./bridge-hook.ts", import.meta.url));
		return fs.existsSync(p) ? p : null;
	} catch {
		return null;
	}
}
