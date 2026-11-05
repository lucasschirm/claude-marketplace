// The session store (issue #56), tested without agy and without a session: the record, the files, the
// lock, the journal and the listing. The ACP-facing half (`session/load` / `session/resume` /
// `session/list` over a connection) is in test-sessions.ts; what is proved here is the layer below it,
// where the answers to "did my history survive?" are actually decided.
//
// Everything runs against a real temporary directory: the modes, the atomicity and the `O_EXCL` races are
// the subject, and a mock of the filesystem would test the mock.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { UpdateLog, readUpdateLines, sweepTempFiles, writePrivateFileAtomic } from "../src/session-store/files.ts";
import { HoldTable } from "../src/session-store/hold.ts";
import { SessionJournal } from "../src/session-store/journal.ts";
import { acquireLock, lockPath, readLockHolder, releaseLock } from "../src/session-store/lock.ts";
import { resolveStoreRoot, sameWorkspace } from "../src/session-store/paths.ts";
import {
	MAX_TITLE_CHARS,
	MAX_UPDATE_LINE_BYTES,
	STORE_RECORD_VERSION,
	decodeLock,
	decodeMeta,
	decodeUpdateLine,
	encodeLock,
	encodeMeta,
	encodeUpdateLine,
	isSessionId,
	titleFromPrompt,
	type StoredSessionMeta,
} from "../src/session-store/records.ts";
import { SessionStore } from "../src/session-store/store.ts";
import { createSessionRestore } from "../src/session-restore.ts";
import type { AcpSessionUpdate } from "../src/acp.ts";

