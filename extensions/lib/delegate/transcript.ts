// Reading a session's transcript back off disk.
//
// The transcript is the product: `delegate_status` and `delegate_message` are useful only if the caller
// can see what the agent said, and the agent's process may be gone by the time they ask. So it is read
// from the JSONL log rather than from memory, and the two functions here differ in exactly one way that
// matters — one reads a tail window, the other reads everything.
//
// A tail read is bounded on purpose: a session log can be hundreds of megabytes, and "the last three
// messages" must not cost a full read. That means the first line of a window is likely to be a fragment,
// which is dropped rather than parsed; a dropped fragment is a missing older message, never a corrupt
// recent one.
//
// Labels come from the driver's title, so a Claude session says `[Claude]`. Before the rename every line
// said `[Devin]` regardless of what had answered, which is the kind of thing that stops being funny the
// first time two agents work in the same repository.

import * as fs from "node:fs";
import { findAgent } from "./registry.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { getEventsLogPath, LEGACY_STORAGE_ROOT, STORAGE_ROOT } from "./storage.ts";
import type { SessionMeta } from "./types.ts";

/** Tail window: enough to cover a few long messages without reading a whole session log. */
const TAIL_BYTES = 64 * 1024;

/** `[Devin]` / `[Claude]` — the driver's own name for itself, with a fallback that never throws. */
function speaker(meta: SessionMeta): string {
	const found = findAgent(meta.agent);
	return found.ok ? found.driver.title : meta.agent;
}

/** Every place this session's log could be, newest root first (a session may predate the rename). */
export function eventLogCandidates(rt: DelegateRuntime, meta: SessionMeta): string[] {
	const ids = [rt.currentPiSessionId];
	const recorded = rt.sessionDirs.get(meta.sessionId);
	if (recorded && recorded !== rt.currentPiSessionId) {
		ids.push(recorded);
	}
	const out: string[] = [];
	for (const root of [STORAGE_ROOT, LEGACY_STORAGE_ROOT]) {
		for (const id of ids) {
			out.push(getEventsLogPath(id, meta.sessionId, root));
		}
	}
	return [...new Set(out)];
}

function resolveEventLog(rt: DelegateRuntime, meta: SessionMeta): string | undefined {
	for (const p of eventLogCandidates(rt, meta)) {
		try {
			if (fs.existsSync(p)) {
				return p;
			}
		} catch {
			/* unreadable directory: try the next candidate */
		}
	}
	return undefined;
}

/** One log line as display text, or undefined for a line worth nothing (unknown type, fragment). */
function describeEntry(obj: any, speakerLabel: string): string | undefined {
	if (!obj || typeof obj !== "object") {
		return undefined;
	}
	const text = typeof obj.data?.text === "string" ? obj.data.text.trim() : "";
	switch (obj.type) {
		case "assistant_message":
			return text ? `[${speakerLabel}]: ${text}` : undefined;
		case "thought_message":
			return text ? `[reasoning]: ${text}` : undefined;
		case "user_message":
			return text ? `[user]: ${text}` : undefined;
		case "tool_call": {
			// A tool title is text the agent chose. Collapsing runs of whitespace and control characters keeps
			// one record on one line, which is the whole contract of this format: a title containing `\n[user]: …`
			// would otherwise arrive as a line of the transcript that nobody wrote, and the reader has no way to
			// tell. Quoted like a permission command would be clearer still, but the line format is also the on-disk
			// format of logs written before this existed, and those still have to read back.
			const label = oneLine(obj.data?.title || obj.data?.status);
			return label ? `[tool]: ${label}` : undefined;
		}
		case "usage_update":
			return `[usage]: ${obj.data?.tokens?.total ?? "?"} tokens`;
		case "error":
			return `[error]: ${JSON.stringify(obj.data ?? {})}`;
		// A frame the reader could not decode leaves a hole here, and a hole nobody can see is how a session
		// looks like it stopped mid-sentence for no reason: the fault is as reportable as the text missing.
		case "framing_problem":
			return `[framing]: ${oneLine(obj.data?.reason) || "a frame could not be read"}`;
		default:
			return undefined;
	}
}

