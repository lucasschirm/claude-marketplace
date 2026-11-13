#!/usr/bin/env node
// Points this checkout's git at .githooks/:
//   node scripts/install-hooks.mjs      (also `npm run hooks:install`, and `npm run prepare`)
//
// It runs from `prepare`, so `npm install` is the only step anyone has to remember - and a clone
// that never ran `npm install` has no node_modules, so its hooks could not have run the gate
// anyway. core.hooksPath is set per checkout (it is not a committed setting), which is why this
// exists at all.
//
// The path is set RELATIVE on purpose. core.hooksPath is shared by every worktree of a repository,
// and git resolves a relative one against the worktree it is committing in: one setting, the right
// hooks in each worktree, no absolute path pointing at somebody else's directory.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = ".githooks";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gitAsk(args) {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

// A tarball install, or any tree that is not a checkout: there is nothing to point at git.
if (gitAsk(["rev-parse", "--git-dir"]) === null) {
	console.log("install-hooks: not a git checkout, nothing to do");
	process.exit(0);
}
if (!fs.existsSync(path.join(root, HOOKS_DIR, "pre-commit"))) {
	console.error(`install-hooks: ${HOOKS_DIR}/pre-commit is missing - this is not the repository it was written for`);
	process.exit(1);
}

const current = gitAsk(["config", "--local", "--get", "core.hooksPath"]);
if (current === HOOKS_DIR) {
	console.log(`install-hooks: core.hooksPath is already ${HOOKS_DIR}`);
	process.exit(0);
}
execFileSync("git", ["-C", root, "config", "core.hooksPath", HOOKS_DIR], { stdio: "inherit" });
const replaced = current === null ? "" : ` (was ${current})`;
console.log(`install-hooks: core.hooksPath set to ${HOOKS_DIR}${replaced}`);
