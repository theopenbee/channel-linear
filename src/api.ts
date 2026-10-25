export const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const ISSUES_PAGE_SIZE = 50;
const COMMENTS_PAGE_SIZE = 50;

export interface User {
  id: string;
  name?: string;
  email?: string;
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  user: User | null;
  parentId: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url?: string;
  createdAt: string;
  team: { key: string };
  creator: User | null;
  project: { id: string; name: string } | null;
  comments: Comment[];
}

export interface UploadTicket {
  assetUrl: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export type ReactionTarget = { issueId: string } | { commentId: string };

export class LinearApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = "") {
    super(message);
    this.name = "LinearApiError";
    this.status = status;
    this.code = code;
  }

  get authFailed(): boolean {
    return this.status === 401 || this.code === "AUTHENTICATION_ERROR";
  }
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; userPresentableMessage?: string };
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface CommentConnection {
  pageInfo: PageInfo;
  nodes: Comment[];
}

const COMMENT_FIELDS = "id body createdAt user { id name email } parentId";

const VIEWER_QUERY = "query Viewer { viewer { id name email } }";

const ISSUES_QUERY = `
query Issues($states: [String!]!, $label: String!, $projects: [String!]!, $first: Int!, $after: String, $commentsFirst: Int!) {
  issues(
    filter: {
      state: { name: { in: $states } }
      labels: { name: { eq: $label } }
      project: { name: { in: $projects } }
    }
    orderBy: createdAt
    first: $first
    after: $after
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description url createdAt
      team { key }
      creator { id name email }
      project { id name }
      comments(orderBy: createdAt, first: $commentsFirst) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

const ISSUE_COMMENTS_QUERY = `
query IssueComments($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    comments(orderBy: createdAt, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT_FIELDS} }
    }
  }
}`;

const ISSUE_ID_QUERY = "query IssueId($id: String!) { issue(id: $id) { id } }";

const COMMENT_CREATE_MUTATION = `
mutation CommentCreate($issueId: String!, $body: String!, $parentId: String) {
  commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
    success
    comment { id }
  }
}`;

const FILE_UPLOAD_MUTATION = `
mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size) {
    success
    uploadFile { assetUrl uploadUrl headers { key value } }
  }
}`;

const REACTION_CREATE_MUTATION = `
mutation ReactionCreate($input: ReactionCreateInput!) {
  reactionCreate(input: $input) { success reaction { id } }
}`;

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (maxBytes > 0 && total > maxBytes) {
      throw new LinearApiError(`asset exceeds max size: more than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class LinearApi {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = DEFAULT_ENDPOINT,
  ) {}

  async graphql<T>(op: string, query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: withTimeout(REQUEST_TIMEOUT_MS, signal),
      });
    } catch (err) {
      throw new LinearApiError(`${op}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: { data?: T; errors?: GraphQLError[] } | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const first = body?.errors?.[0];
    if (first) {
      const message = first.extensions?.userPresentableMessage || first.message || "unknown error";
      throw new LinearApiError(`${op}: ${message}`, res.status, first.extensions?.code ?? "");
    }
    if (!res.ok) {
      throw new LinearApiError(`${op}: http ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    if (!body || body.data === undefined || body.data === null) {
      throw new LinearApiError(`${op}: empty response`, res.status);
    }
    return body.data;
  }

  async viewer(signal?: AbortSignal): Promise<User> {
    const data = await this.graphql<{ viewer: User }>("viewer", VIEWER_QUERY, {}, signal);
    return data.viewer;
  }

  async issuesInStates(states: string[], label: string, projects: string[], signal?: AbortSignal): Promise<Issue[]> {
    const all: Issue[] = [];
    let after: string | null = null;
    for (let page = 1; ; page++) {
      type Node = Omit<Issue, "comments"> & { comments: CommentConnection };
      const data: { issues: { pageInfo: PageInfo; nodes: Node[] } } = await this.graphql(
        "issues",
        ISSUES_QUERY,
        { states, label, projects, first: ISSUES_PAGE_SIZE, after, commentsFirst: COMMENTS_PAGE_SIZE },
        signal,
      );
      for (const node of data.issues.nodes) {
        const comments = [...node.comments.nodes];
        if (node.comments.pageInfo.hasNextPage) {
          comments.push(...(await this.commentsAfter(node.id, node.comments.pageInfo.endCursor, signal)));
        }
        all.push({ ...node, comments });
      }
      if (!data.issues.pageInfo.hasNextPage) return all;
      if (!data.issues.pageInfo.endCursor) throw new LinearApiError(`issues: page ${page} has no end cursor`);
      after = data.issues.pageInfo.endCursor;
    }
  }

  private async commentsAfter(issueId: string, cursor: string | null, signal?: AbortSignal): Promise<Comment[]> {
    const all: Comment[] = [];
    let after = cursor;
    while (after) {
      const data: { issue: { comments: CommentConnection } } = await this.graphql(
        "issueComments",
        ISSUE_COMMENTS_QUERY,
        { issueId, first: COMMENTS_PAGE_SIZE, after },
        signal,
      );
      all.push(...data.issue.comments.nodes);
      if (!data.issue.comments.pageInfo.hasNextPage) return all;
      after = data.issue.comments.pageInfo.endCursor;
    }
    throw new LinearApiError(`issueComments: issue ${issueId} is missing an end cursor`);
  }

  async issueId(idOrIdentifier: string, signal?: AbortSignal): Promise<string> {
    const data = await this.graphql<{ issue: { id: string } | null }>("issue", ISSUE_ID_QUERY, { id: idOrIdentifier }, signal);
    if (!data.issue?.id) throw new LinearApiError(`issue ${idOrIdentifier} not found`);
    return data.issue.id;
  }

  async createComment(issueId: string, body: string, parentId: string | null, signal?: AbortSignal): Promise<string> {
    const data = await this.graphql<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
      "commentCreate",
      COMMENT_CREATE_MUTATION,
      { issueId, body, parentId },
      signal,
    );
    if (!data.commentCreate.success || !data.commentCreate.comment?.id) {
      throw new LinearApiError("commentCreate: not successful");
    }
    return data.commentCreate.comment.id;
  }

  async createReaction(target: ReactionTarget, emoji: string, signal?: AbortSignal): Promise<void> {
    const data = await this.graphql<{ reactionCreate: { success: boolean } }>(
      "reactionCreate",
      REACTION_CREATE_MUTATION,
      { input: { emoji, ...target } },
      signal,
    );
    if (!data.reactionCreate.success) throw new LinearApiError("reactionCreate: not successful");
  }

  async fileUpload(filename: string, contentType: string, size: number, signal?: AbortSignal): Promise<UploadTicket> {
    const data = await this.graphql<{
      fileUpload: {
        success: boolean;
        uploadFile: { assetUrl: string; uploadUrl: string; headers: { key: string; value: string }[] } | null;
      };
    }>("fileUpload", FILE_UPLOAD_MUTATION, { filename, contentType, size }, signal);
    const file = data.fileUpload.uploadFile;
    if (!data.fileUpload.success || !file) throw new LinearApiError("fileUpload: not successful");
    const headers: Record<string, string> = {};
    for (const h of file.headers ?? []) headers[h.key] = h.value;
    return { assetUrl: file.assetUrl, uploadUrl: file.uploadUrl, headers };
  }

  async put(ticket: UploadTicket, data: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { ...ticket.headers };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = contentType;
    let res: Response;
    try {
      res = await fetch(ticket.uploadUrl, {
        method: "PUT",
        headers,
        body: new Uint8Array(data),
        signal: withTimeout(UPLOAD_TIMEOUT_MS, signal),
      });
    } catch (err) {
      throw new LinearApiError(`upload: ${err instanceof Error ? err.message : String(err)}`);
    }
    await res.body?.cancel();
    if (!res.ok) throw new LinearApiError(`upload: http ${res.status}`, res.status);
  }

  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType: string }> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: this.apiKey },
        signal: withTimeout(DOWNLOAD_TIMEOUT_MS, signal),
      });
    } catch (err) {
      throw new LinearApiError(`download: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new LinearApiError(`download: http ${res.status}: ${text}`, res.status);
    }
    const length = Number(res.headers.get("content-length") ?? "");
    if (maxBytes > 0 && Number.isFinite(length) && length > maxBytes) {
      await res.body?.cancel();
      throw new LinearApiError(`asset exceeds max size: ${length} bytes (max ${maxBytes})`);
    }
    const data = await readLimited(res, maxBytes);
    return { data, contentType: res.headers.get("content-type") ?? "" };
  }
}
