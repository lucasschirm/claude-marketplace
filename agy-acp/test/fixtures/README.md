# Fixtures

Recorded artifacts of the agy 1.4.2 spike (2026-10-26), imported so CI never calls a model.
See the spike section of [lucasschirm/claude-marketplace#49](https://github.com/lucasschirm/claude-marketplace/issues/49).

## Layout

- `stream/` — 34 stream scenarios. Each scenario is `<name>.stdout.ndjson` (the exact stdout lines of
  one `agy --input-format stream-json --output-format stream-json -p=` run) plus `<name>.meta.json`
  (invocation, recorded inputs, exit code, stderr, timeline). `field-inventory.json` lists every field
  observed in the output events, with the values seen in the runs.
- `hooks/` — `hook-stdin-payloads.jsonl`: the stdin payloads a `PreToolUse` hook received, one JSON
  object per line.
- `reference/` — the spike's prototype permission bridge (`parent.ts`, `bridge-hook.ts`). **Reference
  only, not shipped code**: not imported by anything, not type-gated for reuse. The production bridge
  is rewritten in a later sub-issue; these files are the behavioural specification.

## Normalisation

- Absolute spike paths are replaced by `<SPIKE>`, the user home by `<HOME>` (in `meta.json` and in the
  hook payloads). Recorded command output that leaked the local username carries `user user` instead.
- No secrets, tokens or credentials are present in any file.

## How the driver tests use these

`test/fake-agy.ts` is an executable stand-in for `agy`: selected by the `FAKE_AGY_FIXTURE` env var
(naming a scenario in `stream/`), it validates the flags and stdin lines a driver sends against the
recorded scenario, replays the recorded stdout with scaled timing, honours SIGINT the way
`interrupted-sigint` does, and exits with the recorded code. It behaves like the real process
around input: it pauses at a turn boundary until a user line arrives (a mid-turn user line is
queued as the next turn), and a startup-failure scenario (no `init` in the record) emits its error
`result` without any input.