const dirs: string[] = [];
function tmpDir(prefix = "agy-acp-store-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
process.on("exit", () => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const ID = "23efb3ec-b025-4aee-936f-14863446fe80";
const ID2 = "23efb3ec-b025-4aee-936f-14863446fe81";

function meta(over: Partial<StoredSessionMeta> = {}): StoredSessionMeta {
	return {
		version: STORE_RECORD_VERSION,
		sessionId: ID,
		cwd: "/work/project",
		mode: "default",
		model: "gemini-3.1-pro",
		effort: "high",
		title: "",
		turns: 0,
		createdAtMs: 1700000000000,
		updatedAtMs: 1700000000000,
		...over,
	};
}

const update = (sessionUpdate: string, over: Record<string, unknown> = {}): AcpSessionUpdate =>
	({ sessionUpdate, ...over }) as AcpSessionUpdate;

/** An update's fields, seen as the JSON they are. */
const fields = (u: AcpSessionUpdate): Record<string, unknown> => u as unknown as Record<string, unknown>;

/** The text of a line read back from the log, for asserting on the history. */
function lineText(line: string): string {
	const decoded = decodeUpdateLine(line);
	if (!decoded.ok) throw new Error(`not a stored update (${decoded.reason}): ${line.slice(0, 60)}`);
	return String(fields(decoded.value.update).text ?? "?");
}

const textsOf = (lines: string[]): string[] => lines.filter((l) => l.trim() !== "").map(lineText);

function newStore(rootDir = tmpDir(), over: Record<string, unknown> = {}): { store: SessionStore; root: string; logs: string[] } {
	const logs: string[] = [];
	const store = new SessionStore({
		log: (l) => logs.push(l),
		root: { root: rootDir, source: "test" },
		maxBytes: 4096,
		...over,
	});
	return { store, root: rootDir, logs };
}

// ---------------------------------------------------------------- the store root

test("the store root follows XDG and the override, and never a relative override", () => {
	const home = "/home/operator";
	// The variable is named for agy-acp, so it names agy-acp's own directory: what it says is the root.
	assert.strictEqual(resolveStoreRoot({ AGY_ACP_STATE_DIR: "/tmp/explicit", HOME: home }).root, "/tmp/explicit");
	assert.strictEqual(resolveStoreRoot({ XDG_STATE_HOME: "/state", HOME: home }).root, path.join("/state", "agy-acp"));
	assert.strictEqual(resolveStoreRoot({ HOME: home }).root, path.join(home, ".local", "state", "agy-acp"));
	// A relative override is a directory the server would create wherever the process happens to start,
	// so it is refused with a reason rather than honoured.
	const refused = resolveStoreRoot({ AGY_ACP_STATE_DIR: "state", HOME: home });
	assert.strictEqual(refused.root, path.join(home, ".local", "state", "agy-acp"));
	assert.match(refused.source, /ignored/);
	// XDG wins over the home fallback, which is the whole point of the variable.
	assert.notStrictEqual(resolveStoreRoot({ XDG_STATE_HOME: "/state", HOME: home }).root, resolveStoreRoot({ HOME: home }).root);
	// The home fallback is the process's own home, because that is the home the operator has.
	assert.strictEqual(resolveStoreRoot({}).root, path.join(os.homedir(), ".local", "state", "agy-acp"));
});

test("the store root's source names itself, because an operator has to find the files", () => {
	const { store } = newStore();
	assert.strictEqual(store.rootSource, "test");
	assert.ok(store.unknownReason("abc").includes(store.root), "the unknown-session message names where it looked");
	assert.match(store.unknownReason("abc"), /does not read agy's private storage/);
});

test("workspaces compare by path, and by target when both exist", () => {
	assert.ok(sameWorkspace("/a/b", "/a/b"));
	assert.ok(sameWorkspace("/a/b/", "/a/b"), "a trailing slash is not another workspace");
	assert.ok(!sameWorkspace("/a/b", "/a/c"));
	const real = tmpDir("agy-acp-ws-");
	const link = path.join(path.dirname(real), `link-${path.basename(real)}`);
	fs.symlinkSync(real, link, "dir");
	assert.ok(sameWorkspace(real, link), "a symlinked workspace is the workspace the session belongs to");
	fs.rmSync(link, { force: true });
});

// ---------------------------------------------------------------- the records

test("meta.json round-trips, and refuses anything that is not exactly a record", () => {
	const ok = decodeMeta(encodeMeta(meta()));
	assert.ok(ok.ok);
	assert.deepStrictEqual(ok.value, meta());
	const cases: Array<[string, RegExp]> = [
		["not json", /not JSON/],
		["[]", /not a JSON object/],
		[JSON.stringify({ ...meta(), version: 2 }), /unsupported version/],
		[JSON.stringify({ ...meta(), cwd: "relative/path" }), /cwd/],
		[JSON.stringify({ ...meta(), cwd: "/work/../etc" }), /cwd/],
		[JSON.stringify({ ...meta(), sessionId: "../escape" }), /sessionId/],
		[JSON.stringify({ ...meta(), title: 42 }), /title/],
		[JSON.stringify({ ...meta(), turns: -1 }), /turns/],
		[JSON.stringify({ ...meta(), createdAtMs: "yesterday" }), /createdAtMs/],
	];
	for (const [text, expected] of cases) {
		const decoded = decodeMeta(text);
		assert.ok(!decoded.ok, `expected ${JSON.stringify(text.slice(0, 40))} to be refused`);
		assert.match(decoded.ok ? "" : decoded.reason, expected);
	}
});

test("a session id may be a directory name or may not be", () => {
	for (const good of [ID, "a", "a.b_c-d", "x".repeat(64)]) assert.ok(isSessionId(good), good);
	for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "x".repeat(65), "with space", "néid", 42, null]) {
		assert.ok(!isSessionId(bad), `${String(bad)} must not be a directory name`);
	}
});

test("the title is the first prompt, shortened without splitting a character", () => {
	assert.strictEqual(titleFromPrompt("  fix\nthe store \n please "), "fix the store please");
	const short = titleFromPrompt("a".repeat(MAX_TITLE_CHARS));
	assert.strictEqual(short.length, MAX_TITLE_CHARS);
	const long = titleFromPrompt("👋".repeat(300));
	assert.ok(long.length <= MAX_TITLE_CHARS, `the title stays inside the budget: ${long.length}`);
	assert.ok(long.endsWith("…"));
	assert.ok(!/[\uD800-\uDBFF]$/.test(long.slice(0, -1)), "a surrogate pair is never cut in half");
	assert.strictEqual(titleFromPrompt(""), "");
});

test("an update round-trips, and a monstrous payload is bounded with a note instead of lost", () => {
	const line = encodeUpdateLine(1700000001000, update("tool_call_update", { toolCallId: "t1", content: [{ type: "text", text: "out" }] }));
	const decoded = decodeUpdateLine(line);
	assert.ok(decoded.ok);
	assert.strictEqual(decoded.value.atMs, 1700000001000);
	assert.strictEqual(fields(decoded.value.update).toolCallId, "t1");

	const huge = update("tool_call_update", {
		toolCallId: "t2",
		title: "read a big file",
		content: [{ type: "text", text: "x".repeat(MAX_UPDATE_LINE_BYTES * 2) }],
	});
	const bounded = decodeUpdateLine(encodeUpdateLine(1700000002000, huge));
	assert.ok(bounded.ok, "a bounded line is still a line");
	const kept = bounded.ok ? fields(bounded.value.update) : {};
	assert.strictEqual(kept.toolCallId, "t2", "the identity of the update survives");
	assert.strictEqual(kept.title, "read a big file");
	assert.strictEqual(kept.content, undefined, "the payload does not");
	const note = kept._meta as Record<string, unknown>;
	assert.ok(String(note.storeTruncated).includes("over the"), `the note says what happened: ${JSON.stringify(note)}`);
	const bytes = Buffer.byteLength(encodeUpdateLine(1700000002000, huge), "utf8");
	assert.ok(bytes <= MAX_UPDATE_LINE_BYTES, `a bounded line fits the budget: ${bytes} > ${MAX_UPDATE_LINE_BYTES}`);

	for (const bad of ["", "\n", "{}", '{"update":null}', '{"update":{}}', "[]", "not json"]) {
		assert.ok(!decodeUpdateLine(bad).ok, `${JSON.stringify(bad)} must not decode`);
	}
});

test("the lock body round-trips and rejects a body that names no process", () => {
	const holder = { pid: 4242, host: "box", startedAtMs: 1700000000000 };
	assert.deepStrictEqual(decodeLock(encodeLock(holder)), { ok: true, value: holder });
	for (const bad of [
		"",
		"x",
		"{}",
		encodeLock({ ...holder, pid: 0 }),
		encodeLock({ ...holder, startedAtMs: -1 }),
		'{"pid":1,"host":2,"startedAtMs":3}',
	]) {
		assert.ok(!decodeLock(bad).ok, `${JSON.stringify(bad)} must not decode`);
	}
});

// ---------------------------------------------------------------- the files

test("directories are 0700 and files are 0600, whatever the umask asked for", async () => {
	const root = tmpDir();
	const { store } = newStore(root);
	const created = await store.create({ sessionId: ID, cwd: root, mode: "default", model: "default", effort: "default" });
	assert.ok(created.ok, JSON.stringify(created));
	const mode = (p: string) => fs.statSync(p).mode & 0o777;
	assert.strictEqual(mode(root), 0o700);
	assert.strictEqual(mode(path.join(root, "sessions")), 0o700);
	assert.strictEqual(mode(store.sessionDir(ID)), 0o700);
	assert.strictEqual(mode(path.join(store.sessionDir(ID), "meta.json")), 0o600);
	// And a directory that already existed with looser modes is corrected, not left as it was.
	fs.chmodSync(store.sessionDir(ID), 0o755);
	await store.create({ sessionId: ID, cwd: root, mode: "default", model: "default", effort: "default" });
	assert.strictEqual(mode(store.sessionDir(ID)), 0o700, "an 0755 session directory is tightened");
	await store.release(ID);
});

test("a meta write replaces atomically and leaves no temp file, even when it fails", async () => {
	const dir = tmpDir();
	await writePrivateFileAtomic(dir, "meta.json", encodeMeta(meta()));
	assert.strictEqual(fs.readFileSync(path.join(dir, "meta.json"), "utf8").trim(), encodeMeta(meta()).trim());
	await writePrivateFileAtomic(dir, "meta.json", encodeMeta(meta({ title: "second" })));
	assert.match(fs.readFileSync(path.join(dir, "meta.json"), "utf8"), /"title":"second"/);
	assert.deepStrictEqual(
		fs.readdirSync(dir).filter((f) => f.includes(".tmp-")),
		[],
	);
	// A write into a directory that cannot be written to fails, and says so - it does not half-succeed.
	const readOnly = tmpDir();
	fs.chmodSync(readOnly, 0o500);
	await assert.rejects(() => writePrivateFileAtomic(readOnly, "meta.json", "{}"));
	fs.chmodSync(readOnly, 0o700);
	fs.rmSync(path.join(readOnly, "meta.json"), { force: true });
	// A temp file a crash left behind is swept by the next acquirer.
	fs.writeFileSync(path.join(dir, "meta.json.tmp-999-abc"), "junk");
	await sweepTempFiles(dir);
	assert.deepStrictEqual(
		fs.readdirSync(dir).filter((f) => f.includes(".tmp-")),
		[],
	);
	assert.ok(fs.existsSync(path.join(dir, "meta.json")));
});

test("the update log appends, rotates by size, and is read oldest first", async () => {
	const dir = tmpDir();
	// ~90 bytes a line, 400 of budget: inside it the log must not rotate, past it it must.
	const log = new UpdateLog({ dir, maxBytes: 400, rotations: 1 });
	for (let i = 0; i < 3; i++) await log.append(encodeUpdateLine(i, update("agent_message_chunk", { text: `chunk ${i} padding padding` })));
	assert.strictEqual(await log.rotateIfNeeded(), false, "a log inside its budget does not rotate");
	assert.strictEqual(await log.rotateIfNeeded(), false, "asking twice changes nothing");
	for (let i = 3; i < 12; i++) await log.append(encodeUpdateLine(i, update("agent_message_chunk", { text: `chunk ${i} padding padding` })));
	assert.strictEqual(await log.rotateIfNeeded(), true, "past its budget the log rotates");
	await log.append(encodeUpdateLine(12, update("agent_message_chunk", { text: "chunk 12 padding padding" })));
	await log.sync();
	const files = fs.readdirSync(dir).sort();
	assert.deepStrictEqual(files, ["updates.ndjson", "updates.ndjson.1"], `one generation kept besides the live one: ${files}`);

	const read = await readUpdateLines(dir, 1, 1024 * 1024);
	const texts = textsOf(read.lines);
	assert.strictEqual(texts.length, 13, `every line survives a rotation: ${texts.length}`);
	assert.strictEqual(texts[0], "chunk 0 padding padding", "the oldest line comes back first");
	assert.strictEqual(texts[texts.length - 1], "chunk 12 padding padding");
	assert.ok(!read.truncated);

	// The budget is the reader's, not the writer's: a small budget drops the front of the history.
	const small = await readUpdateLines(dir, 1, 200);
	assert.ok(small.truncated, "a replay over the budget says so");
	const kept = textsOf(small.lines);
	assert.strictEqual(kept[kept.length - 1], "chunk 12 padding padding", "what is dropped is the oldest, never the newest");
	await log.close();

	// A generation past the retained count is deleted, so the state cannot grow without bound.
	const tightDir = tmpDir();
	const tight = new UpdateLog({ dir: tightDir, maxBytes: 1, rotations: 0 });
	await tight.append(encodeUpdateLine(13, update("agent_message_chunk", { text: "x" })));
	assert.strictEqual(await tight.rotateIfNeeded(), true);
	await tight.append(encodeUpdateLine(14, update("agent_message_chunk", { text: "y" })));
	await tight.sync();
	await tight.close();
	const after = fs.readdirSync(tightDir).sort();
	assert.deepStrictEqual(after, ["updates.ndjson"], `nothing past the kept count survives: ${after}`);
	const tail = await readUpdateLines(tightDir, 0, 1024 * 1024);
	const tailTexts = textsOf(tail.lines);
	assert.deepStrictEqual(tailTexts, ["y"], "with no generations kept, only the live file is read");
});

// ---------------------------------------------------------------- the lock

test("a lock is exclusive, names its holder, and comes back when released", async () => {
	const dir = tmpDir();
	const taken = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(taken.acquired, taken.reason);
	assert.strictEqual(taken.holder.pid, process.pid);
	const again = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(!again.acquired, "a second process cannot take a live lock");
	assert.match(again.reason, /holds this session/);
	const seen = await readLockHolder(dir);
	assert.ok(seen.holder);
	assert.strictEqual(seen.holder.pid, process.pid);
	assert.strictEqual(fs.statSync(lockPath(dir)).mode & 0o777, 0o600);
	assert.strictEqual(await releaseLock(dir), null);
	assert.ok((await acquireLock(dir, { staleMs: 60_000 })).acquired, "released means takable again");
});

test("a lock whose holder is dead is taken over; a live one across the network is not", async () => {
	const dir = tmpDir();
	const write = (holder: { pid: number; host: string; startedAtMs: number }) => fs.writeFileSync(lockPath(dir), encodeLock(holder));
	// Another host, young: we cannot read its process table, so we believe it.
	write({ pid: 999999, host: "not-this-box", startedAtMs: Date.now() });
	const refused = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(!refused.acquired, "a fresh lock on another host is held, not assumed dead");
	assert.strictEqual(refused.holder?.host, "not-this-box");
	// The same host, a pid that does not exist: crashed, so the session is openable again.
	write({ pid: 999999, host: os.hostname(), startedAtMs: Date.now() });
	const taken = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(taken.acquired, `a dead holder is taken over: ${taken.reason}`);
	assert.strictEqual(taken.holder.pid, process.pid);
	await releaseLock(dir);
	// Another host, older than the deadline: time is the only evidence there is.
	write({ pid: 999999, host: "not-this-box", startedAtMs: Date.now() - 120_000 });
	const stale = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(stale.acquired, `an old foreign lock is taken over: ${stale.reason}`);
	await releaseLock(dir);
	// A body we cannot read protects nothing: it is removed and the session is taken.
	fs.writeFileSync(lockPath(dir), "half a lock");
	const first = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(first.acquired, `a lock we cannot read is not a lock: ${first.reason}`);
	await releaseLock(dir);
	// A live lock on THIS host is never taken over for being old: a long-lived server is normal.
	write({ pid: process.pid, host: os.hostname(), startedAtMs: Date.now() - 10 * 60_000 });
	const old = await acquireLock(dir, { staleMs: 60_000 });
	assert.ok(!old.acquired, "age alone is not a reason to steal a lock from a live process");
	await releaseLock(dir);
});

test("reading a lock that is not there is an answer, not an error", async () => {
	const seen = await readLockHolder(tmpDir());
	assert.strictEqual(seen.holder, null);
	assert.match(seen.reason, /gone/);
});

test("a lock that cannot be removed is a refusal with a reason, not an exception", async () => {
	const dir = tmpDir();
	// A directory where the lock file belongs: reading it fails, so it looks like a lock worth taking over,
	// and the remove then fails with EISDIR. `force: true` only ignores ENOENT, and the exception used to
	// fly past the caller's whole failure model - on `session/new` that meant a child agy was left running
	// with nothing registered to stop it, and on `session/load` a generic error where the reason was a
	// directory in the wrong place.
	fs.mkdirSync(path.join(dir, "lock"));
	const outcome = await acquireLock(dir, { staleMs: 0, now: () => 0 });
	assert.strictEqual(outcome.acquired, false);
	assert.match(outcome.reason, /could not be removed/);
	assert.strictEqual(outcome.unavailable, true, "a lock we cannot remove is the store's problem, not a holder");

	const { store } = newStore();
	fs.mkdirSync(store.sessionDir(ID), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(store.sessionDir(ID), "lock"));
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(!created.ok, JSON.stringify(created));
	assert.match(!created.ok ? created.reason : "", /could not be removed/);
});

test("two calls in one process cannot take the same conversation", async () => {
	// The claim has to exist before the lock does: `O_EXCL` decides between processes, and between two
	// `session/load` calls in one process it decides nothing useful - the loser would read this process's
	// own live pid out of the lock and be told the session is held elsewhere, by a process that is asking.
	const dir = tmpDir();
	const holds = new HoldTable({ log: () => {}, staleMs: 0 });
	const [first, second] = await Promise.all([holds.acquire(dir), holds.acquire(dir)]);
	const won = [first, second].filter((r) => r.held !== null);
	const lost = [first, second].filter((r) => r.held === null);
	assert.strictEqual(won.length, 1, "exactly one call takes the conversation");
	assert.strictEqual(lost.length, 1);
	assert.strictEqual(lost[0]?.contested, true, "the other is told this process is taking it, not another one");
	await holds.release(dir);
	assert.ok(!fs.existsSync(lockPath(dir)), "the loser left no holder behind");
});

// ---------------------------------------------------------------- the store

test("session/new writes the record, and only one process may hold a conversation", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "acceptEdits", model: "m", effort: "low" });
	assert.ok(created.ok, JSON.stringify(created));
	const onDisk = decodeMeta(fs.readFileSync(path.join(store.sessionDir(ID), "meta.json"), "utf8"));
	assert.ok(onDisk.ok);
	assert.strictEqual(onDisk.value.cwd, "/work");
	assert.strictEqual(onDisk.value.mode, "acceptEdits");
	assert.strictEqual(onDisk.value.turns, 0);
	// The same process asking again is a second run of the same conversation, not a second holder.
	const again = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "m", effort: "low" });
	assert.ok(again.ok, JSON.stringify(again.ok && again));
	assert.strictEqual(
		again.ok ? again.opened.meta.createdAtMs : 0,
		onDisk.ok ? onDisk.value.createdAtMs : 0,
		"the record's age survives a new run",
	);
	// Another process (another store, same root) is refused while the lock is held.
	const other = new SessionStore({ log: () => {}, root: { root: store.root, source: "other" } });
	const refused = await other.open(ID, "/work", false);
	assert.ok(!refused.ok && refused.failure.kind === "locked", JSON.stringify(refused));
	await store.release(ID);
	await store.release(ID);
	const openedAgain = await other.open(ID, "/work", false);
	assert.ok(openedAgain.ok, "with both writers gone the conversation is openable elsewhere");
	await other.release(ID);
});

