import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

// A hung gh call would otherwise block every sync and task action waiting on it. Mutations get
// longer, since a timed-out one may still have been applied.
export const FETCH_TIMEOUT_MS = 60_000; // (also for other read-only gh/git calls)
const MUTATION_TIMEOUT_MS = 120_000;

export interface GitHubCommentNode {
	id: string;
	databaseId?: number;
	body: string;
	createdAt: string;
	author?: {
		login: string;
	} | null;
}

export interface GitHubReviewThreadNode {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	path: string;
	line: number | null;
	originalLine: number | null;
	startLine: number | null;
	originalStartLine: number | null;
	diffSide?: "LEFT" | "RIGHT" | null;
	startDiffSide?: "LEFT" | "RIGHT" | null;
	comments: {
		totalCount?: number;
		nodes: GitHubCommentNode[];
	};
}

export interface RepoCoordinates {
	owner: string;
	repo: string;
}

const repoCache = new Map<string, RepoCoordinates>();

/**
 * Resolves repository owner and name for a given working directory.
 */
export async function getRepoCoordinates(cwd: string): Promise<RepoCoordinates> {
	const cached = repoCache.get(cwd);
	if (cached) return cached;

	try {
		const { stdout } = await execFileAsync("gh", ["repo", "view", "--json", "owner,name"], { cwd, timeout: FETCH_TIMEOUT_MS });
		const data = JSON.parse(stdout);
		const coords: RepoCoordinates = {
			owner: data.owner?.login || data.owner,
			repo: data.name,
		};
		if (coords.owner && coords.repo) {
			repoCache.set(cwd, coords);
			return coords;
		}
	} catch {}

	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: FETCH_TIMEOUT_MS });
		const url = stdout.trim();
		const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
		if (match) {
			const coords: RepoCoordinates = { owner: match[1], repo: match[2] };
			repoCache.set(cwd, coords);
			return coords;
		}
	} catch {}

	throw new Error(`Unable to determine repository owner and name in ${cwd}`);
}

const THREAD_COMMENT_FRAGMENT = `
fragment ThreadComment on PullRequestReviewComment {
  id
  databaseId
  body
  createdAt
  author {
    login
  }
}
`;

const FETCH_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      id
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          comments(first: 100) {
            totalCount
            nodes {
              ...ThreadComment
            }
          }
        }
      }
    }
  }
}

${THREAD_COMMENT_FRAGMENT}`;

/**
 * Fetches all review threads for a specific PR in a repository.
 * Throws instead of returning a partial list, since callers treat the result as the PR's full thread list.
 */
export async function fetchReviewThreads(prNumber: number, cwd: string): Promise<GitHubReviewThreadNode[]> {
	const coords = await getRepoCoordinates(cwd);
	const threads: GitHubReviewThreadNode[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const args = [
			"api",
			"graphql",
			// String values use -f (raw): -F would read a value starting with "@" as a file path
			"-f",
			`owner=${coords.owner}`,
			"-f",
			`repo=${coords.repo}`,
			"-F",
			`pr=${prNumber}`,
			"-f",
			`query=${FETCH_THREADS_QUERY}`,
		];
		if (cursor) {
			args.push("-f", `cursor=${cursor}`);
		}

		// A page of 100 threads with long comments easily exceeds execFile's 1 MB default
		const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS });
		const res = JSON.parse(stdout);
		const prData = res?.data?.repository?.pullRequest;
		if (res?.errors?.length || !prData?.reviewThreads) {
			// (only the error messages: stdout may hold a whole page of thread data)
			throw new Error(
				`Failed to fetch review threads for PR #${prNumber}: ${responseErrorMessages(res) || "no review threads in the response"}`,
			);
		}

		const pageNodes: GitHubReviewThreadNode[] = prData.reviewThreads?.nodes || [];
		const withLatest = await Promise.all(
			pageNodes.map(async (node) => {
				// A long thread's newest replies are past the first page of comments: fetch them too
				const long = (node.comments?.totalCount ?? 0) > (node.comments?.nodes?.length ?? 0);
				if (!long) return node;
				try {
					return withLatestComments(node, await fetchLatestComments(node.id, cwd));
				} catch {
					// (e.g. a thread GitHub lists but rejects by ID): its first page still counts as listed
					return node;
				}
			}),
		);
		threads.push(...withLatest);

		const pageInfo = prData.reviewThreads?.pageInfo;
		hasNextPage = Boolean(pageInfo?.hasNextPage);
		cursor = pageInfo?.endCursor || null;
		if (hasNextPage && !cursor) {
			// Refetching the first page would loop forever, and a partial list would mark tasks STALE
			throw new Error(`Failed to fetch review threads for PR #${prNumber}: GitHub reported more pages without a cursor`);
		}
	}

	return threads;
}

