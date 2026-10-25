import { test } from "node:test";
import assert from "node:assert/strict";

import { extractAssets, maskCodeRegions, splice } from "../dist/assets.js";
import {
  commentInbound,
  initialInbound,
  isBotComment,
  mergeIssueContent,
  parseDuration,
  parseReplyTarget,
  retry,
  safeExtension,
} from "../dist/helpers.js";
import { comment, issue } from "./fake-linear.mjs";

const PREFIX = "https://uploads.linear.app/";

test("parseDuration reads Go style durations", () => {
  assert.equal(parseDuration("10s"), 10_000);
  assert.equal(parseDuration("1m30s"), 90_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration(" 2m "), 120_000);
  assert.equal(parseDuration("10"), undefined);
  assert.equal(parseDuration("ten seconds"), undefined);
  assert.equal(parseDuration("10s junk"), undefined);
  assert.equal(parseDuration(""), undefined);
});

test("bot comments are recognised by their prefix", () => {
  assert.equal(isBotComment("[openbee-bot]\n\nDone"), true);
  assert.equal(isBotComment("[openbee-bot] Done"), true);
  assert.equal(isBotComment("Done [openbee-bot]"), false);
});

test("extractAssets finds images and links outside code", () => {
  const text = `see ![shot](${PREFIX}a/b.png) and [report.pdf](${PREFIX}c/d) but \`![x](${PREFIX}e/f)\`\n\`\`\`\n[y](${PREFIX}g/h)\n\`\`\` [z](https://example.com/z)`;
  const found = extractAssets(text);
  assert.deepEqual(
    found.map(({ url, name, isImage }) => ({ url, name, isImage })),
    [
      { url: `${PREFIX}a/b.png`, name: "shot", isImage: true },
      { url: `${PREFIX}c/d`, name: "report.pdf", isImage: false },
    ],
  );
  assert.equal(text.slice(found[0].start, found[0].end), `![shot](${PREFIX}a/b.png)`);
  assert.equal(splice(text, found, ["IMG", "DOC"]).startsWith("see IMG and DOC but"), true);
});

test("extractAssets handles unicode names and empty alt text", () => {
  const text = `截图：![屏幕 截图](${PREFIX}x)![](${PREFIX}y)`;
  const found = extractAssets(text);
  assert.deepEqual(found.map((m) => m.name), ["屏幕 截图", ""]);
  assert.equal(splice(text, found, ["A", "B"]), "截图：AB");
});

test("maskCodeRegions keeps length and masks unterminated fences", () => {
  const text = "a `b` ```c\nd";
  const masked = maskCodeRegions(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked, "a ... ......");
});

test("mergeIssueContent renders project, title, description and comments", () => {
  const i = issue({ title: "Bug", project: { id: "p", name: "Core" } });
  const comments = [comment({ body: "first" }), comment({ id: "c2", body: "second", user: { id: "u3", email: "eve@example.com" } }), comment({ id: "c3", body: "third", user: null })];
  assert.equal(
    mergeIssueContent(i, "Steps", comments),
    "[Project: Core]\n\nBug\n\nSteps\n\n---\nComments (3):\n\n[Bob]: first\n[eve@example.com]: second\n[unknown]: third",
  );
  assert.equal(mergeIssueContent(issue({ title: "Only", project: null }), "", []), "Only");
});

test("initialInbound keeps the built-in session key and raw format", () => {
  const i = issue({ id: "iid", identifier: "ENG-7", team: { key: "ENG" } });
  const c = comment({ id: "c1", body: "with file" });
  const msg = initialInbound(i, { text: "desc", attachments: [{ type: "image", path: "/m/a.png" }] }, [
    { comment: c, body: { text: "resolved", attachments: [{ type: "document", path: "/m/b.pdf", name: "b.pdf" }] } },
  ]);
  assert.equal(msg.chat_id, "ENG");
  assert.equal(msg.session_scope, "ENG-7");
  assert.equal(msg.sender_id, "user-1");
  assert.equal(msg.message_id, "issue:iid");
  assert.equal(msg.raw, '{"issue_id":"iid"}');
  assert.equal(msg.time, Date.parse("2026-10-25T01:00:00.000Z"));
  assert.match(msg.text, /desc/);
  assert.match(msg.text, /\[Bob\]: resolved/);
  assert.deepEqual(msg.attachments.map((a) => a.path), ["/m/a.png", "/m/b.pdf"]);
  assert.deepEqual(msg.context, { issue_id: "iid", identifier: "ENG-7", title: "Fix login", url: "https://linear.app/acme/issue/ENG-7", project: "Core" });
});

test("initialInbound falls back when the creator is missing", () => {
  const msg = initialInbound(issue({ creator: null, createdAt: "" }), { text: "", attachments: [] }, []);
  assert.equal(msg.sender_id, "unknown");
  assert.equal(typeof msg.time, "number");
  assert.equal(msg.attachments, undefined);
});

test("commentInbound replies in the comment's thread", () => {
  const i = issue({ id: "iid" });
  const top = commentInbound(i, comment({ id: "c1" }), { text: "hi", attachments: [] });
  assert.equal(top.raw, '{"issue_id":"iid","parent_comment_id":"c1"}');
  assert.equal(top.message_id, "comment:c1");
  assert.equal(top.sender_id, "user-2");
  assert.equal(top.session_scope, "ENG-1");
  const reply = commentInbound(i, comment({ id: "c2", parentId: "c1" }), { text: "hi", attachments: [] });
  assert.equal(reply.raw, '{"issue_id":"iid","parent_comment_id":"c1"}');
});

test("parseReplyTarget accepts the built-in raw format only", () => {
  assert.deepEqual(parseReplyTarget('{"issue_id":"i","parent_comment_id":"c"}'), { issue_id: "i", parent_comment_id: "c" });
  assert.deepEqual(parseReplyTarget('{"issue_id":"i"}'), { issue_id: "i" });
  assert.equal(parseReplyTarget('{"chat_id":"x"}'), undefined);
  assert.equal(parseReplyTarget("not json"), undefined);
  assert.equal(parseReplyTarget(undefined), undefined);
});

test("safeExtension only keeps plain extensions", () => {
  assert.equal(safeExtension("report.PDF"), ".pdf");
  assert.equal(safeExtension("v1.0 final"), "");
  assert.equal(safeExtension("noext"), "");
});

test("retry gives up after the given attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw new Error("nope");
    }, 3, 1),
    /nope/,
  );
  assert.equal(calls, 3);
  let n = 0;
  assert.equal(await retry(async () => (++n < 2 ? Promise.reject(new Error("x")) : "ok"), 3, 1), "ok");
});
