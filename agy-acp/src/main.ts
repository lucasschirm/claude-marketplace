#!/usr/bin/env node
// agy-acp: an Agent Client Protocol (ACP) server that drives Google's `agy` CLI through its
// documented headless stream-json mode.
//
// stdout is the protocol channel: JSON-RPC frames only. Diagnostics go to stderr, or to the file
// named by AGY_ACP_LOG. The client hangs up by closing stdin; we answer EOF with a clean exit.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { INVALID_PARAMS, JsonRpcConnection, RpcError } from "./jsonrpc.ts";

// Keep in sync with agy-acp/package.json (test-package.ts asserts it).
export const AGY_ACP_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;

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

function handleInitialize(params: unknown): unknown {
	const requested = typeof params === "object" && params !== null ? (params as Record<string, unknown>).protocolVersion : undefined;
	// ACP negotiation: a client asking for a newer version gets the latest we support (the spec's
	// MUST - the client decides). A version we cannot honour at all is rejected with -32602.
	if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
		throw new RpcError(INVALID_PARAMS, `unsupported protocolVersion ${JSON.stringify(requested)} - agy-acp speaks ${PROTOCOL_VERSION}`);
	}
	return {
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: {
			loadSession: false,
			promptCapabilities: { audio: false, embeddedContext: false, image: false },
		},
		authMethods: [],
		agentInfo: { name: "agy-acp", version: AGY_ACP_VERSION },
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
	const connection = new JsonRpcConnection({ input: process.stdin, output: process.stdout, log });
	connection.registerMethod("initialize", handleInitialize);
	connection.onNotification((method) => log(`ignored notification: ${method}`));
	connection.onClose((reason) => log(`connection closed: ${reason}`));
	// stdin EOF ends the event loop on its own; nothing else keeps a handle open.
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