test("an id agy reported that cannot be a directory name is refused, not written", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: "../escape", cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(!created.ok);
	assert.match(!created.ok ? created.reason : "", /cannot be stored/);
	assert.ok(!fs.existsSync(path.join(store.root, "..", "escape")), "nothing was created outside the store");
});

test("load and resume share the validation and differ only in the history", async () => {
	const root = tmpDir();
	const { store } = newStore(root);
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(created.ok);
	const journal = created.ok ? created.opened.journal : null;
	journal?.record(update("agent_message_chunk", { text: "one" }));
	journal?.record(update("agent_message_chunk", { text: "two" }));
	await journal?.endTurn();
	// A second store is another process: same root, no shared handles.
	const other = new SessionStore({ log: () => {}, root: { root, source: "other" } });
	await store.release(ID);

	const loaded = await other.open(ID, "/work", true);
	assert.ok(loaded.ok, JSON.stringify(loaded));
	assert.deepStrictEqual(
		loaded.ok ? loaded.opened.replay.map((u) => fields(u.update).text) : [],
		["one", "two"],
		"load replays what was recorded, oldest first",
	);
	assert.strictEqual(loaded.ok ? loaded.opened.meta.turns : -1, 1, "the turn count is the store's, not the process's");
	await other.release(ID);

	const resumed = await other.open(ID, "/work", false);
	assert.ok(resumed.ok);
	assert.deepStrictEqual(resumed.ok ? resumed.opened.replay : [1], [], "resume replays nothing");
	await other.release(ID);
});

