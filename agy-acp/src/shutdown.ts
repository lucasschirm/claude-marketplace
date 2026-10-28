// How agy-acp leaves the process. Three triggers end a session server: the client closing stdin
// (ACP's hang-up), a signal (SIGTERM/SIGINT/SIGHUP), and nothing else - so all three run one
// path: cancel every turn, deny every pending permission request, dispose every child as sub-issue
// 2 does, remove the bridge dirs, and only then exit.
//
// Two properties this file owns:
//   - nothing is left behind: the exit waits for the cleanup, so no agy child outlives us;
//   - nothing hangs: the cleanup has a hard deadline, and past it the process exits anyway with
//     the leftovers named in the log. A wedged child must never turn "the client hung up" into a
//     process that has to be SIGKILLed by hand.
//
// stdout is the protocol channel and writes to a pipe are asynchronous, so the exit drains it
// first (bounded, see flush-stdout.ts): a response that never reaches the client is a hung prompt
// with a different name.

import { flushStdout } from "./flush-stdout.ts";

/** The exit code when the cleanup finished inside the deadline. */
export const EXIT_CLEAN = 0;
/** The exit code when the deadline forced the exit or the cleanup itself failed. */
export const EXIT_FORCED = 1;
/** The signals that mean "leave now, but leave nothing behind". */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export interface ShutdownOptions {
	log: (line: string) => void;
	/** Everything that must finish before the process may exit (cancel, dispose, remove bridge dirs). */
	cleanup: () => Promise<void>;
	/** The hard deadline for `cleanup`; 0 disables it (the cleanup alone decides when we exit). */
	timeoutMs: number;
	/** Flushes the protocol channel; the default drains `process.stdout`, bounded. */
	flush?: () => Promise<void>;
	/** The exit itself (tests inject a recorder; the default ends this process). */
	exit?: (code: number) => void;
}

export interface Shutdown {
	/** Runs the exit path. Idempotent: a second trigger joins the first run instead of racing it. */
	begin: (reason: string) => Promise<void>;
	/** Installs the signal handlers; returns the uninstall. A signal during the shutdown forces it. */
	installSignals: (signals?: readonly NodeJS.Signals[]) => () => void;
}

export function createShutdown(options: ShutdownOptions): Shutdown {
	const log = options.log;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const flush = options.flush ?? (() => flushStdout());
	let running: Promise<void> | null = null;

	const run = async (reason: string): Promise<void> => {
		const started = Date.now();
		log(`shutdown: ${reason} - cancelling turns, denying pending requests, disposing children`);
		let forced = false;
		let timer: NodeJS.Timeout | null = null;
		const doing = options.cleanup().catch((err: Error) => {
			forced = true;
			log(`shutdown: cleanup failed: ${err.message}`);
		});
		// The deadline races the cleanup instead of watching it: a cleanup that never resolves (the
		// wedged child this path exists for) must not hold the process past the deadline. The timer is
		// ref'd on purpose - it is what keeps the loop alive until the deadline says otherwise.
		const done = doing.then(() => "done" as const);
		const outcome =
			options.timeoutMs > 0
				? await Promise.race([
						done,
						new Promise<"timeout">((resolve) => {
							timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
						}),
					])
				: await done;
		if (timer) clearTimeout(timer);
		if (outcome === "timeout") {
			forced = true;
			log(
				`shutdown: cleanup still unfinished at ${options.timeoutMs} ms - exiting anyway. Whatever it had not reached (agy children, bridge dirs) is an orphan now; the next start sweeps the dirs.`,
			);
		} else if (!forced) {
			log(`shutdown: cleanup finished in ${Date.now() - started} ms`);
		}
		await flush();
		exit(forced ? EXIT_FORCED : EXIT_CLEAN);
	};

	const begin = (reason: string): Promise<void> => {
		if (!running) running = run(reason);
		return running;
	};

	return {
		begin,
		installSignals: (signals: readonly NodeJS.Signals[] = SHUTDOWN_SIGNALS) => {
			const handlers = new Map<NodeJS.Signals, () => void>();
			for (const signal of signals) {
				const handler = (): void => {
					if (running) {
						// A second signal says "stop being polite": leave now, leftovers in the log.
						log(`shutdown: ${signal} during the shutdown - exiting immediately`);
						exit(EXIT_FORCED);
						return;
					}
					void begin(signal);
				};
				handlers.set(signal, handler);
				process.on(signal, handler);
			}
			return () => {
				for (const [signal, handler] of handlers) process.off(signal, handler);
				handlers.clear();
			};
		},
	};
}
