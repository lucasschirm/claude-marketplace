// Text that arrives from someone else's stream needs a ceiling in BYTES, not in characters: the budget
// is memory, the string is UTF-16, and a multi-byte character must never be cut in half on the way to
// the budget (half a character is not text any consumer can render or re-encode).
//
// The trim drops from the FRONT because the callers keep tails: a stderr tail is the end of what the
// child said, which is where the failure is. It is linear in what it drops - the previous version
// re-measured the whole buffer once per code point, which made one 1 MiB write of agy stack trace
// quadratic (F6).

/** The bytes one code point costs in UTF-8. */
function utf8Length(codePoint: number): number {
	if (codePoint < 0x80) {
		return 1;
	}
	if (codePoint < 0x800) {
		return 2;
	}
	return codePoint < 0x10000 ? 3 : 4;
}

/**
 * The last `maxBytes` UTF-8 bytes of `text`, cut at a code-point boundary (so the result is at most the
 * budget, and never ends - or starts - inside a character). Returns `text` unchanged when it fits.
 */
export function trimToByteBudget(text: string, maxBytes: number): string {
	let over = Buffer.byteLength(text, "utf8") - maxBytes;
	if (over <= 0) {
		return text;
	}
	// One pass over the part being dropped: the overflow is paid down in bytes while the index walks
	// whole code points, so nothing is measured twice and nothing is split.
	let i = 0;
	while (over > 0 && i < text.length) {
		const codePoint = text.codePointAt(i) ?? 0;
		over -= utf8Length(codePoint);
		i += codePoint > 0xffff ? 2 : 1;
	}
	return text.slice(i);
}