test("a workspace that does not match the record is refused, and says which one it wanted", async () => {
	const { store } = newStore();
	await store.create({ sessionId: ID, cwd: "/work/one", mode: "default", model: "d", effort: "d" });
	await store.release(ID); // this process holding it is a different answer, and comes first
	const wrong = await store.open(ID, "/work/two", true);
	assert.ok(!wrong.ok && wrong.failure.kind === "cwd-mismatch", JSON.stringify(wrong));
	assert.strictEqual(!wrong.ok ? wrong.failure.recorded : "", "/work/one");
	// A trailing slash is the same workspace (paths.ts decides, once).
	const same = await store.open(ID, "/work/one/", true);
	assert.ok(same.ok, JSON.stringify(same));
	await store.release(ID);
});

test("an unknown id, a corrupt record and a record from another version are all unknown sessions", async () => {
	const { store, logs } = newStore();
	const missing = await store.open(ID, "/work", true);
	assert.ok(!missing.ok && missing.failure.kind === "unknown", JSON.stringify(missing));
	assert.match(!missing.ok ? missing.failure.reason : "", /unknown sessionId/);

	fs.mkdirSync(store.sessionDir(ID2), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(store.sessionDir(ID2), "meta.json"), "{ not json");
	const corrupt = await store.open(ID2, "/work", true);
	assert.ok(!corrupt.ok && corrupt.failure.kind === "unknown", JSON.stringify(corrupt));
	assert.match(!corrupt.ok ? corrupt.failure.reason : "", /not one agy-acp can use/);
	assert.ok(
		logs.some((l) => l.includes("meta.json is unusable")),
		"the store says what it found",
	);

	// A record copied into another session's directory names its own id, and that is a mismatch.
	fs.mkdirSync(store.sessionDir("copied-id"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(store.sessionDir("copied-id"), "meta.json"), encodeMeta(meta()));
	const displaced = await store.readMeta("copied-id");
	assert.ok(displaced !== null && !displaced.ok, JSON.stringify(displaced));
});

test("a session open in this process cannot be loaded beside itself", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(created.ok);
	const twice = await store.open(ID, "/work", true);
	assert.ok(!twice.ok && twice.failure.kind === "open-in-process", JSON.stringify(twice));
	await store.release(ID);
});

