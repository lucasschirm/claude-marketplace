#!/usr/bin/env node
// agy-acp: an Agent Client Protocol (ACP) server that drives Google's `agy` CLI through its
// documented headless stream-json mode.
//
// stdout is the protocol channel: JSON-RPC frames only. Diagnostics go to stderr, or to the file
// named by AGY_ACP_LOG. The client hangs up by closing stdin; we answer EOF with a clean exit.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgyAcpServer, AGY_ACP_VERSION, PROTOCOL_VERSION } from "./server.ts";
import { cleanupStaleBridges } from "./bridge-server.ts";
export { AGY_ACP_VERSION, PROTOCOL_VERSION };

const USAGE = `agy-acp ${AGY_ACP_VERSION} - an ACP server for Google's agy CLI

Usage:
  agy-acp              serve ACP over stdio (this is what an ACP client spawns)
  agy-acp --version    print the version
  agy-acp --help       print this help

Environment:
  AGY_ACP_LOG          append diagnostics to this file instead of stderr
`;

function createLogger(): (line: string) => void {
	const target = process.env.AGY_ACP_LOG?.trim();
	if (target) {
		return (line) => {
			try {
				fs.appendFileSync(target, `${line}\n`);
			} catch {
				// diagnostics must never take the server down
			}
		};
	}
	return (line) => {
		try {
			process.stderr.write(`${line}\n`);
		} catch {
			// a closed stderr is not a reason to die mid-protocol
		}
	};
}

const KNOWN_ARGS = new Set(["--help", "-h", "--version", "-v"]);

export function main(args: string[]): void {
	const unknown = args.filter((a) => !KNOWN_ARGS.has(a));
	if (unknown.length > 0) {
		process.stderr.write(`agy-acp: unknown argument '${unknown.join(" ")}'\n${USAGE}`);
		process.exitCode = 2;
		return;
	}
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return;
	}
	if (args.includes("--version") || args.includes("-v")) {
		process.stdout.write(`agy-acp ${AGY_ACP_VERSION}\n`);
		return;
	}

	const log = createLogger();
	// Stale bridge dirs (a previous run crashed before its cleanup) are removed before the first
	// session; the failure is logged, never fatal - a session must not die over hygiene.
	cleanupStaleBridges(log).catch((err: Error) => log(`stale bridge cleanup failed: ${err.message}`));
	startAgyAcpServer({ input: process.stdin, output: process.stdout, log });
	// stdin EOF ends the event loop on its own (the connection closes, the sessions are disposed,
	// and their child process groups are killed); nothing else keeps a handle open.
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1];
const isDirectRun = (() => {
	if (!invoked) return false;
	try {
		return fs.realpathSync(invoked) === thisFile;
	} catch {
		// a vanished argv[1] can still be compared by path
		return path.resolve(invoked) === thisFile;
	}
})();

if (isDirectRun) main(process.argv.slice(2));
