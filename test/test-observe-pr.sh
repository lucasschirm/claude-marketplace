#!/usr/bin/env bash
set -e

echo "Testing observe-pr Pi extension..."

# Verify that Pi loads the extension without error
pi --list-models >/dev/null

echo "✓ observe-pr loads cleanly in Pi"