test("a torn last line costs that update and nothing else", async () => {
	// A kill between two writes leaves half a line: the reader's job is to lose that and only that.
	const { store } = newStore();
	await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	await store.release(ID);
	const log = new UpdateLog({ dir: store.sessionDir(ID), maxBytes: 1 << 20 });
	await log.append(encodeUpdateLine(1, update("agent_message_chunk", { text: "kept" })));
	await log.append('{"atMs":2,"update":{"sessionUpdate":"agen'); // the crash
	await log.sync();
	await log.close();
	const other = new SessionStore({ log: () => {}, root: { root: store.root, source: "other" } });
	const replay = await other.open(ID, "/work", true);
	await other.release(ID);
	assert.ok(replay.ok, JSON.stringify(replay));
	const texts = replay.ok ? replay.opened.replay.map((u) => fields(u.update).text) : [];
	assert.deepStrictEqual(texts, ["kept"], "the readable history is replayed");
	assert.strictEqual(replay.ok ? replay.opened.droppedLines : 0, 1, "the unreadable line is counted");
	await other.release(ID);
});

test("a store that cannot be written says so, in words that name the store", async () => {
	// The parent is taken away, so the store cannot even be created: a directory we own we could always
	// chmod back to ourselves, and that is not a store failure.
	const parent = tmpDir();
	fs.chmodSync(parent, 0o500);
	const root = path.join(parent, "agy-acp");
	const logs: string[] = [];
	const store = new SessionStore({ log: (l) => logs.push(l), root: { root, source: "test" } });
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(!created.ok, "a read-only store is a refusal, not a session with no history");
	assert.match(!created.ok ? created.reason : "", /permission denied|EACCES/);
	assert.match(!created.ok ? created.reason : "", /store root/, "an operator has to be able to find what to fix");
	assert.ok(!fs.existsSync(store.sessionDir(ID)), "no half-made session directory");
	fs.chmodSync(parent, 0o700);
});

