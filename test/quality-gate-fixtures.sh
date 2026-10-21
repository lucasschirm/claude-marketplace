#!/usr/bin/env bash
# Does the quality gate actually bite? Every invariant in scripts/check-quality.mjs is asserted against a
# minimal violation, and the ratchet is asserted against the ways a baseline gets widened under pressure.
#
# A gate nobody proves is decoration: an invariant that silently measures nothing reports "within baseline"
# forever, and four of the twelve did exactly that when they were first written. This suite is the answer to
# "how do you know the checker checks?".
#
#   bash test/quality-gate-fixtures.sh
#
# It runs against a COPY of the tree in a temp directory, so the working tree is never mutated, and it points
# the checker at biome through PI_QA_BIOME, so node_modules is never mutated either (the stub cases would
# otherwise leave a fake binary behind in the real checkout).
set -u

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT" || exit 1
BIOME="$ROOT/node_modules/.bin/biome"
if [ ! -x "$BIOME" ]; then
  echo "biome is not installed - run 'npm install' first (it is a devDependency)" >&2
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/qa-gate-XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/repo"
# biome.jsonc sets vcs.useIgnoreFile, so the copy needs the ignore files too or biome exits with a config error
tar -cf - scripts extensions plugins skills test package.json biome.jsonc tsconfig.json .gitignore .git-blame-ignore-revs 2>/dev/null | (cd "$WORK/repo" && tar -xf -)
cd "$WORK/repo" || exit 1
export PI_QA_BIOME="$BIOME"
# check-quality.mjs honours PI_QA_BIOME only when this is set, so a stray variable cannot swap biome out in
# ordinary use or in CI. The fixture suite is the only caller allowed to redirect it.
export PI_QA_FIXTURES=1
export GIT_CONFIG_GLOBAL=/dev/null

PASS=0
FAIL=0

# qa [expect: fail|pass] <label> <args...>
qa() {
  local expect=$1 label=$2
  shift 2
  local out code
  out=$(node scripts/check-quality.mjs "$@" 2>&1)
  code=$?
  if { [ "$expect" = fail ] && [ "$code" -ne 0 ]; } || { [ "$expect" = pass ] && [ "$code" -eq 0 ]; }; then
    PASS=$((PASS + 1))
    echo "  ok    $label"
  else
    FAIL=$((FAIL + 1))
    echo "  MISS  $label (expected $expect, exit $code)"
    echo "$out" | tail -4 | sed 's/^/          /'
  fi
  LAST_OUT=$out
}

# probe <file> <content>  — write a throwaway source file into the copied tree
probe() { printf '%s\n' "$2" >"extensions/lib/$1"; }
dropprobes() { rm -f extensions/lib/zz-*.ts; }

# expect_line <label> <file:line> — the failure must name the offending site, not just fail
expect_line() {
  if echo "$LAST_OUT" | grep -qF "$2"; then
    PASS=$((PASS + 1))
    echo "  ok    $1"
  else
    FAIL=$((FAIL + 1))
    echo "  MISS  $1 (site $2 not reported)"
    echo "$LAST_OUT" | tail -6 | sed 's/^/          /'
  fi
}
expect_absent() {
  if echo "$LAST_OUT" | grep -qF "$2"; then
    FAIL=$((FAIL + 1))
    echo "  MISS  $1 (site $2 reported but must not be)"
  else
    PASS=$((PASS + 1))
    echo "  ok    $1"
  fi
}
expect_text() {
  if echo "$LAST_OUT" | grep -qF "$2"; then
    PASS=$((PASS + 1))
    echo "  ok    $1"
  else
    FAIL=$((FAIL + 1))
    echo "  MISS  $1 (message '$2' absent)"
    echo "$LAST_OUT" | tail -6 | sed 's/^/          /'
  fi
}

