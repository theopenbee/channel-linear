import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { ConfigError, type Attachment, type ChannelContext, type ChannelDefinition, type InboundMessage, type SendRequest } from "@theopenbee/channel-sdk";

import { DEFAULT_ENDPOINT, LinearApi, LinearApiError, isRetryableDownload, type Comment, type Issue, type ReactionTarget } from "./api.js";
import { ASSET_PREFIX, extractAssets, splice, type AssetMatch } from "./assets.js";
import {
  BOT_MARKER,
  commentInbound,
  errorText,
  initialInbound,
  isBotComment,
  parseDuration,
  parseReplyTarget,
  retry,
  safeExtension,
  sleep,
  type Resolved,
} from "./helpers.js";
import { detectMime, extensionFromMime, mediaTypeFromMime } from "./mime.js";
import { SEEN_COMMENTS_FILE, SEEN_ISSUES_FILE, SeenSet, importLegacy, legacyStateDir } from "./seen.js";

export const DEFAULT_LABEL = "openbee";
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_MEDIA_SIZE = 50 * 1024 * 1024;
export const REACTION_EMOJI = ":eyes:";

const RESOLVE_CONCURRENCY = 4;
const GENERIC_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

export interface LinearConfig {
  apiKey: string;
  labelName: string;
  projects: string[];
  states: string[];
  pollIntervalMs: number;
  maxMediaSize: number;
}

export interface Timings {
  retryAttempts: number;
  retryDelayMs: number;
  downloadAttempts: number;
}

export interface LinearOptions {
  endpoint?: string;
  assetPrefix?: string;
  legacyDir?: string;
  timings?: Partial<Timings>;
}

const DEFAULT_TIMINGS: Timings = { retryAttempts: 5, retryDelayMs: 500, downloadAttempts: 3 };

function stringValue(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value.trim() : "";
}

