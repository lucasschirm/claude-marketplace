#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Devin CLI Stop hook: inspect if there are open PR review tasks before stopping.
try {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();

  if (!branch) {
    process.exit(0);
  }

  // Check if gh is authenticated and if an open PR exists
  const prJson = execFileSync("gh", ["pr", "view", "--json", "number,state"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });

  const pr = JSON.parse(prJson);
  if (!pr || pr.state !== "OPEN") {
    process.exit(0);
  }

  // Allow stopping by default unless an active blocking condition is met
  process.exit(0);
} catch {
  // Fail-open on environment issues (e.g. not a git repo or gh unauthenticated)
  process.exit(0);
}
