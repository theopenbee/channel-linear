import type { Attachment, InboundMessage } from "@theopenbee/channel-sdk";

import type { Comment, Issue } from "./api.js";

export const BOT_COMMENT_PREFIX = "[openbee-bot]";
export const BOT_MARKER = BOT_COMMENT_PREFIX + "\n\n";

export interface ReplyTarget {
  issue_id: string;
  parent_comment_id?: string;
}

export interface Resolved {
  text: string;
  attachments: Attachment[];
}

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  "μs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDuration(value: string): number | undefined {
  const s = value.trim();
  if (!s) return undefined;
  const re = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return undefined;
    total += Number(m[1]) * UNIT_MS[m[2]];
    pos = re.lastIndex;
  }
  return total;
}

export function isBotComment(body: string): boolean {
  return body.startsWith(BOT_COMMENT_PREFIX);
}

export function userName(user: Comment["user"]): string {
  return user?.name || user?.email || user?.id || "unknown";
}

export function mergeIssueContent(issue: Issue, description: string, comments: Comment[]): string {
  let out = "";
  if (issue.project) out += `[Project: ${issue.project.name}]\n\n`;
  out += issue.title;
  if (description) out += "\n\n" + description;
  if (comments.length > 0) {
    out += `\n\n---\nComments (${comments.length}):\n`;
    for (const c of comments) out += `\n[${userName(c.user)}]: ${c.body}`;
  }
  return out;
}

function timeOf(iso: string): number | undefined {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function issueContext(issue: Issue): Record<string, unknown> {
  const context: Record<string, unknown> = { issue_id: issue.id, identifier: issue.identifier, title: issue.title };
  if (issue.url) context.url = issue.url;
  if (issue.project) context.project = issue.project.name;
  return context;
}

function inbound(issue: Issue, fields: Omit<InboundMessage, "chat_id" | "session_scope" | "context">): InboundMessage {
  const message: InboundMessage = {
    chat_id: issue.team.key,
    session_scope: issue.identifier,
    ...fields,
    context: issueContext(issue),
  };
  if (message.time === undefined) delete message.time;
  if (message.attachments?.length === 0) delete message.attachments;
  return message;
}

export function initialInbound(issue: Issue, description: Resolved, comments: { comment: Comment; body: Resolved }[]): InboundMessage {
  const resolvedComments = comments.map(({ comment, body }) => ({ ...comment, body: body.text }));
  const raw: ReplyTarget = { issue_id: issue.id };
  return inbound(issue, {
    sender_id: issue.creator?.id || "unknown",
    message_id: "issue:" + issue.id,
    text: mergeIssueContent(issue, description.text, resolvedComments),
    attachments: [...description.attachments, ...comments.flatMap(({ body }) => body.attachments)],
    raw: JSON.stringify(raw),
    time: timeOf(issue.createdAt) ?? Date.now(),
  });
}

export function commentInbound(issue: Issue, comment: Comment, body: Resolved): InboundMessage {
  const raw: ReplyTarget = { issue_id: issue.id, parent_comment_id: comment.parentId ?? comment.id };
  return inbound(issue, {
    sender_id: comment.user?.id || "unknown",
    message_id: "comment:" + comment.id,
    text: body.text,
    attachments: body.attachments,
    raw: JSON.stringify(raw),
    time: timeOf(comment.createdAt),
  });
}

export function parseReplyTarget(raw: string | undefined): ReplyTarget | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ReplyTarget>;
    if (typeof value?.issue_id !== "string" || !value.issue_id) return undefined;
    const target: ReplyTarget = { issue_id: value.issue_id };
    if (typeof value.parent_comment_id === "string" && value.parent_comment_id) target.parent_comment_id = value.parent_comment_id;
    return target;
  } catch {
    return undefined;
  }
}

export function safeExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? "." + m[1].toLowerCase() : "";
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number, signal?: AbortSignal): Promise<T> {
  let delay = delayMs;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || signal?.aborted) throw err;
    }
    await sleep(delay, signal);
    if (signal?.aborted) throw new Error("cancelled");
    delay *= 2;
  }
}
