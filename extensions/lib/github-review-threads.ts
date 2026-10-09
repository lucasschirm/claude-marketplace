import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

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
	comments: {
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
		const { stdout } = await execFileAsync("gh", ["repo", "view", "--json", "owner,name"], { cwd });
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
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
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
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              createdAt
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Fetches all review threads for a specific PR in a repository.
 */
export async function fetchReviewThreads(
	prNumber: number,
	cwd: string,
): Promise<GitHubReviewThreadNode[]> {
	const coords = await getRepoCoordinates(cwd);
	const threads: GitHubReviewThreadNode[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const args = [
			"api",
			"graphql",
			"-F",
			`owner=${coords.owner}`,
			"-F",
			`repo=${coords.repo}`,
			"-F",
			`pr=${prNumber}`,
			"-f",
			`query=${FETCH_THREADS_QUERY}`,
		];
		if (cursor) {
			args.push("-F", `cursor=${cursor}`);
		}

		const { stdout } = await execFileAsync("gh", args, { cwd });
		const res = JSON.parse(stdout);
		const prData = res?.data?.repository?.pullRequest;
		if (!prData) {
			break;
		}

		const pageNodes: GitHubReviewThreadNode[] = prData.reviewThreads?.nodes || [];
		threads.push(...pageNodes);

		const pageInfo = prData.reviewThreads?.pageInfo;
		hasNextPage = Boolean(pageInfo?.hasNextPage);
		cursor = pageInfo?.endCursor || null;
	}

	return threads;
}

const REPLY_THREAD_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment {
      id
      databaseId
      body
      createdAt
      author {
        login
      }
    }
  }
}
`;

/**
 * Adds a reply comment to a review thread.
 */
export async function replyToReviewThread(
	threadId: string,
	body: string,
	cwd: string,
): Promise<GitHubCommentNode> {
	const args = [
		"api",
		"graphql",
		"-F",
		`threadId=${threadId}`,
		"-F",
		`body=${body}`,
		"-f",
		`query=${REPLY_THREAD_MUTATION}`,
	];

	const { stdout } = await execFileAsync("gh", args, { cwd });
	const res = JSON.parse(stdout);
	const comment = res?.data?.addPullRequestReviewThreadReply?.comment;
	if (!comment) {
		throw new Error(
			`Failed to add reply to review thread: ${stdout || "Unknown error"}`,
		);
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
export async function resolveReviewThread(
	threadId: string,
	cwd: string,
): Promise<boolean> {
	const args = [
		"api",
		"graphql",
		"-F",
		`threadId=${threadId}`,
		"-f",
		`query=${RESOLVE_THREAD_MUTATION}`,
	];

	const { stdout } = await execFileAsync("gh", args, { cwd });
	const res = JSON.parse(stdout);
	const resolved = res?.data?.resolveReviewThread?.thread?.isResolved;
	return Boolean(resolved);
}

/**
 * Extracts a code suggestion from a comment markdown body if present.
 */
export function extractCodeSuggestion(body: string): { hasSuggestion: boolean; suggestion?: string } {
	const match = body.match(/```suggestion(?:\r?\n([\s\S]*?))?```/);
	if (!match) {
		return { hasSuggestion: false };
	}
	return {
		hasSuggestion: true,
		suggestion: match[1] !== undefined ? match[1] : "",
	};
}

/**
 * Applies a code suggestion to the local workspace file.
 */
export async function applyCodeSuggestion(
	filePath: string,
	startLine: number,
	endLine: number,
	suggestedCode: string,
	cwd: string,
): Promise<void> {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
	const fileContent = await fs.readFile(absolutePath, "utf-8");
	const lines = fileContent.split(/\r?\n/);

	const startIdx = Math.max(0, startLine - 1);
	const endIdx = Math.min(lines.length, endLine);

	const replacementLines = suggestedCode.length > 0 ? suggestedCode.split(/\r?\n/) : [];

	lines.splice(startIdx, endIdx - startIdx, ...replacementLines);
	await fs.writeFile(absolutePath, lines.join("\n"), "utf-8");
}