test("a journal that fails writes the turn down without throwing at the session", async () => {
	const dir = tmpDir();
	const logs: string[] = [];
	const journal = new SessionJournal({ dir, meta: meta(), log: (l) => logs.push(l), maxBytes: 1024 });
	await journal.ready(); // the queued setSelection is what would first fail
	fs.chmodSync(dir, 0o500);
	journal.record(update("agent_message_chunk", { text: "lost" }));
	await journal.endTurn();
	assert.ok(journal.degraded, "the failure is recorded");
	assert.ok(
		logs.some((l) => l.includes("could not")),
		logs.join("\n"),
	);
	// And one failure does not make the next turn throw: the session must not die over its transcript.
	await journal.endTurn();
	fs.chmodSync(dir, 0o700);
});

test("the first prompt titles the session, and a later one does not", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(created.ok);
	const journal = created.ok ? created.opened.journal : null;
	journal?.notePrompt("fix the session store\nand write the tests");
	journal?.notePrompt("a second prompt must not rename it");
	journal?.setSelection({ mode: "acceptEdits", model: "m2", effort: "medium" });
	await journal?.endTurn();
	const stored = await store.readMeta(ID);
	if (stored === null || !stored.ok) throw new Error(`the record is missing or unusable: ${JSON.stringify(stored)}`);
	assert.strictEqual(stored.value.title, "fix the session store and write the tests");
	assert.strictEqual(stored.value.mode, "acceptEdits");
	assert.strictEqual(stored.value.effort, "medium");
	assert.strictEqual(stored.value.turns, 1, "endTurn counted the turn");
	await store.release(ID);
});

