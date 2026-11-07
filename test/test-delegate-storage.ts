// Run with: node --test test/test-delegate-storage.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	getEventsLogPath,
	getMetaPath,
	getSessionDir,
	getStatePath,
	getStorageDir,
	LEGACY_STORAGE_ROOT,
	readTextFileWithRetry,
	sessionFileCandidates,
	STORAGE_ROOT,
} from "../extensions/lib/delegate/storage.ts";

test("the storage root moved to the tool family's name", () => {
	assert.strictEqual(STORAGE_ROOT, "delegate_task");
	assert.strictEqual(LEGACY_STORAGE_ROOT, "devin_delegate");
	const dir = getStorageDir("pi-123");
	assert.ok(dir.endsWith(path.join(".pi", "agent", "delegate_task", "pi-123")), dir);
	assert.ok(getSessionDir("pi-123", "sess-1").endsWith(path.join("delegate_task", "pi-123", "sess-1")));
	assert.ok(getEventsLogPath("pi-123", "sess-1").endsWith(path.join("sess-1", "events.jsonl")));
	assert.ok(getMetaPath("pi-123", "sess-1").endsWith(path.join("sess-1", "meta.json")));
	assert.ok(getStatePath("pi-123").endsWith(path.join("pi-123", "state.json")));
});

test("candidates look in the new root first and the pre-rename root last", () => {
	// A session that was running when the rename landed has to still be readable. There is no migration
	// on purpose: moving files under a live session is how a recovery story becomes a data-loss story.
	const c = sessionFileCandidates("pi-1", "sess-1", "meta.json");
	assert.ok(c[0].includes(`/${STORAGE_ROOT}/pi-1/sess-1/meta.json`), `first candidate is the current root: ${c[0]}`);
	assert.ok(
		c[c.length - 1].includes(`/${LEGACY_STORAGE_ROOT}/pi-1/sess-1/meta.json`),
		`last candidate is the legacy root: ${c[c.length - 1]}`,
	);
});

test("a session recorded under another pi session id is searched there too", () => {
	// `sessionDirs` in state.json says where each session's files were written; a resume of a session
	// recorded elsewhere must find them rather than reporting the session as missing.
	const c = sessionFileCandidates("pi-new", "sess-1", "events.jsonl", "pi-old");
	assert.ok(
		c.some((p) => p.includes(`/${STORAGE_ROOT}/pi-old/sess-1/events.jsonl`)),
		c.join(" "),
	);
	assert.ok(
		c.some((p) => p.includes(`/${LEGACY_STORAGE_ROOT}/pi-old/sess-1/events.jsonl`)),
		c.join(" "),
	);
	// No duplicates when the recorded id is the current one.
	const same = sessionFileCandidates("pi-new", "sess-1", "events.jsonl", "pi-new");
	assert.strictEqual(new Set(same).size, same.length);
});

test("readTextFileWithRetry returns the file, and still throws when it is really gone", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-storage-"));
	const file = path.join(dir, "hello.json");
	fs.writeFileSync(file, '{"ok":true}');
	assert.strictEqual(await readTextFileWithRetry(file), '{"ok":true}');
	// The retry costs 150 ms and then reports the ENOENT: the earlier version of this blocked the event
	// loop for that time with Atomics.wait, freezing the TUI on every retried file during session_start.
	await assert.rejects(() => readTextFileWithRetry(path.join(dir, "missing.json")), /ENOENT/);
	fs.rmSync(dir, { recursive: true, force: true });
});