function listValue(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

export function readConfig(raw: Record<string, unknown>): LinearConfig {
  const apiKey = stringValue(raw, "api_key");
  if (!apiKey) throw new ConfigError("api_key is required; create one at https://linear.app/settings/api");
  const projects = listValue(raw, "projects");
  if (projects.length === 0) throw new ConfigError("projects is required; list the Linear project names to watch");
  const states = listValue(raw, "states");
  if (states.length === 0) throw new ConfigError("states is required; list the workflow state names to watch");
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  const interval = stringValue(raw, "poll_interval");
  if (interval) {
    const parsed = parseDuration(interval);
    if (parsed === undefined || parsed <= 0) throw new ConfigError(`poll_interval ${JSON.stringify(interval)} is not a duration such as 10s or 1m`);
    pollIntervalMs = parsed;
  }
  const maxMediaSize = raw.max_media_size;
  return {
    apiKey,
    labelName: stringValue(raw, "label_name") || DEFAULT_LABEL,
    projects,
    states,
    pollIntervalMs,
    maxMediaSize: typeof maxMediaSize === "number" && Number.isInteger(maxMediaSize) && maxMediaSize > 0 ? maxMediaSize : DEFAULT_MAX_MEDIA_SIZE,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createLinearChannel(options: LinearOptions = {}): ChannelDefinition {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const assetPrefix = options.assetPrefix ?? ASSET_PREFIX;
  const timings: Timings = { ...DEFAULT_TIMINGS, ...options.timings };
  let api: LinearApi | undefined;
  let cfg: LinearConfig | undefined;

  const resolveAsset = async (ctx: ChannelContext, m: AssetMatch, signal: AbortSignal): Promise<{ text: string; attachment?: Attachment }> => {
    try {
      const { data, contentType } = await retry(() => api!.download(m.url, cfg!.maxMediaSize, signal), timings.downloadAttempts, timings.retryDelayMs, signal, (err) => {
        if (!isRetryableDownload(err)) return false;
        ctx.log.warn("download attachment failed, retrying", { url: m.url, error: errorText(err) });
        return true;
      });
      const mime = contentType && !GENERIC_TYPES.has(contentType.split(";")[0].trim()) ? contentType : detectMime(data, m.name);
      const path = await ctx.saveMedia(data, safeExtension(m.name) || extensionFromMime(mime));
      const type = mediaTypeFromMime(mime);
      const label = m.name || basename(path);
      return {
        text: `[${type === "image" ? "image" : "file"}: ${label}]`,
        attachment: m.name ? { type, path, name: m.name } : { type, path },
      };
    } catch (err) {
      if (signal.aborted) throw err;
      ctx.log.warn("download attachment failed", { url: m.url, error: errorText(err) });
      return { text: m.isImage ? `![${m.name}](${m.url})` : `[${m.name}](${m.url})` };
    }
  };

  const resolve = async (ctx: ChannelContext, text: string, signal: AbortSignal): Promise<Resolved> => {
    const matches = extractAssets(text, assetPrefix);
    if (matches.length === 0) return { text, attachments: [] };
    const results = await mapLimit(matches, RESOLVE_CONCURRENCY, (m) => resolveAsset(ctx, m, signal));
    return {
      text: splice(text, matches, results.map((r) => r.text)),
      attachments: results.flatMap((r) => (r.attachment ? [r.attachment] : [])),
    };
  };

  const upload = async (path: string, name: string, signal: AbortSignal): Promise<string> => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`upload path is not a file: ${path}`);
    if (info.size > cfg!.maxMediaSize) throw new Error(`file too large: ${info.size} bytes (max ${cfg!.maxMediaSize})`);
    const data = new Uint8Array(await readFile(path));
    const fileName = name || basename(path);
    const mime = detectMime(data, fileName);
    const ticket = await api!.fileUpload(fileName, mime, data.length, signal);
    await api!.put(ticket, data, mime, signal);
    const markdown = `[${fileName}](${ticket.assetUrl})`;
    return mediaTypeFromMime(mime) === "image" ? "!" + markdown : markdown;
  };

  return {
    async start(ctx: ChannelContext) {
      cfg = readConfig(ctx.config);
      api = new LinearApi(cfg.apiKey, endpoint);
      const config = cfg;
      const client = api;
      const legacyDir = options.legacyDir ?? legacyStateDir();
      for (const file of [SEEN_ISSUES_FILE, SEEN_COMMENTS_FILE]) {
        if (await importLegacy(ctx.dataDir, legacyDir, file)) ctx.log.info("imported state of the built-in Linear channel", { file });
      }
      const seenIssues = new SeenSet(ctx.dataDir, SEEN_ISSUES_FILE);
      const seenComments = new SeenSet(ctx.dataDir, SEEN_COMMENTS_FILE);
      await seenIssues.load();
      await seenComments.load();

      try {
        const viewer = await client.viewer();
        ctx.log.info("linear connected", { viewer_id: viewer.id, viewer: viewer.name ?? "", label: config.labelName });
      } catch (err) {
        if (err instanceof LinearApiError && err.authFailed) throw new ConfigError(`Linear rejected the api_key: ${err.message}`);
        ctx.log.warn("linear viewer check failed; polling anyway", { error: errorText(err) });
      }

      const controller = new AbortController();
      const signal = controller.signal;

      const react = (target: ReactionTarget) => {
        retry(() => client.createReaction(target, REACTION_EMOJI, signal), timings.retryAttempts, timings.retryDelayMs, signal).catch((err) => {
          if (!signal.aborted) ctx.log.warn("add reaction failed", { error: errorText(err) });
        });
      };

      const dispatch = (message: InboundMessage) => {
        if (!signal.aborted) ctx.dispatch(message);
      };

      const tick = async () => {
        const issues = await client.issuesInStates(config.states, config.labelName, config.projects, signal);
        const newIssues: string[] = [];
        const newComments: string[] = [];
        try {
          for (const issue of issues) {
            if (signal.aborted) return;
            if (!seenIssues.has(issue.id)) {
              if (!(await dispatchInitial(issue))) return;
              newIssues.push(issue.id);
              for (const c of issue.comments) if (!isBotComment(c.body)) newComments.push(c.id);
              continue;
            }
            for (const c of issue.comments) {
              if (signal.aborted) return;
              if (seenComments.has(c.id) || isBotComment(c.body)) continue;
              const body = await resolve(ctx, c.body, signal);
              if (signal.aborted) return;
              dispatch(commentInbound(issue, c, body));
              react({ commentId: c.id });
              newComments.push(c.id);
            }
          }
        } finally {
          await save(seenIssues, newIssues, "issues");
          await save(seenComments, newComments, "comments");
        }
      };

      const dispatchInitial = async (issue: Issue): Promise<boolean> => {
        const comments = issue.comments.filter((c: Comment) => !isBotComment(c.body));
        const description = await resolve(ctx, issue.description ?? "", signal);
        const bodies = [];
        for (const comment of comments) bodies.push({ comment, body: await resolve(ctx, comment.body, signal) });
        if (signal.aborted) return false;
        dispatch(initialInbound(issue, description, bodies));
        react({ issueId: issue.id });
        return true;
      };

      const save = async (set: SeenSet, ids: string[], what: string) => {
        if (ids.length === 0) return;
        try {
          await set.add(ids);
        } catch (err) {
          ctx.log.error(`save seen ${what} failed`, { count: ids.length, error: errorText(err) });
        }
      };

      const loop = (async () => {
        await sleep(0, signal);
        while (!signal.aborted) {
          try {
            await tick();
          } catch (err) {
            if (!signal.aborted) ctx.log.error("poll failed", { error: errorText(err) });
          }
          await sleep(config.pollIntervalMs, signal);
        }
      })();

      return {
        stop: async () => {
          controller.abort();
          await loop;
        },
      };
    },

    async send(msg: SendRequest, ctx: ChannelContext, signal: AbortSignal) {
      const client = api!;
      const stored = parseReplyTarget(msg.reply_to?.raw);
      const issueId = stored?.issue_id ?? (await client.issueId(msg.session_scope, signal));
      const parentId = msg.proactive ? null : (stored?.parent_comment_id ?? null);

      let body = BOT_MARKER + (msg.content ?? "");
      if (msg.media?.path) {
        const markdown = await upload(msg.media.path, msg.media.name, signal);
        body += msg.content ? "\n\n" + markdown : markdown;
      }
      const id = await retry(() => client.createComment(issueId, body, parentId, signal), timings.retryAttempts, timings.retryDelayMs, signal);
      ctx.log.debug("comment posted", { issue_id: issueId, comment_id: id });
      return { platform_message_id: id };
    },
  };
}
