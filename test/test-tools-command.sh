#!/usr/bin/env bash
set -e

echo "Testing tools Pi extension..."

# Verify that Pi loads the extension without error
pi -ne -e extensions/tools.ts --list-models >/dev/null

echo "✓ tools extension loads cleanly in Pi"

echo "Running tools extension tests..."
pi -ne -e test/test-tools-command.ts --offline -p "test"

echo "✓ All tools extension tests passed"
