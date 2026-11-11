// The frame decoder for an ACP child's stdout: newline-delimited JSON, split on "\n" and nothing else.
//
// `node:readline` used to do this, and `node:readline` splits on U+2028 and U+2029 as well. An ACP
// frame is allowed to carry either inside a JSON string — an agent message quoting a line of a source
// file, which is exactly what a delegated coding session streams — and `JSON.stringify` does not escape
// them for a byte stream (it escapes them only when the result is embedded in JavaScript source). So one
// line of text torn out of a file tore the frame in half: the first half failed `JSON.parse` and was
// dropped as "non-json output", the second half likewise, and the caller watched a session go silent in
// the middle of a sentence.
//
// Bytes are buffered rather than strings so a multi-byte UTF-8 character split across two reads is
// decoded once its frame is complete, and a frame is capped so a peer that never sends a newline cannot
// grow this process forever: `MAX_FRAME_BYTES` is the ceiling, and crossing it ends the stream with a
// reason instead of with memory pressure.
//
// This mirrors `agy-acp/src/framing.ts`. The two are not one module on purpose: `extensions/` ships to
// pi without `agy-acp/` beside it, and the trees share no runtime code.

/** ACP control frames are small; 8 MiB is the same generous headroom `agy-acp` gives its own reader. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface FrameSink {
	/** One complete frame, without its terminator. */
	onLine(line: string): void;
	/** Why a frame was not delivered. A bad frame ends nothing; an oversized one ends the stream. */
	onProblem(reason: string): void;
}

export class FrameDecoder {
	private readonly maxBytes: number;
	private readonly sink: FrameSink;
	private pending: Buffer = Buffer.alloc(0);
	private overflowed = false;

	constructor(maxBytes: number, sink: FrameSink) {
		this.maxBytes = maxBytes;
		this.sink = sink;
	}

	/** Read one chunk of stdout and deliver every frame it completed. */
	push(chunk: Buffer): void {
		if (this.overflowed) {
			return;
		}
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		for (;;) {
			const at = this.pending.indexOf(NEWLINE);
			if (at < 0) {
				break;
			}
			const frame = this.pending.subarray(0, at);
			this.pending = this.pending.subarray(at + 1);
			if (!this.emit(frame)) {
				return;
			}
		}
		if (this.pending.length > this.maxBytes) {
			this.overflowed = true;
			// Free what the ceiling exists to bound: past the ceiling the bytes are useless, and holding
			// them is exactly the memory this check was written to protect.
			this.pending = Buffer.alloc(0);
			this.sink.onProblem(`frame exceeded ${this.maxBytes} bytes without a newline - the rest of this stream is dropped`);
		}
	}

	/**
	 * The stream ended: hand over a final frame that never got its newline.
	 *
	 * A child that answers and exits can lose the terminator, and the previous reader (`readline`) emitted
	 * that tail. Dropping it here would turn a clean exit into a session that looks like it stopped before
	 * it finished.
	 */
	flush(): void {
		if (this.overflowed || this.pending.length === 0) {
			return;
		}
		const tail = this.pending;
		this.pending = Buffer.alloc(0);
		this.emit(tail);
	}

	/** Bytes held without a terminator, for a test or a diagnostic. */
	get pendingBytes(): number {
		return this.pending.length;
	}

	/** False when the frame ended the stream (oversized), so the push loop stops. */
	private emit(frame: Buffer): boolean {
		// A CRLF peer's "\r" is framing, not payload, so it is stripped before the cap is measured.
		const bytes = frame.length > 0 && frame[frame.length - 1] === CARRIAGE_RETURN ? frame.subarray(0, frame.length - 1) : frame;
		if (bytes.length > this.maxBytes) {
			this.overflowed = true;
			this.sink.onProblem(`frame of ${bytes.length} bytes exceeds the ${this.maxBytes}-byte ceiling - the rest of this stream is dropped`);
			return false;
		}
		if (bytes.length === 0) {
			return true;
		}
		let line: string;
		try {
			line = utf8.decode(bytes);
		} catch {
			this.sink.onProblem("frame is not valid UTF-8 - dropped");
			return true;
		}
		this.sink.onLine(line);
		return true;
	}
}