test("heartbeats are not history", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	assert.ok(created.ok);
	const journal = created.ok ? created.opened.journal : null;
	journal?.record(update("heartbeat", { turn: 1, elapsedMs: 15000 }));
	journal?.record(update("agent_thought_chunk", { text: "thinking" }));
	await journal?.endTurn();
	const lines = await readUpdateLines(store.sessionDir(ID), 1, 1 << 20);
	const kinds = lines.lines
		.filter((l) => l.trim() !== "")
		.map((l) => {
			const decoded = decodeUpdateLine(l);
			return decoded.ok ? fields(decoded.value.update).sessionUpdate : "?";
		});
	assert.deepStrictEqual(kinds, ["agent_thought_chunk"]);
	await store.release(ID);
});

test("a journal proves the record can still be replaced before it claims it is ready", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	if (!created.ok) throw new Error(created.reason);
	assert.strictEqual(await created.opened.journal.ready(), null, "a writable store answers null");
	// An empty queue is not evidence: restoring the selection a record already carries writes nothing, so
	// readiness that only drained would promise a store it had not touched.
	fs.chmodSync(store.sessionDir(ID), 0o500);
	const degraded = await created.opened.journal.ready();
	fs.chmodSync(store.sessionDir(ID), 0o700);
	assert.match(degraded ?? "nothing was reported", /writable|permission denied|EACCES/);
	await store.release(ID);
});

test("a load that fails before the session exists gives the conversation back", async () => {
	const { store } = newStore();
	const created = await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	if (!created.ok) throw new Error(created.reason);
	await store.release(ID);
	const restore = createSessionRestore({
		store,
		registryAdd: () => true,
		send: () => true,
		log: () => {},
		build: () => {
			throw new Error("no session here");
		},
	});
	await assert.rejects(() => restore.load({ sessionId: ID, cwd: "/work" }), /no session here/);
	assert.ok(!fs.existsSync(lockPath(store.sessionDir(ID))), "the lock the store took for the load is not left behind");
	// Openable again, rather than refused here until this process exits and refused everywhere else as
	// held by a pid that was alive the whole time.
	const reopened = await store.open(ID, "/work", false);
	assert.ok(reopened.ok, JSON.stringify(reopened));
	await store.release(ID);
});

// ---------------------------------------------------------------- session/list