echo
echo "exec discipline"
probe zz-a.ts 'import { execFileAsync } from "node:child_process";
export async function f() {
	await execFileAsync("git", ["status"]);
	await execFileAsync("git", ["log"], { timeout: 1000 });
}'
qa fail "a call without a timeout fails" --only execTimeout --full
expect_line "and names the unguarded line" "zz-a.ts:3"
expect_absent "a guarded neighbour does not mask it" "zz-a.ts:4"
dropprobes
probe zz-a.ts 'import { execFile } from "node:child_process";
export function f() {
	execFile("git", ["status"], { timeout: 100 }, () => {});
}'
qa pass "a guarded call passes" --only execTimeout --full
dropprobes
probe zz-a.ts 'import { execFileAsync } from "node:child_process";
const NOTE = "call with timeout: 5000 in prose";
export async function f() {
	await execFileAsync("git", ["rev-parse", "HEAD"]);
	return NOTE;
}'
qa fail "prose mentioning timeout does not guard" --only execTimeout --full
dropprobes
probe zz-a.ts 'import { execFileAsync } from "node:child_process";
export async function f() {
	await execFileAsync("git", ["log"], { env: { P: /[(]/ } });
	await execFileAsync("git", ["status"], { timeout: 1000 });
}'
qa fail "a regex literal in the arguments cannot borrow the next call's timeout" --only execTimeout --full
expect_line "the regex call itself is reported" "zz-a.ts:3"
expect_absent "the guarded call stays clean" "zz-a.ts:4"
dropprobes
printf 'import { execFileSync } from "node:child_process";\nexport function f() {\n\texecFileSync("git", ["status"], { timeout: 100 });\n}\n' >extensions/zz-entry.ts
qa fail "an exec outside extensions/lib fails the location rule" --only execLocation --full
expect_line "and names the entry file" "extensions/zz-entry.ts:3"
qa fail "and the same file must be declared in package.json" --only piExtensionsMatchDisk --full
rm -f extensions/zz-entry.ts

echo
echo "mutating calls must have their result read"
probe zz-m.ts 'import { execOrca } from "./orca-client.ts";
import { execFileAsync, spawn, spawnSync } from "node:child_process";
export async function f(d: string) {
	await execOrca(["worker-stop", "--dispatch", d]);
	await execOrca(["worker", "stop", "--dispatch", d]);
	await execOrca<any>(["worker-release", "--dispatch", d]);
	spawnSync("git", ["push"]);
	spawn("git", ["push"]);
	return execFileAsync("gh", ["pr", "merge", "37"]);
}'
qa fail "single-token, two-token, generic, sync and returned forms are all caught" --only mutationResultChecked --full
# Lines 4-8 only. `return execFileAsync(... ["pr","merge"] ...)` is not a violation: the envelope reaches
# the caller, which is where the invariant says it must be read.
for n in 4 5 6 7 8; do expect_line "site zz-m.ts:$n" "zz-m.ts:$n"; done
dropprobes
probe zz-m.ts 'import { execOrca } from "./orca-client.ts";
import { execFileAsync, spawn } from "node:child_process";
export async function f(d: string) {
	const res = await execOrca(["worker", "stop", "--dispatch", d]);
	const res2 =
		// a note inside the binding is still one statement
		await execOrca(["worker-stop", "--dispatch", d]);
	await execOrca(["worker-stop", "--dispatch", d]).then((r) => r.ok);
	spawn("git", ["push"]).on("exit", () => {});
	spawn("git", ["push"]).once("exit", () => {});
	await execFileAsync("gh", ["api", "repos/o/r", "-f", "body=delete the cache and commit and push"]);
	return execFileAsync("gh", ["pr", "view", "37"]);
}'
qa pass "bound, chained, event-handled, value-carrying and read calls are not" --only mutationResultChecked --full

echo
echo "comments, strings and URLs"
probe zz-c.ts 'import { execFileAsync } from "node:child_process";
export async function f() {
	const u = "https://example.com";
	await execFileAsync("git", ["push"]);
	/* execFileAsync("git", ["rm", "-rf", "/tmp/zz"]); */
	const s = "execFileAsync(\\"git\\", [\\"rm\\"])";
	void s; void u;
}'
qa fail "a URL is not a comment: the call after it is still a site" --only mutationResultChecked --full
expect_line "the real call is reported" "zz-c.ts:4"
expect_absent "a call in a block comment is not" "zz-c.ts:5"
expect_absent "a call in a string is not" "zz-c.ts:6"
dropprobes

echo
echo "globalThis ownership"
probe zz-g.ts 'const g = globalThis as any;
const h = (globalThis as unknown) as any;
let k: any = globalThis;
export function f() {
	globalThis.__A__ = 1;
	globalThis.__B__ ??= 2;
	globalThis.__C__ += 3;
	globalThis.__D__ **= 4;
	globalThis.__E__ <<= 5;
	globalThis.__F__++;
	Object.assign(globalThis, { __G__: 7 });
	Reflect.set(globalThis, "__H__", 8);
	delete (globalThis as any).__I__;
	globalThis.__J__ *= 6;
	globalThis.__K__ /= 7;
	globalThis.__L__ %= 8;
	globalThis.__M__ &= 9;
	globalThis.__N__ |= 10;
	globalThis.__O__ ^= 11;
	globalThis.__P__ -= 12;
	globalThis.__Q__ >>= 13;
	globalThis.__R__ >>>= 14;
	globalThis.__S__ ||= 15;
	globalThis.__T__ &&= 16;
	const read1 = (globalThis as any).__PI_READ__;
	const read2 = globalThis.__READ2__ === undefined;
	if ((globalThis as any).__READ3__ !== undefined) return;
	const d = `${globalThis.__READ4__}`;
	void g; void h; void k; void read1; void read2; void d;
}'
qa fail "every write form and every alias of globalThis is counted" --only globalThisOwnership --full
# Every compound operator is spelled out instead of leaned on a character class: `*=` fell out of the class
# the moment `**=` was listed, and a write the gate cannot see is a write nobody reviews.
for n in 1 2 3 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do expect_line "site zz-g.ts:$n" "zz-g.ts:$n"; done
expect_absent "a read through a cast is not a write" "zz-g.ts:25"
expect_absent "a comparison is not a write" "zz-g.ts:26"
expect_absent "an if-guard is not a write" "zz-g.ts:27"
dropprobes

echo
echo "output parsing and swallowed errors"
probe zz-j.ts 'export function f(raw: string) {
	const a = JSON.parse(raw);
	const b = JSON["parse"](raw);
	// JSON.parse( mentioned in a comment is not a call
	void a; void b;
}'
qa fail "JSON.parse outside lib/exec.ts fails" --only jsonParseLocation --full
expect_line "plain form" "zz-j.ts:2"
expect_line "bracket form" "zz-j.ts:3"
expect_absent "a mention in a comment is not a call" "zz-j.ts:4"
dropprobes
probe zz-e.ts 'export function f(x: () => void) {
	try { x(); } catch {}
	try { x(); } catch { ; }
	try { x(); } catch { /* best effort: the previous value stays in place */ }
}'
qa fail "an empty catch, and a catch holding only a semicolon, fail" --only emptyCatch --full
expect_line "truly empty" "zz-e.ts:2"
expect_line "semicolon-only" "zz-e.ts:3"
expect_absent "a reason comment satisfies the rule" "zz-e.ts:4"
dropprobes
probe zz-o.ts 'export function f(msg: string) {
	process.stdout.write(msg);
}'
qa fail "writing to stdout fails (stdout belongs to the TUI)" --only noStdioWrites --full
dropprobes