const LATEST_COMMENTS_QUERY = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(last: 100) {
        nodes {
          ...ThreadComment
        }
      }
    }
  }
}
${THREAD_COMMENT_FRAGMENT}`;

async function fetchLatestComments(threadId: string, cwd: string): Promise<GitHubCommentNode[]> {
	const args = ["api", "graphql", "-f", `threadId=${threadId}`, "-f", `query=${LATEST_COMMENTS_QUERY}`];
	const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS });
	const res = JSON.parse(stdout);
	const comments = res?.data?.node?.comments?.nodes;
	if (res?.errors?.length || !Array.isArray(comments)) {
		throw new Error(
			`Failed to fetch the latest comments of review thread ${threadId}: ${responseErrorMessages(res) || "no comments in the response"}`,
		);
	}
	return comments;
}

const repoRootCache = new Map<string, string>();

async function repoRoot(cwd: string): Promise<string> {
	const cached = repoRootCache.get(cwd);
	if (cached) return cached;
	// (no fallback to cwd: below the root, the same relative path can name another file)
	const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: FETCH_TIMEOUT_MS });
	const root = stdout.trim();
	if (!root) throw new Error(`could not determine the repository root of ${cwd}`);
	repoRootCache.set(cwd, root);
	return root;
}

/**
 * Merges a thread's newest comments into its first page of comments, so a thread with more than
 * 100 comments keeps its root comment and its latest replies (only middle ones can be missing).
 */
export function withLatestComments(node: GitHubReviewThreadNode, latestComments: GitHubCommentNode[]): GitHubReviewThreadNode {
	const first = node.comments?.nodes || [];
	const latest = latestComments.filter((c) => !first.some((f) => f.id === c.id));
	return { ...node, comments: { nodes: [...first, ...latest] } };
}

/**
 * True when a GitHub API error says the given node ID can't be resolved: the node no longer
 * exists (e.g. a review thread replaced after a PR merge) or the token can't see it. Only that
 * exact message counts, not any NOT_FOUND error (which may also be an access problem), and
 * callers should surface the error text alongside the outcome.
 */
export function isStaleNodeError(err: unknown): boolean {
	return /Could not resolve to a node with the global id/i.test(ghErrorText(err));
}

const MAX_ERROR_LENGTH = 2000;

/**
 * The GitHub response text of a failed `gh` call, shortened for tool results and task reasons.
 * A failed execFile's message embeds the full command line (including any reply body), so its
 * stderr/stdout are preferred over the message.
 */
export function describeGhError(err: unknown): string {
	const text = ghErrorText(err);
	return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}… (truncated)` : text;
}

function graphqlErrorMessages(stdout: string | undefined): string | undefined {
	try {
		return responseErrorMessages(JSON.parse(stdout || ""));
	} catch {
		return undefined;
	}
}

/**
 * The error messages of a parsed GraphQL response, if it has errors.
 */
function responseErrorMessages(res: any): string | undefined {
	const errors = res?.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	return errors.map((e: { message?: string; type?: string }) => e?.message || e?.type || "unknown error").join("; ");
}

function ghErrorText(err: unknown): string {
	const e = err as { message?: string; stderr?: string; stdout?: string; code?: unknown; killed?: boolean; signal?: string } | undefined;
	// Not a gh failure (gh missing, output over maxBuffer: a Node error code), or gh was stopped:
	// any partial output isn't an error message
	if (typeof e?.code === "string") return String(e.message ?? e.code).trim();
	if (e?.killed || e?.signal) {
		const applied = (err as { mayHaveApplied?: boolean }).mayHaveApplied ? "; the change may already be on GitHub" : "";
		return `gh was stopped (${e.signal ?? "killed"}), e.g. by its timeout${applied}`;
	}
	// A GraphQL error response on stdout may also hold data (a whole page of threads): keep its messages
	const messages = graphqlErrorMessages(e?.stdout);
	if (messages) return [e?.stderr?.trim(), messages].filter(Boolean).join("\n");
	if (e?.stderr !== undefined || e?.stdout !== undefined) {
		const output = [e?.stderr, e?.stdout].filter(Boolean).join("\n").trim();
		// No output (e.g. gh missing or killed): the message is all there is
		if (output) return output;
	}
	return String(e?.message ?? err ?? "").trim();
}

