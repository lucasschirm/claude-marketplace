// The agy process driver, re-exported as one stable import point.
//
// The server sources under src/agy/ are wired through this top-level entry file on purpose: the
// quality gate (noUnusedLibs) only follows lib/ imports from top-level entry files, and the session
// layer (the ACP methods that manage one AgyProcess per session) will import from here, so the
// surface it sees stays put even if the internals move.

export { AGY_PROBE_EVENT, agyArgs, type AgyProcessOptions } from "./agy/args.ts";
export type { AgyDriverEvent, AgyExitInfo, AgyResultEventDelta } from "./agy/events.ts";
export { AgyProcess } from "./agy/process.ts";
export {
	type AgyCumulative,
	type AgyDeniedAction,
	type AgyEvent,
	type AgyInitEvent,
	type AgyResultEvent,
	type AgyResultStatus,
	type AgyStepState,
	type AgyStepType,
	type AgyStepUpdateEvent,
	type AgySubagentEntry,
	type AgyToolError,
	type AgyToolInfo,
	type AgyUsage,
	ZERO_CUMULATIVE,
	cumulativeOf,
	parseAgyLine,
	resultDeltas,
	type AgyResultDelta,
	type ParsedAgyLine,
} from "./agy/contract.ts";
export {
	checkAgyVersion,
	TESTED_AGY_VERSIONS,
	type AgyVersionStatus,
} from "./agy/version.ts";
export { spawnProcessGroup, type ProcessGroupSpawnOptions } from "./lib/child-process.ts";
