/**
 * Shared GitHub availability health / backoff state for the PR-monitoring extensions
 * (observe-pr, pr-tasks).
 *
 * When `gh` calls fail for GitHub-availability reasons (network timeouts, connection
 * resets, rate limits, expired tokens) the extensions stay silent and pace their
 * retries: every 30 s for the first 5 consecutive failures, then every 10 min until
 * a call succeeds (which resets the state). A single process-wide singleton is
 * shared by both extensions so there is one backoff state and at most one retry
 * burst per slot instead of every timer pile on the API.
 *
 * Error classification (`isGhAvailabilityError`) deliberately excludes per-PR errors
 * (404 / "could not resolve"): a missing PR must not push the shared state into
 * the slow tier.
 */

export interface GhHealthOptions {
	/** Interval between the first fast retries. Default 30_000 ms. */
	fastIntervalMs?: number;
	/** Number of fast retries before switching to the slow interval. Default 5. */
	fastRetries?: number;
	/** Interval used after `fastRetries` consecutive failures. Default 600_000 ms. */
	slowIntervalMs?: number;
	/** Injectable clock (tests). Default Date.now. */
	now?: () => number;
	/** Injectable timer (tests). Default setTimeout. */
	schedule?: (ms: number, fn: () => void) => unknown;
	/** Pairs with `schedule`. Default clearTimeout. */
	unschedule?: (handle: unknown) => void;
}

export class GhHealth {
	readonly fastIntervalMs: number;
	readonly fastRetries: number;
	readonly slowIntervalMs: number;
	private readonly now: () => number;
	private readonly schedule: (ms: number, fn: () => void) => unknown;
	private readonly unschedule: (handle: unknown) => void;

	private failures = 0;
	private lastFailureAt = 0;
	// The current backoff slot has been claimed (work in flight or done)
	private windowUsed = false;
	private inFlight = false;
	// A slot became due while claimed work was still running
	private pendingWhileBusy = false;
	private timer: unknown;
	private recoverHandle: unknown;
	private readonly retryHooks: Set<() => void> = new Set();

	constructor(opts: GhHealthOptions = {}) {
		this.fastIntervalMs = opts.fastIntervalMs ?? 30_000;
		this.fastRetries = opts.fastRetries ?? 5;
		this.slowIntervalMs = opts.slowIntervalMs ?? 600_000;
		this.now = opts.now ?? Date.now;
		this.schedule = opts.schedule ?? ((ms, fn) => setTimeout(fn, ms));
		this.unschedule = opts.unschedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/**
	 * Registers a callback run when a backoff retry slot is due (a timer fires).
	 * Each callback should acquire its own slot, so at most one extension's work
	 * runs per slot. Returns a deregister function.
	 */
	registerRetryHook(hook: () => void): () => void {
		this.retryHooks.add(hook);
		return () => this.retryHooks.delete(hook);
	}

	get status(): "healthy" | "degraded" {
		return this.failures === 0 ? "healthy" : "degraded";
	}

	get consecutiveFailures(): number {
		return this.failures;
	}

	private nextIntervalMs(): number {
		// failures <= fastRetries: the Nth failure schedules the Nth fast retry (30 s);
		// only after all fast retries have failed does the pacing grow to the slow interval.
		return this.failures <= this.fastRetries ? this.fastIntervalMs : this.slowIntervalMs;
	}

	/** Milliseconds until the next retry slot (0 when healthy). */
	nextRetryInMs(): number {
		if (this.failures === 0) return 0;
		return Math.max(0, this.lastFailureAt + this.nextIntervalMs() - this.now());
	}

	/**
	 * Whether the caller may now execute a GitHub operation.
	 *
	 * Healthy: yes, always (pacing comes from the caller's own cadence).
	 * Degraded: only when the backoff slot is due, and only once per slot —
	 * the retry timer's hook, a periodic tick, or a long-lived process spawn
	 * may not all claim the same slot, and a new slot cannot be claimed while
	 * the claimed one is still running.
	 */
	acquireSlot(): boolean {
		if (this.failures === 0) return true;
		if (this.inFlight) {
			if (this.slotDue()) this.pendingWhileBusy = true;
			return false;
		}
		if (!this.slotDue()) return false;
		if (this.windowUsed) return false;
		this.windowUsed = true;
		this.inFlight = true;
		return true;
	}

	/** Pairs with a granted `acquireSlot` (call even when the work failed). */
	release(): void {
		if (!this.inFlight) return;
		this.inFlight = false;
		// The consumed window ends with the holder's work: a holder that recorded
		// neither success nor failure (e.g. a 404-class or no-op call) must not burn
		// the window — the next caller (or the pendingWhileBusy re-fire below) claims it.
		// recordFailure still blocks re-claims via slotDue; recordSuccess via failures===0.
		this.windowUsed = false;
		if (this.pendingWhileBusy) {
			this.pendingWhileBusy = false;
			this.fireHooks();
		}
	}

	private slotDue(): boolean {
		return this.now() - this.lastFailureAt >= this.nextIntervalMs();
	}

	/**
	 * Records a successful GitHub call: resets the backoff state and, on the degraded -> healthy
	 * transition, runs the retry hooks once.
	 *
	 * The hooks are the only driver for work that waited out the outage (a pending observe_pr
	 * auto-start, a pr-tasks reconciliation). They are scheduled by recordFailure alone, so without
	 * this a recovery detected by *some other* call leaves that work stranded until the next failure
	 * schedules a timer - and the promise given to the model ("observation will start automatically
	 * once the connection recovers") would go silently unfulfilled. Deferred one tick, so no hook runs
	 * inside the stack of the call that happened to succeed first.
	 */
	recordSuccess(): void {
		if (this.failures === 0) return;
		this.failures = 0;
		this.lastFailureAt = 0;
		this.windowUsed = false;
		this.pendingWhileBusy = false;
		this.clearTimer();
		this.recoverHandle = this.schedule(0, () => {
			this.recoverHandle = undefined;
			this.fireHooks();
		});
	}

	/** Records a failed GitHub call: paces the next retry. */
	recordFailure(): void {
		this.failures += 1;
		this.lastFailureAt = this.now();
		this.windowUsed = false;
		this.pendingWhileBusy = false;
		this.clearTimer();
		this.timer = this.schedule(this.nextIntervalMs(), () => this.fireHooks());
	}

	/** Clears all pending retry state (e.g. on session shutdown). */
	reset(): void {
		this.failures = 0;
		this.lastFailureAt = 0;
		this.windowUsed = false;
		this.inFlight = false;
		this.pendingWhileBusy = false;
		this.clearTimer();
		if (this.recoverHandle !== undefined) {
			this.unschedule(this.recoverHandle);
			this.recoverHandle = undefined;
		}
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			this.unschedule(this.timer);
			this.timer = undefined;
		}
	}