/**
 * Runs a gh mutation. One stopped midway (e.g. by its timeout) is flagged, since GitHub may have
 * applied it anyway (see describeGhError).
 */
async function runMutation(args: string[], cwd: string): Promise<{ stdout: string }> {
	try {
		return await execFileAsync("gh", args, { cwd, timeout: MUTATION_TIMEOUT_MS });
	} catch (err) {
		const e = err as { killed?: boolean; signal?: string; mayHaveApplied?: boolean };
		if (e?.killed || e?.signal) e.mayHaveApplied = true;
		throw err;
	}
}

const REPLY_THREAD_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment {
      ...ThreadComment
    }
  }
}
${THREAD_COMMENT_FRAGMENT}`;

/**
 * Adds a reply comment to a review thread.
 */
export async function replyToReviewThread(threadId: string, body: string, cwd: string): Promise<GitHubCommentNode> {
	const args = [
		"api",
		"graphql",
		// -f (raw string): with -F, gh would read a body starting with "@" as a file and post its contents
		"-f",
		`threadId=${threadId}`,
		"-f",
		`body=${body}`,
		"-f",
		`query=${REPLY_THREAD_MUTATION}`,
	];

	const { stdout } = await runMutation(args, cwd);
	const res = JSON.parse(stdout);
	const comment = res?.data?.addPullRequestReviewThreadReply?.comment;
	if (!comment) {
		throw new Error(`Failed to add reply to review thread: ${stdout || "Unknown error"}`);
	}
	return comment;
}

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
    }
  }
}
`;

/**
 * Resolves a review thread on GitHub.
 */
export async function resolveReviewThread(threadId: string, cwd: string): Promise<boolean> {
	const args = ["api", "graphql", "-f", `threadId=${threadId}`, "-f", `query=${RESOLVE_THREAD_MUTATION}`];

	const { stdout } = await runMutation(args, cwd);
	const res = JSON.parse(stdout);
	const resolved = res?.data?.resolveReviewThread?.thread?.isResolved;
	return Boolean(resolved);
}

/**
 * Extracts a code suggestion from a comment markdown body if present.
 */
