/**
 * Diagnostics helpers shared by the devin-delegate extension.
 *
 * - `stripAnsi`: child-process output must never be surfaced (TUI toasts,
 *   tool results, log lines) with escape sequences that would corrupt the
 *   terminal render.
 * - `extractCliError`: orca (and similar CLIs) report failures as
 *   `{"ok": false, "error": {"message": ...}}` on stdout and exit non-zero.
 *   A failed `execFile` then rejects with only a generic
 *   "Command failed: ..." message; this recovers the real error.
 */

/** Strip ANSI escape sequences (CSI, OSC, charset designations). */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\x1b\][^\u0007\u009c\u001b]*(?:\u0007|\x1b\\|\u009c)?/g, "")
		.replace(/\x1b[()][0-9A-Za-z]/g, "");
}

/**
 * Extract a human-readable failure reason from a failed execFile error.
 * Prefers the child's stderr, then stdout (parsed as a JSON failure payload
 * when present), then the generic error message. Output is ANSI-stripped,
 * whitespace-flattened, and truncated.
 */
export function extractCliError(err: unknown): string {
	const e = err as { stderr?: string; stdout?: string; message?: string };
	const raw = String(e?.stderr || e?.stdout || "").trim();
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.ok === false && parsed.error?.message) {
				return stripAnsi(String(parsed.error.message)).replace(/\s+/g, " ").trim().slice(0, 300);
			}
			// Parseable JSON without a failure payload — don't dump the raw payload.
			return stripAnsi(e?.message || String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
		} catch {}
	}
	return stripAnsi(raw || e?.message || String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
}