	private fireHooks(): void {
		// Copy: a hook may register/deregister while iterating
		for (const hook of Array.from(this.retryHooks)) {
			try {
				hook();
			} catch {
				// A hook must never break the others
			}
		}
	}
}

function envMs(name: string): number | undefined {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isNaN(value) || value <= 0 ? undefined : value;
}

/** Process-wide singleton shared by the PR-monitoring extensions. */
export const ghHealth = new GhHealth({
	fastIntervalMs: envMs("PI_GH_HEALTH_FAST_MS"),
	fastRetries: envMs("PI_GH_HEALTH_FAST_RETRIES"),
	slowIntervalMs: envMs("PI_GH_HEALTH_SLOW_MS"),
});

const AVAILABILITY_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"EAI_AGAIN",
	"EAI_FAILED",
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"EPIPE",
	// spawn failure: the gh binary is missing from PATH (a broken environment, not a
	// per-PR error) — pacing it keeps the extensions from respawning at 1 Hz
	"ENOENT",
]);

// Rate limits self-resolve: they must not be classified as auth errors (which
// surface on explicit calls and skip the auto-start)
const RATE_LIMIT_PATTERNS = /rate limit|too many requests|429\b/i;

const AVAILABILITY_PATTERNS =
	/\b(timed? ?out|failed to connect|connection (reset|refused|aborted|closed)|dial tcp|tls handshake|no route to host|network is unreachable|unexpected eof|enoent|context deadline exceeded|unauthorized|authentication failed|token expired|bad credentials|auth login|rate limit|too many requests|http\s?502|http\s?503|http\s?500|http 429)\b/i;

const AUTH_PATTERNS = /(unauthorized|authentication failed|token expired|bad credentials|auth login|\b401\b|\b403\b)/i;

/**
 * Whether a failed `gh` call is an authentication problem (token expired, bad
 * credentials): unlike a network outage it is not self-resolving, so an
 * explicit call should surface it to the user instead of a "temporarily
 * unreachable" note (background calls still pace it through the shared backoff).
 */
export function isGhAuthError(err: unknown): boolean {
	const e = (typeof err === "object" && err !== null ? err : { message: String(err ?? "") }) as {
		code?: unknown;
		stdout?: unknown;
		stderr?: unknown;
		message?: unknown;
	};
	const text = [e.stderr, e.stdout, e.message].filter((v): v is string => typeof v === "string" && v.length > 0).join("\n");
	if (RATE_LIMIT_PATTERNS.test(text)) return false; // a 403 rate limit is self-resolving, not an auth problem
	return AUTH_PATTERNS.test(text);
}

/**
 * Whether a failed `gh` call looks like a GitHub-availability problem (network,
 * rate limit, auth) rather than a per-PR error (404, "could not resolve").
 * Accepts execFile error objects (killed/signal = a call stopped by our own
 * timeout), Node error codes, or raw stderr/stdout/message text.
 */
export function isGhAvailabilityError(err: unknown): boolean {
	const e = (typeof err === "object" && err !== null ? err : { message: String(err ?? "") }) as {
		code?: unknown;
		killed?: boolean;
		signal?: unknown;
		stderr?: unknown;
		stdout?: unknown;
		message?: unknown;
	};
	if (e.killed === true || (typeof e.signal === "string" && e.signal.length > 0)) return true;
	if (typeof e.code === "string" && AVAILABILITY_CODES.has(e.code)) return true;
	const text = [e.stderr, e.stdout, e.message].filter((v): v is string => typeof v === "string" && v.length > 0).join("\n");
	return AVAILABILITY_PATTERNS.test(text);
}