/** The last `count` transcript lines, oldest first. */
export function readLastMessages(rt: DelegateRuntime, meta: SessionMeta, count = 3): string[] {
	const file = resolveEventLog(rt, meta);
	if (!file) {
		return [`(Session initialized: "${clip(meta.prompt)}")`];
	}
	let chunk: string;
	try {
		const stat = fs.statSync(file);
		if (stat.size === 0) {
			return [`(Initial prompt: "${clip(meta.prompt)}")`];
		}
		const size = Math.min(stat.size, TAIL_BYTES);
		const buffer = Buffer.alloc(size);
		const fd = fs.openSync(file, "r");
		try {
			// Reading from `size - N` starts mid-line whenever N < the file size; the loop below
			// tolerates the fragment because `JSON.parse` failing on it is the check for it.
			fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
		} finally {
			fs.closeSync(fd);
		}
		chunk = buffer.toString("utf-8");
	} catch {
		return [`(Error reading log for ${meta.sessionId})`];
	}

	const speakerLabel = speaker(meta);
	const out: string[] = [];
	const lines = chunk.split("\n");
	for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
		let obj: any;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const line = describeEntry(obj, speakerLabel);
		if (!line) {
			continue;
		}
		out.unshift(line);
	}
	if (out.length === 0) {
		out.push(`(Initial prompt: "${clip(meta.prompt)}")`);
	}
	return out;
}

/** The whole transcript, assistant/user/error only — tool and usage noise is the tail view's job. */
export function readFullTranscript(rt: DelegateRuntime, meta: SessionMeta): string {
	const file = resolveEventLog(rt, meta);
	if (!file) {
		return `No transcript logged yet for session ${meta.sessionId}. Initial prompt: "${meta.prompt}"`;
	}
	// Bounded on purpose. The whole design says a transcript lives on disk and never in RAM; reading one
	// `readFileSync` of the whole file breaks that promise the moment a long-running session's log grows into
	// the hundreds of megabytes, and the result is a tool result no model can read either. So: read at most
	// the last few megabytes (line-aligned), and return at most a bounded tail, saying what was skipped.
	let content = "";
	let skippedBytes = 0;
	try {
		const size = fs.statSync(file).size;
		const fd = fs.openSync(file, "r");
		try {
			skippedBytes = Math.max(0, size - FULL_READ_MAX_BYTES);
			const length = size - skippedBytes;
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, skippedBytes);
			content = buffer.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
		// A slice that starts mid-line parses as nothing; drop the fragment so the first line shown is real.
		if (skippedBytes > 0) {
			const firstBreak = content.indexOf("\n");
			content = firstBreak >= 0 ? content.slice(firstBreak + 1) : "";
		}
	} catch (err: any) {
		return `Failed to read transcript for ${meta.sessionId}: ${err?.message ?? String(err)}`;
	}
	const speakerLabel = speaker(meta);
	const entries: string[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const text = typeof obj?.data?.text === "string" ? obj.data.text.trim() : "";
		if (obj?.type === "assistant_message" && text) {
			entries.push(`[${obj.timestamp}] ${speakerLabel}: ${text}`);
		} else if (obj?.type === "user_message" && text) {
			entries.push(`[${obj.timestamp}] User: ${text}`);
		} else if (obj?.type === "error") {
			entries.push(`[${obj.timestamp}] Error: ${JSON.stringify(obj.data ?? {})}`);
		}
	}
	const body = entries.join("\n\n");
	if (!body) {
		return `Initial prompt: "${meta.prompt}" (no assistant turns logged)`;
	}
	const head =
		skippedBytes > 0 ? `… ${skippedBytes} bytes of earlier transcript skipped; showing the last ${FULL_READ_MAX_BYTES} bytes …\n\n` : "";
	return (
		head +
		(body.length > FULL_OUTPUT_MAX_CHARS
			? `${head ? "" : "… earlier transcript trimmed …\n\n"}${body.slice(-FULL_OUTPUT_MAX_CHARS)}`
			: body)
	);
}

/**
 * Agent-chosen text, flattened to one bounded line. Control characters go as well as newlines: a terminal
 * interprets those, and a transcript line that carries its own cursor moves is a line that formats itself.
 */
function oneLine(value: unknown, max = 300): string {
	const text = String(value ?? "")
		.replace(/[\p{C}\s]+/gu, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** How much of a transcript is read into memory for `full: true` — and how much of it the caller sees. */
const FULL_READ_MAX_BYTES = 4 * 1024 * 1024;
const FULL_OUTPUT_MAX_CHARS = 40_000;

function clip(text: string): string {
	return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}
