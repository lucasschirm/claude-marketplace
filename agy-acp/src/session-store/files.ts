// The filesystem of agy-acp's own session store (issue #56): private directories, an atomic
// `meta.json`, and an append-only `updates.ndjson` that is fsynced at turn end and rotated on size.
//
// Three rules run through this file, one per requirement in lucasschirm/claude-marketplace#56.
//
// **0700 dirs, 0600 files.** `mkdir`'s mode is masked by the process umask and says nothing about a
// directory that already existed, so every directory we create is chmodded afterwards, and every file
// is opened `wx` with its mode rather than written with defaults. The store holds a transcript of
// somebody's work in a directory named after a conversation, under a state root the operator did not
// choose for us; it is not a place to be relaxed about group bits.
//
// **`meta.json` is replaced atomically.** Write a sibling, fsync it, rename over the target. A reader
// therefore sees the old file or the new one, never a half-written object, and a crash mid-write
// costs the temp file (which the next write sweeps) instead of the record. The directory is fsynced
// too, best effort, because a rename is only durable when the directory entry is.
//
// **The update log is append-only and fsynced at turn end.** Appends go to one open handle; the
// fsync happens when a turn ends, which is the point at which "this turn is saved" is a true
// statement about a crash of *our* process (a machine crash can still cost the tail of the turn that
// was in flight - the alternative is a blocking fsync per token, and a session emits thousands).
// Rotation shifts whole files by name, so an append never races a partial rewrite: the current file
// is renamed to its generation and a fresh current file is opened for the next append.

import * as fs from "node:fs";
import * as path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const META_FILE = "meta.json";
export const UPDATES_FILE = "updates.ndjson";
export const LOCK_FILE = "lock";
/** Generation suffixes of `updates.ndjson` kept after the live one (so N+1 files in total). */
export const UPDATE_ROTATIONS = 1;

export const updateFileName = (generation: number): string => (generation === 0 ? UPDATES_FILE : `${UPDATES_FILE}.${generation}`);

/** `mkdir -p`, then 0700 on the directories this server owns (never on an XDG base it did not make). */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: DIR_MODE });
	await fs.promises.chmod(dir, DIR_MODE);
}