export function extractCodeSuggestion(body: string): { hasSuggestion: boolean; suggestion?: string } {
	// The closing fence is a line of its own, at least as long as the opening one, so a
	// ````suggestion block can contain ``` lines (and code can contain ``` mid-line).
	const match = body.match(/(?<!`)(`{3,})suggestion(?:[^\S\r\n]*\r?\n([\s\S]*?)^ {0,3}\1`*[^\S\r\n]*$|\1)/m);
	if (!match) {
		return { hasSuggestion: false };
	}
	return {
		hasSuggestion: true,
		suggestion: match[2] !== undefined ? match[2] : "",
	};
}

/**
 * True when `target` is inside `root` (never equal to it). `path.relative` rather than
 * `startsWith`, so `/repo-evil/x` is not mistaken for a path inside `/repo`.
 *
 * POSIX-only in practice: Windows drive-relative forms (`C:foo`, `C:..`) are not
 * special-cased. resolveRepoFilePath rejects every absolute path first, and CI runs on
 * Linux - adding drive-letter rules with no Windows job to execute them would ship
 * untested behaviour.
 */
/**
 * Whether a directory *is* git metadata: `<repo>/.git`, a bare clone (`name.git`), or a linked worktree's
 * gitdir under `.git/worktrees/`.
 *
 * Today's only caller cannot hand one here: `repoRoot()` runs `git rev-parse --show-toplevel`, and that was
 * measured to fail with "this operation must be run in a work tree" inside `.git`, inside a bare repo and
 * inside a linked worktree's gitdir - it never prints a `.git` path. The guard is for the layer below:
 * `resolveRepoFilePath` is exported, and a `.git` *segment* test cannot see a root that IS the git directory
 * (relative to `<repo>/.git`, the path `config` has no `.git` segment). Any caller that resolves a repo
 * differently - `--absolute-git-dir`, a stored path, `--git-dir`/`--work-tree` in the environment - would
 * otherwise be one string away from rewriting hooks or config.
 */
/**
 * Is `dir` a git directory rather than a working tree?
 *
 * Identity comes from two places: the `.git` convention, and the layout on disk. What it no longer uses is the
 * `*.git` *suffix*, which was wrong in both directions - `git init --bare work` carries no suffix and was
 * accepted, while a legitimate checkout called `release.git` was refused. A git directory is the one holding
 * `HEAD` plus `objects/` and `refs/` (a bare repo, `<repo>/.git`, or a `--separate-git-dir` directory), or the
 * linked-worktree form, which keeps `commondir`/`gitdir` pointer files instead of its own objects.
 */
export function isGitMetadataDir(dir: string): boolean {
	const abs = path.resolve(dir);
	// `.git` itself, or anything beneath it, is metadata by convention - git will use that directory the moment
	// it appears. Kept because a not-yet-populated `.git` has no layout to recognise yet.
	if (/(^|[/\\])\.git([/\\]|$)/i.test(abs)) return true;
	const isFile = (p: string) => {
		try {
			return fsSync.statSync(p).isFile();
		} catch {
			return false;
		}
	};
	const isDir = (p: string) => {
		try {
			return fsSync.statSync(p).isDirectory();
		} catch {
			return false;
		}
	};
	if (!isFile(path.join(abs, "HEAD"))) return false;
	if (isDir(path.join(abs, "objects")) && isDir(path.join(abs, "refs"))) return true;
	return isFile(path.join(abs, "commondir")) || isFile(path.join(abs, "gitdir"));
}

/**
 * The git directory belonging to a working root, canonicalised. A linked worktree keeps a `.git` *file* whose
 * `gitdir:` line points at the real metadata directory, so the path alone is not enough.
 */
async function gitMetadataDirs(root: string): Promise<string[]> {
	const found: string[] = [];
	const dotGit = path.join(root, ".git");
	try {
		const st = await fs.stat(dotGit);
		if (st.isDirectory()) {
			found.push(await fs.realpath(dotGit));
		} else if (st.isFile()) {
			const text = await fs.readFile(dotGit, "utf-8");
			const target = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
			if (target) {
				const abs = path.resolve(root, target);
				found.push(await fs.realpath(abs).catch(() => abs));
			}
		}
	} catch {
		// No .git at all: a bare root is rejected by isGitMetadataDir above, so there is nothing to derive.
	}
	return found;
}

/** True when `target` is `dir` or lives beneath it. */
function isWithinDir(dir: string, target: string): boolean {
	return target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

export function isInsideDir(root: string, target: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(target));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves a GitHub-reported file path against the repository root and refuses anything that does not
 * land inside it. This edits the working tree, so containment is checked before any I/O: a suggestion
 * payload is external input, and an absolute path or `../../` segments used to reach the filesystem
 * straight through.
 */
export async function resolveRepoFilePath(repoRootDir: string, filePath: string): Promise<string> {
	if (!filePath) throw new Error("suggestion path is empty");
	if (filePath.includes("\0")) throw new Error("suggestion path contains a NUL byte");
	if (path.isAbsolute(filePath)) {
		throw new Error(`suggestion path '${filePath}' must be repository-relative`);
	}
	const root = path.resolve(repoRootDir);
	if (isGitMetadataDir(root)) {
		// In a bare repository or a linked worktree the root IS git metadata, and the segment check below is
		// blind there: relative to `<repo>/.git`, the path `config` has no `.git` segment at all. A suggestion
		// payload could rewrite hooks or config - a code-execution primitive, not a bad edit.
		throw new Error(`suggestion cannot be applied: '${root}' is a git metadata directory, not a working tree`);
	}
	const absolute = path.resolve(root, filePath);
	if (!isInsideDir(root, absolute)) {
		throw new Error(`suggestion path '${filePath}' resolves outside the repository (${root})`);
	}
	const relativeSegments = absolute.slice(root.length + 1).split(path.sep);
	if (relativeSegments.some((segment) => segment.toLowerCase() === ".git")) {
		// Unreachable from the GitHub API, which never suggests .git paths - but a write into
		// hooks/ or config is a code-execution primitive, not just a bad edit. Every segment, and
		// case-insensitively: on a case-insensitive filesystem `.GIT` resolves into the real .git,
		// and the realpath re-check below does not re-apply this rule.
		throw new Error(`suggestion path '${filePath}' targets the git directory`);
	}
	return absolute;
}

/**
 * Applies a code suggestion to the local workspace file.
 *
 * `startLine`/`endLine` arrive from the GraphQL API, where a comment on a deleted line has no line
 * number at all: they are optional here and validated, because a missing one used to pass the range
 * check below (`undefined > lines.length` is false), make `slice(startIdx, undefined)` span the rest
 * of the file and `splice(startIdx, NaN, …)` delete nothing - inserting the suggestion instead of
 * replacing the reviewed lines.
 */
export async function applyCodeSuggestion(
	filePath: string,
	startLine: number | undefined,
	endLine: number | undefined,
	suggestedCode: string,
	cwd: string,
): Promise<void> {
	if (
		typeof startLine !== "number" ||
		typeof endLine !== "number" ||
		!Number.isInteger(startLine) ||
		!Number.isInteger(endLine) ||
		startLine > endLine
	) {
		throw new Error(
			`suggestion lines ${String(startLine)}-${String(endLine)} are not a usable line range; ` +
				"the comment is probably on a deleted line, so its suggestion cannot be applied",
		);
	}

	// GitHub paths are relative to the repository root, which cwd may be below
	const root = await repoRoot(cwd);
	const absolutePath = await resolveRepoFilePath(root, filePath);
	const fileContent = await fs.readFile(absolutePath, "utf-8");
	// Each line keeps its own terminator, so line endings outside the replaced range never change
	const lines = fileContent.split(/(?<=\n)/);
	const terminator = (line: string | undefined) => line?.match(/\r?\n$/)?.[0];

	if (startLine < 1 || endLine > lines.length || startLine > endLine) {
		throw new Error(`lines ${startLine}-${endLine} are not in the file (${lines.length} lines); it may have changed locally`);
	}
	const startIdx = startLine - 1;
	const replaced = lines.slice(startIdx, endLine);
	// New lines end like the replaced ones (the last one keeps the last replaced line's ending,
	// which is none at the end of a file without a final newline)
	const eol = terminator(replaced.find((l) => terminator(l))) ?? terminator(lines.find((l) => terminator(l))) ?? "\n";
	const lastEol = replaced.length > 0 ? (terminator(replaced[replaced.length - 1]) ?? "") : eol;

	// A suggestion block's text ends with the newline before the closing fence; it doesn't add a line
	const suggestionBody = suggestedCode.replace(/\r?\n$/, "");
	const replacementLines = suggestedCode.length > 0 ? suggestionBody.split(/\r?\n/) : [];

	const newLines = replacementLines.map((l, i) => l + (i === replacementLines.length - 1 ? lastEol : eol));
	lines.splice(startIdx, endLine - startIdx, ...newLines);
	if (newLines.length === 0 && endLine === lines.length + replaced.length && lastEol === "" && startIdx > 0) {
		// Deleting the last lines of a file without a final newline: the new last line has none either
		lines[startIdx - 1] = lines[startIdx - 1].replace(/\r?\n$/, "");
	}
	// The lexical check above cannot see symlinks. Resolve them and write the *resolved* target, so
	// the containment decision and the write are about the same file - writing the unresolved path
	// would leave a window in which the link is swapped to point outside the repository.
	const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(absolutePath)]);
	if (!isInsideDir(realRoot, realTarget)) {
		throw new Error(`suggestion path '${filePath}' resolves outside the repository through a link (${realTarget})`);
	}
	// Containment is satisfied by anything inside the root - and `.git` is inside the root. A tracked symlink
	// pointing at `.git/config` therefore passed every check above and wrote straight into the metadata, which
	// is where hooks/ lives. Re-check the *resolved* target against the canonical metadata directory.
	for (const metaDir of await gitMetadataDirs(realRoot)) {
		if (isWithinDir(metaDir, realTarget)) {
			throw new Error(`suggestion path '${filePath}' resolves into the git directory through a link (${realTarget})`);
		}
	}
	await fs.writeFile(realTarget, lines.join(""), "utf-8");
}
