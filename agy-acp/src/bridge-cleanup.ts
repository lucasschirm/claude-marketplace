// Startup hygiene for the per-session bridge dirs: remove the ones left by crashed runs.
// Stale means: a bridge dir name, an mtime older than STALE_BRIDGE_MS, and a socket that no
// longer answers - a live session's dir is never removed, however old it is.

import * as fs from "node:fs";
import { connect } from "node:net";
import * as path from "node:path";
import { BRIDGE_DIR_NAME_RE, STALE_BRIDGE_MS, bridgeRuntimeDirs } from "./bridge-server.ts";

/** A live session's socket answers connect (the server accepts before any request line); a dead
 * one refuses. The probe is destroyed immediately: a close with no data is a no-op on the server. */
function isLiveSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(socketPath);
		const done = (ok: boolean): void => {
			probe.destroy();
			resolve(ok);
		};
		probe.on("connect", () => done(true));
		probe.on("error", () => done(false));
		setTimeout(() => done(false), 1000).unref();
	});
}

export async function cleanupStaleBridges(log: (line: string) => void, nowMs: number = Date.now()): Promise<void> {
	for (const root of bridgeRuntimeDirs()) {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(root);
		} catch {
			continue; // no runtime dir yet (or unreadable) - nothing to clean
		}
		for (const entry of entries) {
			if (!BRIDGE_DIR_NAME_RE.test(entry)) continue;
			const p = path.join(root, entry);
			try {
				const st = await fs.promises.stat(p);
				if (nowMs - st.mtimeMs > STALE_BRIDGE_MS) {
					if (await isLiveSocket(path.join(p, "socket"))) continue; // still serving: not stale
					await fs.promises.rm(p, { recursive: true, force: true });
					log(`bridge cleanup: removed stale ${p}`);
				}
			} catch (err) {
				// a vanished dir (a race) is expected; a real failure (e.g. EPERM) is logged, not swallowed
				log(`bridge cleanup: stat/rm failed for ${p}: ${(err as Error).message}`);
			}
		}
	}
}
