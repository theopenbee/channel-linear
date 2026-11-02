import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "@theopenbee/channel-sdk";

import { createLinearChannel } from "../dist/linear.js";
import { API_KEY, comment, issue, startFakeLinear } from "./fake-linear.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeContext(config = {}, dirs = {}) {
  const dataDir = dirs.dataDir ?? tempDir("linear-data-");
  const mediaDir = dirs.mediaDir ?? tempDir("linear-media-");
  const inbound = [];
  const logs = [];
  let n = 0;
  const log = {};
  for (const level of ["debug", "info", "warn", "error"]) log[level] = (message, fields) => logs.push({ level, message, fields });
  return {
    inbound,
    logs,
    dataDir,
    mediaDir,
    ctx: {
      channelId: "linear",
      config: { api_key: API_KEY, projects: ["Core"], states: ["Todo"], poll_interval: "20ms", ...config },
      botName: "",
      language: "en",
      dataDir,
      mediaDir,
      openbeeVersion: "test",
      dispatch: (m) => inbound.push(m),
      migrateChat() {},
      saveMedia: async (data, ext) => {
        const path = join(mediaDir, `${n++}${ext}`);
        writeFileSync(path, data);
        return path;
      },
      log,
    },
  };
}

async function waitUntil(check, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup(t, { config, dirs, legacyDir } = {}) {
  const fake = await startFakeLinear();
  const env = fakeContext(config, dirs);
  const channel = createLinearChannel({
    endpoint: fake.endpoint,
    assetPrefix: fake.assetPrefix,
    legacyDir: legacyDir ?? tempDir("linear-legacy-"),
    timings: { retryAttempts: 3, retryDelayMs: 1 },
  });
  const handles = [];
  const start = async () => {
    const handle = await channel.start(env.ctx);
    handles.push(handle);
    return handle;
  };
  t.after(async () => {
    for (const h of handles) await h?.stop?.();
    await fake.close();
  });
  return { fake, channel, start, ...env };
}

test("a new labelled issue is dispatched once with its comments merged", async (t) => {
  const s = await setup(t);
  s.fake.state.issues.push(
    issue({
      description: "Steps",
      comments: [comment({ id: "c1", body: "more info" }), comment({ id: "c2", body: "[openbee-bot]\n\nold reply" })],
    }),
    issue({ id: "other-label", identifier: "ENG-2", labels: ["bug"] }),
    issue({ id: "other-state", identifier: "ENG-3", state: "Done" }),
    issue({ id: "other-project", identifier: "ENG-4", project: { id: "p2", name: "Web" } }),
  );
  await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.equal(msg.chat_id, "ENG");
  assert.equal(msg.session_scope, "ENG-1");
  assert.equal(msg.message_id, "issue:issue-1");
  assert.equal(msg.text, "[Project: Core]\n\nFix login\n\nSteps\n\n---\nComments (1):\n\n[Bob]: more info");
  assert.equal(msg.raw, '{"issue_id":"issue-1"}');
  await waitUntil(() => s.fake.state.reactions.length === 1, 3000, "reaction");
  assert.deepEqual(s.fake.state.reactions[0], { emoji: ":eyes:", issueId: "issue-1" });
  const polls = s.fake.ops("Issues").length;
  await waitUntil(() => s.fake.ops("Issues").length >= polls + 2, 3000, "more polls");
  assert.equal(s.inbound.length, 1);
  assert.equal(readFileSync(join(s.dataDir, "seen_issues.ndjson"), "utf8"), "issue-1\n");
  assert.equal(readFileSync(join(s.dataDir, "seen_comments.ndjson"), "utf8"), "c1\n");
});

test("new comments on a seen issue are dispatched in their thread", async (t) => {
  const s = await setup(t);
  const tracked = issue({ comments: [comment({ id: "c1" })] });
  s.fake.state.issues.push(tracked);
  await s.start();
  await waitUntil(() => s.inbound.length === 1, 3000, "initial");
  tracked.comments.push(
    comment({ id: "c2", body: "follow up", parentId: "c1", user: { id: "user-3", name: "Carol" } }),
    comment({ id: "c3", body: "[openbee-bot]\n\nanswer" }),
    comment({ id: "c4", body: "top level" }),
  );
  await waitUntil(() => s.inbound.length === 3, 3000, "comments");
  const [, reply, top] = s.inbound;
  assert.equal(reply.text, "follow up");
  assert.equal(reply.sender_id, "user-3");
  assert.equal(reply.message_id, "comment:c2");
  assert.equal(reply.raw, '{"issue_id":"issue-1","parent_comment_id":"c1"}');
  assert.equal(top.raw, '{"issue_id":"issue-1","parent_comment_id":"c4"}');
  await waitUntil(() => s.fake.state.reactions.length === 3, 3000, "reactions");
  assert.deepEqual(
    s.fake.state.reactions.map((r) => r.commentId ?? r.issueId).sort(),
    ["c2", "c4", "issue-1"],
  );
  const polls = s.fake.ops("Issues").length;
  await waitUntil(() => s.fake.ops("Issues").length >= polls + 2, 3000, "more polls");
  assert.equal(s.inbound.length, 3);
});

test("seen ids survive a restart and the built-in state is imported", async (t) => {
  const legacyDir = tempDir("linear-legacy-");
  writeFileSync(join(legacyDir, "seen_issues.ndjson"), "old-issue\n");
  writeFileSync(join(legacyDir, "seen_comments.ndjson"), "old-comment\n");
  const dataDir = tempDir("linear-data-");
  const s = await setup(t, { legacyDir, dirs: { dataDir } });
  s.fake.state.issues.push(issue({ id: "old-issue", comments: [comment({ id: "old-comment" }), comment({ id: "new-comment", body: "new" })] }));
  const handle = await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.equal(msg.message_id, "comment:new-comment");
  assert.ok(s.logs.some((l) => l.message.includes("imported state")));
  await handle.stop();

  const again = fakeContext({}, { dataDir });
  const channel = createLinearChannel({ endpoint: s.fake.endpoint, assetPrefix: s.fake.assetPrefix, legacyDir });
  const h2 = await channel.start({ ...again.ctx, config: { ...again.ctx.config } });
  t.after(() => h2.stop());
  const polls = s.fake.ops("Issues").length;
  await waitUntil(() => s.fake.ops("Issues").length >= polls + 2, 3000, "polls after restart");
  assert.equal(again.inbound.length, 0);
});

test("attachments are downloaded with the api key and reported", async (t) => {
  const s = await setup(t);
  s.fake.state.assets.set("shot", { data: PNG, contentType: "image/png" });
  s.fake.state.assets.set("doc", { data: Buffer.from("%PDF-1.4 test"), contentType: "application/octet-stream" });
  s.fake.state.assets.set("bare", { data: PNG });
  const a = s.fake.assetPrefix;
  s.fake.state.issues.push(
    issue({
      description: `Look ![screen shot](${a}shot) and [spec.pdf](${a}doc), \`[skip](${a}shot)\`, ![gone](${a}missing)`,
      comments: [comment({ id: "c1", body: `![](${a}bare)` })],
    }),
  );
  await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.equal(msg.attachments.length, 3);
  const [shot, doc, bare] = msg.attachments;
  assert.deepEqual({ type: shot.type, name: shot.name }, { type: "image", name: "screen shot" });
  assert.ok(shot.path.startsWith(s.mediaDir) && shot.path.endsWith(".png"));
  assert.deepEqual(readFileSync(shot.path), PNG);
  assert.deepEqual({ type: doc.type, name: doc.name }, { type: "document", name: "spec.pdf" });
  assert.ok(doc.path.endsWith(".pdf"));
  assert.equal(bare.type, "image");
  assert.equal(bare.name, undefined);
  const bareName = bare.path.split("/").pop();
  assert.equal(
    msg.text,
    `[Project: Core]\n\nFix login\n\nLook [image: screen shot] and [file: spec.pdf], \`[skip](${a}shot)\`, ![gone](${a}missing)\n\n---\nComments (1):\n\n[Bob]: [image: ${bareName}]`,
  );
  assert.deepEqual([...s.fake.state.authHeaders], [API_KEY]);
  assert.ok(s.logs.some((l) => l.level === "warn" && l.message.includes("download attachment failed")));
});

test("attachments over max_media_size are left as links", async (t) => {
  const s = await setup(t, { config: { max_media_size: 4 } });
  s.fake.state.assets.set("big", { data: PNG, contentType: "image/png" });
  s.fake.state.issues.push(issue({ description: `![big](${s.fake.assetPrefix}big)` }));
  await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.equal(msg.attachments, undefined);
  assert.match(msg.text, /!\[big\]\(http/);
});

test("a failed poll is logged and retried on the next tick", async (t) => {
  const s = await setup(t);
  s.fake.state.issues.push(issue());
  s.fake.failNext("Issues", 2, { status: 500 });
  await s.start();
  await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.ok(s.logs.some((l) => l.level === "error" && l.message === "poll failed"));
});

test("a rejected api key is a config error", async (t) => {
  const s = await setup(t, { config: { api_key: "wrong" } });
  await assert.rejects(s.channel.start(s.ctx), (err) => err instanceof ConfigError && /rejected the api_key/.test(err.message));
});

test("a failed viewer check does not stop polling", async (t) => {
  const s = await setup(t);
  s.fake.failNext("Viewer", 1, { status: 502 });
  s.fake.state.issues.push(issue());
  await s.start();
  await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.ok(s.logs.some((l) => l.level === "warn" && l.message.includes("viewer check failed")));
});

function sendRequest(overrides = {}) {
  return {
    session_key: "linear:ENG:ENG-1",
    chat_id: "ENG",
    session_scope: "ENG-1",
    proactive: false,
    content: "Done",
    ...overrides,
  };
}

test("send replies in the thread of the inbound comment", async (t) => {
  const s = await setup(t);
  await s.start();
  const result = await s.channel.send(
    sendRequest({ reply_to: { message_id: "comment:c2", raw: '{"issue_id":"issue-1","parent_comment_id":"c1"}' } }),
    s.ctx,
    new AbortController().signal,
  );
  assert.deepEqual(result, { platform_message_id: "posted-1" });
  assert.deepEqual(s.fake.state.comments[0], { id: "posted-1", issueId: "issue-1", body: "[openbee-bot]\n\nDone", parentId: "c1" });
});

test("proactive sends go to the top level, resolving the issue when needed", async (t) => {
  const s = await setup(t);
  s.fake.state.issues.push(issue({ id: "issue-9", identifier: "ENG-9" }));
  await s.start();
  const signal = new AbortController().signal;
  await s.channel.send(sendRequest({ proactive: true, reply_to: { raw: '{"issue_id":"issue-1","parent_comment_id":"c1"}' } }), s.ctx, signal);
  await s.channel.send(sendRequest({ proactive: true, session_scope: "ENG-9", session_key: "linear:ENG:ENG-9" }), s.ctx, signal);
  assert.deepEqual(
    s.fake.state.comments.map(({ issueId, parentId }) => ({ issueId, parentId })),
    [
      { issueId: "issue-1", parentId: null },
      { issueId: "issue-9", parentId: null },
    ],
  );
  await assert.rejects(s.channel.send(sendRequest({ session_scope: "ENG-404" }), s.ctx, signal), /Entity not found/);
});

test("send uploads media and embeds it in the comment", async (t) => {
  const s = await setup(t);
  await s.start();
  const dir = tempDir("linear-out-");
  const image = join(dir, "chart.png");
  const report = join(dir, "report.csv");
  writeFileSync(image, PNG);
  writeFileSync(report, "a,b\n1,2\n");
  const signal = new AbortController().signal;
  const raw = '{"issue_id":"issue-1"}';
  await s.channel.send(sendRequest({ reply_to: { raw }, media: { path: image, name: "chart.png" } }), s.ctx, signal);
  await s.channel.send(sendRequest({ reply_to: { raw }, content: undefined, media: { path: report, name: "report.csv" } }), s.ctx, signal);
  const [first, second] = s.fake.state.comments;
  assert.equal(first.body, `[openbee-bot]\n\nDone\n\n![chart.png](${s.fake.url}/assets/uploaded-1)`);
  assert.equal(second.body, `[openbee-bot]\n\n[report.csv](${s.fake.url}/assets/uploaded-2)`);
  const [up1, up2] = s.fake.state.uploads;
  assert.deepEqual({ filename: up1.filename, contentType: up1.contentType, size: up1.size }, { filename: "chart.png", contentType: "image/png", size: PNG.length });
  assert.deepEqual(up1.data, PNG);
  assert.equal(up1.headers["x-amz-acl"], "private");
  assert.equal(up1.headers["content-type"], "image/png");
  assert.equal(up2.data.toString(), "a,b\n1,2\n");
});

test("send refuses files over max_media_size", async (t) => {
  const s = await setup(t, { config: { max_media_size: 4 } });
  await s.start();
  const path = join(tempDir("linear-out-"), "chart.png");
  writeFileSync(path, PNG);
  await assert.rejects(
    s.channel.send(sendRequest({ reply_to: { raw: '{"issue_id":"issue-1"}' }, media: { path, name: "chart.png" } }), s.ctx, new AbortController().signal),
    /too large/,
  );
  assert.equal(s.fake.state.comments.length, 0);
});

test("send retries a failed comment", async (t) => {
  const s = await setup(t);
  await s.start();
  s.fake.failNext("CommentCreate", 2, { status: 500 });
  const result = await s.channel.send(sendRequest({ reply_to: { raw: '{"issue_id":"issue-1"}' } }), s.ctx, new AbortController().signal);
  assert.deepEqual(result, { platform_message_id: "posted-1" });
  assert.equal(s.fake.ops("CommentCreate").length, 3);
});

const assetCalls = (s, name) => s.fake.state.assetRequests.filter((n) => n === name).length;
const retryLogs = (s) => s.logs.filter((l) => l.level === "warn" && l.message === "download attachment failed, retrying");

test("a failing attachment download is retried until it arrives", async (t) => {
  const s = await setup(t);
  s.fake.state.assets.set("flaky", { data: PNG, contentType: "image/png" });
  s.fake.state.assetFailures.set("flaky", ["drop", 503]);
  s.fake.state.issues.push(issue({ description: `![shot](${s.fake.assetPrefix}flaky)` }));
  await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.deepEqual(readFileSync(msg.attachments[0].path), PNG);
  assert.equal(assetCalls(s, "flaky"), 3);
  assert.equal(retryLogs(s).length, 2);
});

test("an attachment that keeps failing stays a link after three attempts", async (t) => {
  const s = await setup(t);
  s.fake.state.assets.set("flaky", { data: PNG, contentType: "image/png" });
  s.fake.state.assetFailures.set("flaky", ["drop", 502, 429]);
  const link = `![shot](${s.fake.assetPrefix}flaky)`;
  s.fake.state.issues.push(issue({ description: link }));
  await s.start();
  const msg = await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.ok(msg.text.includes(link));
  assert.equal(assetCalls(s, "flaky"), 3);
});

test("missing and oversized attachments are not retried", async (t) => {
  const s = await setup(t, { config: { max_media_size: 4 } });
  s.fake.state.assets.set("big", { data: PNG, contentType: "image/png" });
  const a = s.fake.assetPrefix;
  s.fake.state.issues.push(issue({ description: `![big](${a}big) ![gone](${a}missing)` }));
  await s.start();
  await waitUntil(() => s.inbound[0], 3000, "inbound");
  assert.equal(assetCalls(s, "big"), 1);
  assert.equal(assetCalls(s, "missing"), 1);
  assert.equal(retryLogs(s).length, 0);
});