echo
echo "structural wiring"
probe zz-u.ts 'export const unused = 1;'
qa fail "a lib nothing imports fails" --only noUnusedLibs --full
printf 'import { unused } from "./lib/zz-u.ts";\nexport const used = unused;\n' >extensions/lib/zz-v.ts
qa fail "a lib imported only by another dead lib still fails" --only noUnusedLibs --full
cp extensions/tools.ts "$WORK/tools.ts.orig"
printf 'import { used } from "./lib/zz-v.ts";\nexport const entry = used;\n' >>extensions/tools.ts
qa pass "but a lib reachable through another lib is used" --only noUnusedLibs --full
cp "$WORK/tools.ts.orig" extensions/tools.ts
dropprobes
# The orphan's name is assembled at runtime on purpose: checkWiredTests searches every test/*.sh for each
# filename as a substring, and this file is one of those scripts - writing the literal name here would wire
# the orphan up by mentioning it.
ORPHAN=test-zz-orphan
ORPHAN_FILE="test/${ORPHAN}.ts"
printf 'import { test } from "node:test";\ntest("orphan", () => {});\n' >"$ORPHAN_FILE"
qa fail "a test file no suite references fails" --only wiredTests --full
printf 'UNIT_TESTS="%s"\n' "$ORPHAN_FILE" >test/suite-zz.sh
qa pass "and passes once a suite references it" --only wiredTests --full
rm -f "$ORPHAN_FILE" test/suite-zz.sh
mkdir -p skills/zz-fixture
printf -- '---\r\nname: crlf-skill\r\ndescription: written with CRLF line endings\r\n---\r\nbody\r\n' >skills/zz-fixture/SKILL.md
qa pass "CRLF frontmatter is not a missing block" --only frontmatter --full
printf -- '---\nname: this-name-is-deliberately-longer-than-sixty-four-characters-for-the-fixture\ndescription: d\n---\n' >skills/zz-fixture/SKILL.md
qa fail "a name longer than 64 characters fails" --only frontmatter --full
printf -- '---\ndescription: no name at all\n---\n' >skills/zz-fixture/SKILL.md
qa fail "a missing name fails" --only frontmatter --full
rm -rf skills/zz-fixture

