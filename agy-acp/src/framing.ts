// Frame decoding for agy-acp's JSON-RPC transport: newline-delimited frames over stdio.
//
// Framing splits on "\n" only. node:readline is never used because it also splits on U+2028/U+2029,
// and a frame carrying either inside a string would be torn in half. Input is buffered as raw bytes,
// so a multi-byte UTF-8 character split across two chunks is decoded only once its frame is complete.
// A line longer than maxFrameBytes overflows, so a runaway peer is bounded instead of buffered forever.

/** Incoming frames are capped: ACP control messages are small, so 8 MiB is generous headroom. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Bytes in, lines out. A line is emitted only once its "\n" arrives, so consumers never see a frame
 * that is still in flight or a character that is still split across chunks.
 */
export class FrameDecoder {
	private readonly maxFrameBytes: number;
	private readonly onLine: (line: string) => void;
	private readonly onInvalidFrame: (reason: string) => void;
	private readonly onOverflow: (bytes: number) => void;
	private pending: Buffer = Buffer.alloc(0);
	private overflowed = false;

	constructor(
		maxFrameBytes: number,
		onLine: (line: string) => void,
		onInvalidFrame: (reason: string) => void,
		onOverflow: (bytes: number) => void,
	) {
		this.maxFrameBytes = maxFrameBytes;
		this.onLine = onLine;
		this.onInvalidFrame = onInvalidFrame;
		this.onOverflow = onOverflow;
	}

	push(chunk: Buffer): void {
		if (this.overflowed) return;
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		for (;;) {
			const at = this.pending.indexOf(NEWLINE);
			if (at < 0) break;
			const frame = this.pending.subarray(0, at);
			this.pending = this.pending.subarray(at + 1);
			if (!this.emit(frame)) return;
		}
		if (this.pending.length > this.maxFrameBytes) {
			this.overflowed = true;
			this.onOverflow(this.pending.length);
		}
	}

	/** Bytes still buffered without a terminator (an unterminated frame at EOF is logged, not lost silently). */
	get pendingBytes(): number {
		return this.pending.length;
	}

	/** Returns false when the line ended the stream (oversized), so the push loop stops. */
	private emit(frame: Buffer): boolean {
		// Tolerate CRLF peers: the "\r" is framing, not payload - and must not count against the cap.
		const bytes = frame.length > 0 && frame[frame.length - 1] === CARRIAGE_RETURN ? frame.subarray(0, frame.length - 1) : frame;
		if (bytes.length > this.maxFrameBytes) {
			this.overflowed = true;
			this.onOverflow(bytes.length);
			return false;
		}
		if (bytes.length === 0) return true;
		let line: string;
		try {
			line = utf8.decode(bytes);
		} catch {
			this.onInvalidFrame("frame is not valid UTF-8");
			return true;
		}
		this.onLine(line);
		return true;
	}
}
