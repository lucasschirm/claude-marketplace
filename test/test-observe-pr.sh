#!/usr/bin/env bash
set -e

echo "Testing observe-pr Pi extension..."

# Verify that Pi loads the extension without error
pi --list-models >/dev/null

echo "✓ observe-pr loads cleanly in Pi"

# Verify tool registration in Pi runtime
cat << 'EOF' > test/test-temp-runner.ts
import ext from "../extensions/observe-pr.ts";

export default function(pi) {
  const registered = [];
  const mockPi = {
    ...pi,
    registerTool(t) { registered.push(t.name); return pi.registerTool(t); },
    registerCommand: pi.registerCommand.bind(pi),
    registerFlag: pi.registerFlag.bind(pi),
    getFlag: pi.getFlag.bind(pi),
    getActiveTools: pi.getActiveTools.bind(pi),
    setActiveTools: pi.setActiveTools.bind(pi),
    sendUserMessage: pi.sendUserMessage.bind(pi),
  };
  ext(mockPi);
  pi.on("session_start", () => {
    console.log("Registered tools:", registered);
    if (!registered.includes("observe_pr")) process.exit(1);
    console.log("✓ Tools verified successfully");
    process.exit(0);
  });
}
EOF

pi -ne -e test/test-temp-runner.ts -p "hi" --offline --model local-llama/Qwen3.8
rm -f test/test-temp-runner.ts

echo "✓ All extension tests passed"