echo
echo "the ratchet"
set_baseline() { node -e "const fs=require('fs');const p='scripts/quality-baseline.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));$1;fs.writeFileSync(p,JSON.stringify(j,null,2))"; }
restore_baseline() { cp "$ROOT/scripts/quality-baseline.json" scripts/quality-baseline.json; }

set_baseline "j.metrics.emptyCatch=1"
qa fail "a rise fails --check" --check
expect_text "and reports the size of the rise" "emptyCatch: 49 > baseline 1"
qa fail "--write refuses a rise without a reason" --write
qa pass "--write --reason records it and appends a note" --write --reason "fixture: a deliberate widening"
node -e 'const j=require("./scripts/quality-baseline.json");if(!j.notes.some((n)=>/fixture: a deliberate widening/.test(n.reason)))process.exit(1)' \
  && { echo "  ok    the note is in the baseline"; PASS=$((PASS + 1)); } || { echo "  MISS  no notes entry written"; FAIL=$((FAIL + 1)); }
restore_baseline
set_baseline "j.metrics.emptyCatch=99"
qa pass "a metric far below its baseline is an improvement, not a failure" --check
restore_baseline
qa fail "--write refuses to run with --only (a partial write would drop the other metrics)" --write --only wiredTests
qa fail "--reason refuses to swallow the next flag as its text" --write --reason --only
qa fail "--reason must not be empty" --write --reason ""
set_baseline "j.metrics={}"
qa fail "an emptied metrics object is a hand-edit, not an initial capture" --write
restore_baseline
set_baseline "delete j.notes"
qa fail "a baseline with no notes array is refused by the full gate" --check
qa pass "while the dependency-free path still runs (run.sh calls it before npm install)" --only wiredTests
restore_baseline

echo
echo "new files and grown files"
node -e 'const fs=require("fs");fs.writeFileSync("extensions/lib/zz-big.ts","// filler\n".repeat(600))'
qa fail "a new lib file over the default 500-line budget fails" --only fileLineBudget --full
expect_text "and names the budget" "a new file's budget is 500"
qa fail "--write will not register the larger budget without a reason" --write
qa pass "with a reason it is recorded, and noted" --write --reason "fixture: a deliberately larger new file"
node -e 'const j=require("./scripts/quality-baseline.json");if(!j.notes.some((n)=>/fixture: a deliberately larger/.test(n.reason)))process.exit(1)' \
  && { echo "  ok    the note is in the baseline"; PASS=$((PASS + 1)); } || { echo "  MISS  no notes entry written"; FAIL=$((FAIL + 1)); }
rm -f extensions/lib/zz-big.ts
node -e 'const fs=require("fs");const p="scripts/quality-baseline.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));delete j.files["extensions/lib/ci-verdict.ts"];fs.writeFileSync(p,JSON.stringify(j,null,2))'
qa pass "a file whose entry was lowered keeps passing" --only fileLineBudget --full
node scripts/check-quality.mjs --write >/dev/null 2>&1

