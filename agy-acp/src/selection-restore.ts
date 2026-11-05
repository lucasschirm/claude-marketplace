// Putting a stored selection back (issue #56).
//
// `session-selection.ts` owns the rules of a live selection; this owns the one question the store asks
// it: is what we wrote down still something this server may hand to a client? It is a module of its own
// because the answer is deliberately weaker than the live rules - a record cannot turn a switch on, and a
// session that comes back with less than it had should still come back.

import { DEFAULT_MODE_ID, SessionSelection, type SelectionState } from "./config-options.ts";
import type { SelectionRecord } from "./selection-record.ts";

/**
 * Bring a stored selection back into this process (issue #56).
 *
 * A record is not an authority. Its mode has to be one this server offers (`bypass` needs the operator
 * to have turned it on, and a store file is not an operator), and its model and effort have to be a pair
 * agy accepts, or every prompt of the restored session dies in agy's startup check. So each part is
 * tried on its own and the failures are reported: a session whose operator turned `--allow-bypass` off
 * comes back in `default` *with its model*, which is the honest reading of what the client can still be
 * given, and the notes say exactly what was not honoured.
 */
export function restoreSelection(state: SelectionState, stored: SelectionRecord): { selection: SessionSelection; notes: string[] } {
	const notes: string[] = [];
	let selection: SessionSelection;
	try {
		selection = new SessionSelection({ ...state, model: stored.model, effort: stored.effort });
	} catch (err) {
		notes.push(
			`the stored model and effort (${stored.model}/${stored.effort}) are not a pair agy accepts (${err instanceof Error ? err.message : String(err)}); they are left to agy`,
		);
		// Without a flag at all, rather than with the operator's: the operator's default describes a
		// different session than the one the client asked to load, and a stored pair that cannot be used
		// says nothing about which half was the problem.
		selection = new SessionSelection({ ...state, model: undefined, effort: undefined });
	}
	if (stored.mode !== DEFAULT_MODE_ID && !selection.adoptMode(stored.mode)) {
		notes.push(`the stored mode ${stored.mode} is not offered by this server; the session is in ${DEFAULT_MODE_ID}`);
	}
	return { selection, notes };
}
