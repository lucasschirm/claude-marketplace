#!/usr/bin/env bash
set -e

echo "Testing orca-orchestration Pi extension..."

# Verify that Pi loads the extension without error
pi --list-models >/dev/null

echo "✓ orca-orchestration loads cleanly in Pi"

echo "Running orca orchestration extension tests..."
pi -ne -e test/test-orca-orchestration.ts --offline -p "test"

echo "✓ All orca orchestration tests passed"
