#!/usr/bin/env bash
# Test runner shared by local development and CI.
#
#   bash test/run.sh                 # run every CI suite
#   bash test/run.sh unit manifest   # run named suites
#   bash test/run.sh --list          # list suites
#
# Requires `npm install`: `typecheck` needs typescript + the pinned pi typings, and the `unit`
# suite includes files that import an extension entry (so pi-tui and typebox resolve at runtime).
#
# Suites NOT run here (and not run in CI):
#   test-devin-delegate.ts            - starts real Devin sessions; run deliberately
#   test-devin-delegate-lifecycle.ts  - starts real Devin sessions; run deliberately
#   test-orca-orchestration.sh        - needs a live Orca CLI/orchestration backend
set -e

cd "$(dirname "$0")/.."

# Node >= 23.6 is required: node --test runs the TypeScript tests directly.
UNIT_TESTS="test/test-compaction-fail-recovery.ts test/test-devin-bash-guard.ts test/test-devin-permissions.ts test/test-devin-tui-safety.ts test/test-pr-observer-mcp.ts test/test-pr-observer-hooks.ts test/test-pr-tasks-manager.ts test/test-gh-health.ts test/test-ci-verdict.ts test/test-mergeability.ts test/test-bump-plugin-versions.ts test/test-orca-client.ts test/test-review-thread-paths.ts test/test-tool-result.ts test/test-exec.ts test/test-orca-status.ts test/test-nonblocking.ts test/test-git-repo.ts test/test-worktree-safety.ts"

# agy-acp is a standalone package: its tests run under plain `node --test`, not inside Pi.
AGY_ACP_TESTS="agy-acp/test/test-jsonrpc.ts agy-acp/test/test-contract.ts agy-acp/test/test-process.ts agy-acp/test/test-main.ts agy-acp/test/test-package.ts agy-acp/test/test-sessions.ts agy-acp/test/test-permission-policy.ts agy-acp/test/test-bridge.ts agy-acp/test/test-permission-integration.ts agy-acp/test/test-lifecycle.ts agy-acp/test/test-shutdown.ts"

ALL_SUITES="typecheck lint format check quality-fixtures manifest unit agy-acp compaction-recovery observe-pr observe-pr-gh-failure observe-pr-mergeability observe-pr-branch-scan branch-observer startup-notice observe-pr-resume observe-pr-stale pr-tasks pr-tasks-stale pr-tasks-gh-failure pr-tasks-reconcile tools devin-queue"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

run_suite() {
  case "$1" in
    lint)
      if [ ! -x node_modules/.bin/biome ]; then
        echo "biome is not installed - run 'npm install' first (it is a devDependency)" >&2
        exit 1
      fi
      npm run lint
      ;;
    quality-fixtures)
      bash test/quality-gate-fixtures.sh
      ;;
    check)
      # The full gate counts the biome-derived metrics, so it needs the devDependencies too.
      if [ ! -x node_modules/.bin/biome ]; then
        echo "biome is not installed - run 'npm install' first (the repo invariants also count biome's metrics)" >&2
        exit 1
      fi
      npm run check
      ;;
    format)
      if [ ! -x node_modules/.bin/biome ]; then
        echo "biome is not installed - run 'npm install' first (it is a devDependency)" >&2
        exit 1
      fi
      npm run format:check
      ;;
    typecheck)
      # The gate needs the type sources (typescript + the pinned pi packages); CI installs them in
      # the quality job. Fail with the reason instead of a bare 'tsc: not found'.
      if [ ! -x node_modules/.bin/tsc ]; then
        echo "typescript is not installed - run 'npm install' first (it is a devDependency)" >&2
        exit 1
      fi
      npm run typecheck
      ;;
    manifest)
      node scripts/validate-marketplace.mjs
      ;;
    unit)
      node --test $UNIT_TESTS
      ;;
    agy-acp)
      node --test $AGY_ACP_TESTS
      ;;
    compaction-recovery)
      pi -ne -e test/test-compaction-recovery.ts --offline -p "test"
      ;;
    observe-pr)
      bash test/test-observe-pr.sh
      ;;
    observe-pr-gh-failure)
      pi -ne -e test/test-observe-pr-gh-failure.ts --offline -p "test"
      ;;
    observe-pr-mergeability)
      pi -ne -e test/test-observe-pr-mergeability.ts --offline -p "test"
      ;;
    observe-pr-branch-scan)
      pi -ne -e test/test-observe-pr-branch-scan.ts --offline -p "test"
      ;;
    branch-observer)
      pi -ne -e test/test-branch-observer.ts --offline -p "test"
      ;;
    startup-notice)
      pi -ne -e test/test-startup-notice.ts --offline -p "test"
      ;;
    observe-pr-resume)
      pi -ne -e test/test-observe-pr-resume.ts --offline -p "test"
      ;;
    observe-pr-stale)
      pi -ne -e test/test-observe-pr-stale.ts --offline -p "test"
      ;;
    pr-tasks)
      bash test/test-pr-tasks.sh
      ;;
    pr-tasks-stale)
      pi -ne -e test/test-pr-tasks-stale.ts --offline -p "test"
      ;;
    pr-tasks-reconcile)
      pi -ne -e test/test-pr-tasks-reconcile.ts --offline -p "test"
      ;;
    pr-tasks-gh-failure)
      pi -ne -e test/test-pr-tasks-gh-failure.ts --offline -p "test"
      ;;
    tools)
      bash test/test-tools-command.sh
      ;;
    devin-queue)
      # Fake `devin acp` (test/fake-acp-server.mjs): no Devin account needed.
      pi -ne -e test/test-devin-delegate-queue.ts --offline -p "test"
      ;;
    *)
      echo "Unknown suite: $1" >&2
      echo "Available: $ALL_SUITES" >&2
      exit 2
      ;;
  esac
}

if [ "$1" = "--list" ] || [ "$1" = "-l" ]; then
  for suite in $ALL_SUITES; do echo "$suite"; done
  exit 0
fi
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  usage
  exit 0
fi

# A test file no suite runs is a test that does not exist. The check lives in scripts/check-quality.mjs
# (one implementation for local runs, CI and `npm run check`) and needs no installed dependencies. It
# runs here rather than at the top of the file so `--list` and `--help` stay noise-free.
node scripts/check-quality.mjs --only wiredTests

if command -v pi >/dev/null 2>&1; then
  echo "pi: $(pi --version 2>/dev/null | head -1)"
else
  echo "warning: 'pi' is not on PATH - suites that load extensions inside Pi will fail" >&2
fi
echo "node: $(node --version)"

suites="${*:-$ALL_SUITES}"
for suite in $suites; do
  echo
  echo "=============================================================="
  echo "  suite: $suite"
  echo "=============================================================="
  run_suite "$suite"
  echo "--- suite '$suite' passed"
done

echo
echo "✓ All suites passed: $suites"
