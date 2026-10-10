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

/**
 * Strip ANSI/ECMA-48 escape sequences:
 * - OSC (window title, hyperlinks, ...): BEL- or ST-terminated
 * - DCS / so- / APC / PM sequences: ST-terminated (or run to the next ESC)
 * - CSI: full ECMA-48 form — parameter bytes 0x30–0x3f (incl. `:`, `<`,
 *   `>`, `=`), intermediate bytes 0x20–0x2f, final byte 0x40–0x7e
 * - charset designations (ESC ( B, ...)
 * - catch-all: any remaining ESC + up to one byte (lone ESC, keypad modes,
 *   RIS, save/restore cursor, ...)
 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\u0007\u009c\u001b]*(?:\u0007|\x1b\\|\u009c)?/g, "")
		.replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\|\u009c)?/g, "")
		.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
		.replace(/\x1b[()][0-9A-Za-z]/g, "")
		.replace(/\x1b.?/g, "");
}

/**
 * Extract a human-readable failure reason from a failed execFile error.
 * Prefers the child's stderr, then stdout (selected on trimmed non-emptiness),
 * parsed as a JSON failure payload when present (`ok: false` with an error
 * object carrying `message`, or a plain string). Falls back to the generic
 * error message; for errors with no stream output at all (internal,
 * non-CLI failures) the stack trace is preserved for debuggability.
 * Output is ANSI-stripped, whitespace-flattened, and truncated.
 */
export function extractCliError(err: unknown): string {
	const e = err as { stderr?: string; stdout?: string; message?: string; stack?: string };
	const stderr = String(e?.stderr ?? "").trim();
	const stdout = String(e?.stdout ?? "").trim();
	const raw = stderr || stdout;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.ok === false) {
				const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
				if (m) {
					return stripAnsi(String(m)).replace(/\s+/g, " ").trim().slice(0, 300);
				}
			}
			// Parseable JSON without a failure payload — don't dump the raw payload.
			return stripAnsi(e?.message || String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
		} catch {}
	}
	if (raw) {
		return stripAnsi(raw).replace(/\s+/g, " ").trim().slice(0, 300);
	}
	// No stream output: keep the stack (flattened) so internal failures stay debuggable.
	const withStack = e?.stack ? `${e.message ?? err}\n${e.stack}` : e?.message || String(err);
	return stripAnsi(withStack).replace(/\s+/g, " ").trim().slice(0, 1000);
}