/** Durably replace one file inside `dir` (temp file, fsync, rename, fsync the directory). */
export async function writePrivateFileAtomic(dir: string, name: string, text: string): Promise<void> {
	const target = path.join(dir, name);
	const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const handle = await fs.promises.open(tmp, "wx", FILE_MODE);
	try {
		await handle.write(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.promises.rename(tmp, target);
	} catch (err) {
		// The rename is the commit; before it the temp file is ours to remove, or a failed write
		// would litter a 0700 directory with near-duplicates of the record.
		await fs.promises.rm(tmp, { force: true });
		throw err;
	}
	await syncDir(dir);
}

/** Best-effort directory fsync: it is what makes the rename durable, and unsupported where it is not. */
async function syncDir(dir: string): Promise<void> {
	let handle: fs.promises.FileHandle | null = null;
	try {
		handle = await fs.promises.open(dir, "r");
		await handle.sync();
	} catch {
		// ENOENT/EINVAL/EPERM on directories-not-fsyncable: the file itself is durable, the entry
		// may not survive a whole-machine crash. That is a smaller loss than refusing the write.
	} finally {
		await handle?.close();
	}
}

/** A file that may simply not be there. Anything else (EACCES, EISDIR) is the caller's to report. */
export async function readFileOrNull(file: string): Promise<string | null> {
	try {
		return await fs.promises.readFile(file, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return null;
		}
		throw err;
	}
}

/** Sweep the temp files an interrupted atomic write left behind (best effort). */
export async function sweepTempFiles(dir: string): Promise<void> {
	try {
		for (const entry of await fs.promises.readdir(dir)) {
			if (entry.includes(".tmp-")) {
				await fs.promises.rm(path.join(dir, entry), { force: true });
			}
		}
	} catch {
		// A directory we cannot list is a directory we cannot sweep; the next write tries again.
	}
}

export interface UpdateLogOptions {
	dir: string;
	/** Rotate once the live file passes this many bytes. */
	maxBytes: number;
	/** Generations to keep behind the live file (`UPDATE_ROTATIONS` by default). */
	rotations?: number;
}

/**
 * One session's `updates.ndjson`, held open for appending.
 *
 * Writes are serialized by the caller (the journal), so this class assumes exactly one writer and is
 * responsible only for where the bytes go: the live file, and - when it passes `maxBytes` - the
 * generations behind it. `sync()` is the turn-end fsync; `rotateIfNeeded()` runs at the same point,
 * when nothing is in flight.
 */
export class UpdateLog {
	private readonly dir: string;
	private readonly maxBytes: number;
	private readonly rotations: number;
	private handle: fs.promises.FileHandle | null = null;
	private bytes = 0;

	constructor(options: UpdateLogOptions) {
		this.dir = options.dir;
		this.maxBytes = options.maxBytes;
		this.rotations = options.rotations ?? UPDATE_ROTATIONS;
	}

	private get livePath(): string {
		return path.join(this.dir, updateFileName(0));
	}

	private async openForAppend(): Promise<fs.promises.FileHandle> {
		if (this.handle) {
			return this.handle;
		}
		const handle = await fs.promises.open(this.livePath, "a", FILE_MODE);
		try {
			await handle.chmod(FILE_MODE); // only the first creation gets the mode from `open`
			const stat = await handle.stat();
			this.bytes = stat.size;
		} catch (err) {
			await handle.close();
			this.handle = null;
			throw err;
		}
		this.handle = handle;
		return handle;
	}

	/** Append one encoded line (the caller keeps the write order). */
	async append(line: string): Promise<void> {
		const handle = await this.openForAppend();
		// `write` on a handle opened with "a": the kernel does the append, so a line cannot land in the
		// middle of another process's, and there is no read-modify-write of the whole log.
		await handle.write(line);
		this.bytes += Buffer.byteLength(line, "utf8");
	}

	/** The turn-end fsync: everything appended so far is out of this process's reach and into the disk. */
	async sync(): Promise<void> {
		if (this.handle) {
			await this.handle.sync();
		}
	}

	/** Has the live file outgrown its budget? Checked at turn end, before the next append. */
	needsRotation(): boolean {
		return this.bytes > this.maxBytes;
	}

	/**
	 * Shift the generations by one (dropping the oldest) and start a fresh live file.
	 *
	 * The fsync before the shift is the point: a rename is only worth doing once what it protects is
	 * on disk, otherwise rotating can *lose* bytes that a non-rotating crash would have kept.
	 */
	async rotateIfNeeded(): Promise<boolean> {
		if (!this.needsRotation()) {
			return false;
		}
		await this.sync();
		if (this.handle) {
			await this.handle.close();
			this.handle = null;
		}
		const keep = Math.max(0, this.rotations);
		await fs.promises.rm(path.join(this.dir, updateFileName(keep)), { force: true });
		for (let gen = keep - 1; gen >= 1; gen--) {
			await fs.promises
				.rename(path.join(this.dir, updateFileName(gen)), path.join(this.dir, updateFileName(gen + 1)))
				.catch((err: NodeJS.ErrnoException) => {
					if (err.code !== "ENOENT") {
						throw err;
					}
				});
		}
		await fs.promises.rename(this.livePath, path.join(this.dir, updateFileName(1))).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== "ENOENT") {
				throw err;
			}
		});
		await syncDir(this.dir);
		this.bytes = 0;
		return true;
	}

	async close(): Promise<void> {
		const handle = this.handle;
		this.handle = null;
		if (!handle) {
			return;
		}
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}

/**
 * Every stored update of one session, oldest first: the oldest generation to the live file.
 *
 * A torn tail (a crash between two appends, or a read of a file being written by another process)
 * costs that one line: the caller counts what it could not decode and replays the rest. The whole
 * read is capped, so a store that has grown past its budget cannot make a `session/load` allocate
 * without bound.
 */
export async function readUpdateLines(dir: string, rotations: number, capBytes: number): Promise<{ lines: string[]; truncated: boolean }> {
	// Newest generation first, so a budget gives up the OLDEST history and never the newest - which is
	// the half a client is loading a session to see. The generations are reversed back at the end.
	const taken: string[][] = [];
	let budget = capBytes;
	let truncated = false;
	for (let gen = 0; gen <= Math.max(0, rotations) && !truncated; gen++) {
		const text = await readFileOrNull(path.join(dir, updateFileName(gen)));
		if (text === null) {
			continue;
		}
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes > budget) {
			truncated = true;
			const buf = Buffer.from(text, "utf8").subarray(Math.max(0, bytes - budget));
			const firstBreak = buf.indexOf(10); // a partial first line is not history, it is a cut
			if (firstBreak >= 0) {
				taken.push(
					buf
						.subarray(firstBreak + 1)
						.toString("utf8")
						.split("\n"),
				);
			}
			break;
		}
		budget -= bytes;
		taken.push(text.split("\n"));
	}
	return { lines: taken.reverse().flat(), truncated };
}

/** The ids of every session directory the store holds (anything else in the root is not ours). */
export async function listSessionDirs(root: string, isSessionDirName: (name: string) => boolean): Promise<string[]> {
	try {
		const entries = await fs.promises.readdir(root, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory() && isSessionDirName(e.name)).map((e) => e.name);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return [];
		}
		throw err;
	}
}
