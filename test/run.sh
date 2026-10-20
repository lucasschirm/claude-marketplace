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
UNIT_TESTS="test/test-devin-bash-guard.ts test/test-devin-tui-safety.ts test/test-pr-tasks-manager.ts test/test-gh-health.ts test/test-ci-verdict.ts test/test-orca-client.ts test/test-review-thread-paths.ts test/test-tool-result.ts test/test-orca-status.ts"

ALL_SUITES="typecheck manifest unit observe-pr observe-pr-gh-failure branch-observer startup-notice observe-pr-resume observe-pr-stale pr-tasks pr-tasks-stale pr-tasks-gh-failure pr-tasks-reconcile tools"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

# A test file no suite runs is a test that does not exist. Three files in this directory need a real
# backend and are named as excluded in the header; everything else has to be referenced by this
# runner (UNIT_TESTS or a suite) or by a suite's own .sh - otherwise it silently never executes.
check_every_test_is_wired() {
  # Named in the header above: they start real Devin sessions, so they are run deliberately.
  local deliberate=" test-devin-delegate.ts test-devin-delegate-lifecycle.ts "
  local file base
  for file in test/test-*.ts; do
    base="${file#test/}"
    case "$deliberate" in *" $base "*) continue ;; esac
    if ! grep -q -- "$base" test/run.sh test/*.sh 2>/dev/null; then
      echo "✖ $file is wired into no suite - add it to UNIT_TESTS or to a suite runner" >&2
      exit 1
    fi
  done
}
check_every_test_is_wired

run_suite() {
  case "$1" in
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
    observe-pr)
      bash test/test-observe-pr.sh
      ;;
    observe-pr-gh-failure)
      pi -ne -e test/test-observe-pr-gh-failure.ts --offline -p "test"
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
