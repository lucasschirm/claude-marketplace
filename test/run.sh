#!/usr/bin/env bash
# Test runner shared by local development and CI.
#
#   bash test/run.sh                 # run every CI suite
#   bash test/run.sh unit manifest   # run named suites
#   bash test/run.sh --list          # list suites
#
# Suites NOT run here (and not run in CI):
#   test-devin-delegate.ts            - starts real Devin sessions; run deliberately
#   test-devin-delegate-lifecycle.ts  - starts real Devin sessions; run deliberately
#   test-orca-orchestration.sh        - needs a live Orca CLI/orchestration backend
set -e

cd "$(dirname "$0")/.."

# Node >= 23.6 is required: node --test runs the TypeScript tests directly.
UNIT_TESTS="test/test-devin-bash-guard.ts test/test-devin-tui-safety.ts test/test-pr-tasks-manager.ts"

ALL_SUITES="manifest unit observe-pr branch-observer startup-notice observe-pr-resume pr-tasks tools"

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

run_suite() {
  case "$1" in
    manifest)
      node scripts/validate-marketplace.mjs
      ;;
    unit)
      node --test $UNIT_TESTS
      ;;
    observe-pr)
      bash test/test-observe-pr.sh
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
    pr-tasks)
      bash test/test-pr-tasks.sh
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
