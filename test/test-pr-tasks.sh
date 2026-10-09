#!/usr/bin/env bash
set -e

echo "Testing pr-tasks Pi extension..."

# Verify that Pi loads the extension without error
pi --list-models >/dev/null

echo "✓ pr-tasks extension loads cleanly in Pi"

echo "Running pr-tasks extension test suite..."
pi -ne -e test/test-pr-tasks.ts --offline -p "test"

echo "✓ All pr-tasks tests passed successfully"