test("session/list reports the store: filtered by workspace, newest first, paginated", async () => {
	const root = tmpDir();
	let clock = 1700000000000;
	const { store } = newStore(root, { now: () => clock });
	for (const [id, cwd, at] of [
		[ID, "/work/one", 1700000003000],
		[ID2, "/work/one", 1700000009000],
		["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/work/two", 1700000007000],
	] as const) {
		clock = at;
		const created = await store.create({ sessionId: id, cwd, mode: "default", model: "d", effort: "d" });
		if (!created.ok) throw new Error(`${id}: ${JSON.stringify(created)}`);
		created.opened.journal.notePrompt(`prompt of ${id}`);
		await created.opened.journal.endTurn();
	}
	const all = await store.list({});
	assert.ok(all.ok);
	assert.deepStrictEqual(all.ok ? all.sessions.map((s) => s.sessionId) : [], [ID2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ID]);
	assert.strictEqual(all.ok ? all.sessions[0].title : "", `prompt of ${ID2}`);
	assert.strictEqual(all.ok ? all.sessions[0].turns : 0, 1);
	// In use: this process holds all three right now.
	assert.ok(all.ok && all.sessions.every((s) => s.inUse), "a session this process holds is reported as in use");

	const filtered = await store.list({ cwd: "/work/one" });
	assert.ok(filtered.ok);
	assert.deepStrictEqual(filtered.ok ? filtered.sessions.map((s) => s.sessionId) : [], [ID2, ID]);

	const page1 = await store.list({ limit: 1 });
	assert.ok(page1.ok);
	assert.strictEqual(page1.ok ? page1.sessions.length : 0, 1);
	const cursor = page1.ok ? page1.nextCursor : null;
	assert.ok(cursor, "a page that is not the end carries a cursor");
	const page2 = await store.list({ limit: 1, cursor: cursor ?? undefined });
	assert.ok(page2.ok, JSON.stringify(page2));
	assert.strictEqual(page2.ok ? page2.sessions[0].sessionId : "", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	const page3 = await store.list({ limit: 1, cursor: page2.ok ? (page2.nextCursor ?? undefined) : undefined });
	assert.ok(page3.ok);
	assert.strictEqual(page3.ok ? page3.sessions[0].sessionId : "", ID);
	assert.strictEqual(page3.ok ? page3.nextCursor : "x", null, "the last page carries no cursor");

	const bad = await store.list({ cursor: "not-a-cursor" });
	assert.ok(!bad.ok, "an unreadable cursor is refused, not silently restarted");
	await store.release(ID);
	await store.release(ID2);
	await store.release("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("session/list survives a corrupt record and counts it", async () => {
	const { store } = newStore();
	await store.create({ sessionId: ID, cwd: "/work", mode: "default", model: "d", effort: "d" });
	fs.mkdirSync(store.sessionDir("corrupt-one"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(store.sessionDir("corrupt-one"), "meta.json"), "42");
	fs.mkdirSync(store.sessionDir("not-a-session-dir-name-with-dots"), { recursive: true, mode: 0o700 });
	const list = await store.list({});
	assert.ok(list.ok, JSON.stringify(list));
	assert.deepStrictEqual(list.ok ? list.sessions.map((s) => s.sessionId) : [], [ID], "the good session is still listed");
	assert.strictEqual(list.ok ? list.unusable : 0, 1, "the corrupt one is counted, not hidden");
	await store.release(ID);
});

test("a session that takes a turn between two pages repeats nothing and skips nothing", async () => {
	const root = tmpDir();
	let clock = 1700000000000;
	const { store } = newStore(root, { now: () => clock });
	const journals: Record<string, SessionJournal> = {};
	for (const [id, at] of [
		[ID, 3000],
		[ID2, 2000],
		["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1000],
	] as const) {
		clock = 1700000000000 + at;
		const created = await store.create({ sessionId: id, cwd: "/work", mode: "default", model: "d", effort: "d" });
		if (!created.ok) throw new Error(created.reason);
		journals[id] = created.opened.journal;
	}
	const page1 = await store.list({ limit: 2 });
	assert.ok(page1.ok);
	assert.deepStrictEqual(page1.ok ? page1.sessions.map((s) => s.sessionId) : [], [ID, ID2]);
	const cursor = page1.ok ? page1.nextCursor : null;
	assert.ok(cursor, "a page that is not the end carries a cursor");

	// The conversation the cursor names is now the newest in the store. A page boundary read off where that
	// conversation happens to sit now would pull its old neighbour into page two; a boundary read off the
	// key the client was shown cannot.
	clock = 1700000900000;
	await journals[ID2].endTurn();

	const page2 = await store.list({ limit: 2, cursor: cursor ?? undefined });
	assert.ok(page2.ok, JSON.stringify(page2));
	const seen = [...(page1.ok ? page1.sessions : []), ...(page2.ok ? page2.sessions : [])].map((s) => s.sessionId);
	assert.strictEqual(new Set(seen).size, 3, `no conversation twice and none missing: ${seen.join(", ")}`);
	assert.ok(seen.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "the oldest is still reachable");
	for (const id of [ID, ID2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) await store.release(id);
});