echo
echo "a rule switched off while its debt remains"
cp biome.jsonc "$WORK/biome.jsonc.orig"
python3 - <<'PYFIX'
import io
s = io.open("biome.jsonc", encoding="utf-8").read()
assert '"noConsole": "warn"' in s
io.open("biome.jsonc", "w", encoding="utf-8").write(s.replace('"noConsole": "warn"', '"noConsole": "off"', 1))
PYFIX
qa fail "the metric that stopped being reported fails the gate" --check
expect_text "and says why" "has the rule off"
qa fail "--write cannot quietly drop the entry" --write
cp "$WORK/biome.jsonc.orig" biome.jsonc
node -e 'const fs=require("fs");const p="scripts/quality-baseline.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.metrics["biome.suspicious/noDebugger"]=3;fs.writeFileSync(p,JSON.stringify(j,null,2))'
qa fail "a metric that falls to zero is not taken on trust, even with the rule enabled" --check
expect_text "and says what to do about it" "Record the decision"
qa fail "--write will not record a fall to zero without a reason" --write
qa pass "with a reason it is recorded, and noted" --write --reason "fixture: this rule's debt is treated as gone"
restore_baseline

# A partial decrease (147 -> 100) can only mean work was done, so it stays free. A fall to zero cannot be told
# apart from a rule that stopped reporting, so it cannot be free.
node -e 'const fs=require("fs");const p="scripts/quality-baseline.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.metrics["biome.suspicious/noConsole"]=400;fs.writeFileSync(p,JSON.stringify(j,null,2))'
qa pass "a metric measured well below a raised baseline is still an improvement" --check
restore_baseline

echo
echo "a rule silenced by an overrides entry"
cp biome.jsonc "$WORK/biome.jsonc.orig2"
python3 - <<'PYFIX'
import io
s = io.open("biome.jsonc", encoding="utf-8").read()
needle = '"overrides": ['
assert needle in s
block = (
	'"overrides": [\n\t\t{\n\t\t\t"includes": ["extensions/**/*.ts"],\n'
	'\t\t\t"linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } }\n\t\t},\n'
)
io.open("biome.jsonc", "w", encoding="utf-8").write(s.replace(needle, block, 1))
PYFIX
qa fail "the top level still says warn while an override silences 147 sites" --check
expect_text "and the zero is not called an improvement" "147 -> 0"
qa fail "--write cannot record it without a reason" --write
qa pass "a reason records it, so the silencing shows up in the file" --write --reason "fixture: silenced by an overrides entry"
cp "$WORK/biome.jsonc.orig2" biome.jsonc
restore_baseline

echo
echo "biome integrity (through the PI_QA_BIOME test seam)"
STUB=$WORK/stub.sh
printf '#!/bin/sh\necho %s\n' "'{\"results\": []}'" >$STUB; chmod +x $STUB
PI_QA_BIOME=$STUB qa fail "biome output in a shape we do not read is fatal" --check
printf '#!/bin/sh\necho %s\n' "'{}'" >$STUB; chmod +x $STUB
PI_QA_BIOME=$STUB qa fail "an empty object is fatal, not a pass" --check
printf '#!/bin/sh\necho %s\n' "'[{\"foo\": 1}]'" >$STUB; chmod +x $STUB
PI_QA_BIOME=$STUB qa fail "diagnostics with no category are fatal, not zero debt" --check
PI_QA_BIOME=$WORK/definitely-not-biome qa fail "a missing biome is fatal, not skipped" --check
printf '#!/bin/sh\necho %s\n' "'{\"diagnostics\": []}'" >$STUB; chmod +x $STUB
PI_QA_BIOME=$STUB qa fail "a reporter claiming zero debt is not a pass" --check
PI_QA_BIOME=$STUB qa fail "and --write will not lower every biome metric on it" --write
# The seam has to be inert outside the fixtures. This copy has no node_modules, so ignoring the seam means
# biome is genuinely missing and the gate fails saying so - which is the observable proof the stub was never
# consulted, and that an env var alone cannot swap a lint run for a quiet one.
PI_QA_FIXTURES= PI_QA_BIOME=$STUB qa fail "without PI_QA_FIXTURES the stub is not consulted" --check
expect_text "the failure names a missing biome rather than passing" "is not runnable"
export PI_QA_BIOME="$BIOME"

echo
echo "the real tree, measured"
qa pass "the committed tree is within its own baseline" --check

echo
echo "== quality-gate fixtures: $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
