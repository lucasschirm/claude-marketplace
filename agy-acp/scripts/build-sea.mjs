#!/usr/bin/env node
// Build the agy-acp single executable (Node SEA): bundle the sources with esbuild (Node built-ins
// only - the result has no runtime dependencies), prepare the blob with `node
// --experimental-sea-config`, copy the `node` binary and inject the blob with postject. Then
// record what the release needs: the binary size, the startup time to `initialize` (best of 3),
// `file`, `agy-acp --version` and the sha256, written to dist/ (SHA256SUMS, build-info.txt).
//
// the injected binary re-executes itself as the PreToolUse hook (`agy-acp --bridge-hook`), so the
// SEA ships no second file and no Node dependency.
//
// Requirements: Node >= 23.6 (it generates the blob and is the base of the binary) and the repo
// root's devDependencies (esbuild, postject) installed. Linux x64 is the tested target; arm64 and
// macOS work the same way but are not what CI covers.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const DIST = path.join(PKG, "dist");
const BIN = path.join(DIST, "agy-acp");
// The fuse present in stock `node` builds that postject flips to mark the injected resource
// (nodejs.org SEA docs; postject 1.0.0-alpha does not work without it).
const SEA_SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function fail(message) {
	process.stderr.write(`build-sea: ${message}\n`);
	process.exit(1);
}

const nodeVersion = process.versions.node;
if (!/^(2[3-9]|[3-9]\d)\./.test(nodeVersion)) fail(`Node >= 23.6 is required to build the SEA (have ${nodeVersion})`);

/** A devDependency bin from this package or an ancestor (the root install), else a clear error. */
function findBin(name) {
	let dir = PKG;
	for (;;) {
		const candidate = path.join(dir, "node_modules", ".bin", name);
		if (fs.existsSync(candidate)) return candidate;
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	fail(`${name} was not found in this or an ancestor node_modules - install the repo root's devDependencies (npm install) and retry`);
}

function run(cmd, args, label) {
	const res = spawnSync(cmd, args, { cwd: PKG, timeout: 300_000 });
	if (res.status !== 0 || res.error) fail(`${label} failed${res.error ? ` (${res.error.message})` : ` (exit ${res.status})`}`);
}

/** Time spawn -> the initialize response line (the client-visible part of a start). */
function timeToInitialize() {
	return new Promise((resolve, reject) => {
		const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
		const t0 = process.hrtime.bigint();
		let done = false;
		const finish = (err) => {
			if (done) return;
			done = true;
			clearTimeout(guard);
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone: nothing to kill
			}
			if (err) reject(err);
		};
		const guard = setTimeout(() => finish(new Error("the binary did not answer initialize within 20 s")), 20_000);
		child.stderr.resume(); // the experimental warning must not fill the pipe
		child.stdout.on("data", (d) => {
			for (const line of d.toString("utf8").split("\n")) {
				if (line.includes('"result"') && line.includes('"agentInfo"')) {
					resolve(Number(process.hrtime.bigint() - t0) / 1e6);
					finish();
					return;
				}
			}
		});
		child.on("error", (err) => finish(err));
		child.on("close", (code) => finish(new Error(`the binary exited ${code} before answering initialize`)));
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "build-sea", version: "0" } } })}\n`,
		);
	});
}

async function main() {
	const esbuild = findBin("esbuild");
	const postject = findBin("postject");
	fs.mkdirSync(DIST, { recursive: true });
	const bundle = path.join(DIST, "main.cjs");
	const blob = path.join(DIST, "blob.bin");

	run(
		esbuild,
		["src/main.ts", "--bundle", "--platform=node", "--format=cjs", "--target=node23.6", `--outfile=${bundle}`],
		"the esbuild bundle",
	);

	const config = path.join(DIST, "sea-config.json");
	fs.writeFileSync(config, `${JSON.stringify({ main: bundle, output: blob }, null, "\t")}\n`);
	run(process.execPath, ["--experimental-sea-config", config], "the sea-config blob preparation");

	fs.copyFileSync(process.execPath, BIN);
	run(postject, [BIN, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SEA_SENTINEL_FUSE], "the postject injection");
	fs.rmSync(blob, { force: true }); // the blob now lives inside the binary

	const version = spawnSync(BIN, ["--version"], { encoding: "utf8", timeout: 60_000 });
	if (version.status !== 0) fail(`the built binary's --version failed: ${version.stderr}`);
	const file = (() => {
		const res = spawnSync("file", [BIN], { encoding: "utf8", timeout: 60_000 });
		return res.status === 0 ? res.stdout.trim() : "file(1) not available";
	})();
	const starts = [];
	for (let i = 0; i < 3; i++) starts.push(await timeToInitialize());
	const startupMs = Math.min(...starts); // the best of 3: the median would credit a slow start
	const size = fs.statSync(BIN).size;
	const sha = createHash("sha256").update(fs.readFileSync(BIN)).digest("hex");
	const name = path.basename(BIN);
	fs.writeFileSync(path.join(DIST, "SHA256SUMS"), `${sha}  ${name}\n`);
	fs.writeFileSync(
		path.join(DIST, "build-info.txt"),
		`${version.stdout.trim()}\n` +
			`platform: ${process.platform} ${process.arch} (node ${nodeVersion})\n` +
			`size: ${size} bytes (${(size / 1024 / 1024).toFixed(1)} MiB)\n` +
			`startup to initialize: ${startupMs.toFixed(0)} ms (best of 3)\n` +
			`file: ${file}\n` +
			`sha256: ${sha}\n`,
	);
	process.stdout.write(
		`build-sea: ${name} is ready - ${size} bytes (${(size / 1024 / 1024).toFixed(1)} MiB), initialize in ${startupMs.toFixed(0)} ms (best of 3)\n` +
			`  ${version.stdout.trim()}\n  ${file}\n`,
	);
}

void main().catch((err) => fail(err.message));
