import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { API_KEY, issue, startFakeLinear } from "./fake-linear.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");
const fixture = join(here, "fixtures", "entry.mjs");

function startPlugin(args) {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    messages,
    stderr: () => stderr,
    waitFor(match, ms = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id, 15000);
    },
  };
}

function initParams(config) {
  return {
    protocol_version: 1,
    openbee_version: "test",
    channel_id: "linear",
    language: "zh",
    bot_name: "",
    config,
    data_dir: mkdtempSync(join(tmpdir(), "linear-data-")),
    media_dir: mkdtempSync(join(tmpdir(), "linear-media-")),
  };
}

test("the plugin process speaks the openbee channel protocol", async (t) => {
  const fake = await startFakeLinear();
  fake.state.issues.push(issue({ description: "please check" }));
  const p = startPlugin([fixture, fake.endpoint, fake.assetPrefix, mkdtempSync(join(tmpdir(), "linear-legacy-"))]);
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
    await fake.close();
  });
  const init = await p.request("initialize", initParams({ api_key: API_KEY, projects: ["Core"], states: ["Todo"], poll_interval: "50ms" }));
  assert.deepEqual(init.result, { protocol_version: 1 });
  const initIndex = p.messages.indexOf(init);

  const inbound = await p.waitFor((m) => m.method === "inbound");
  assert.ok(p.messages.indexOf(inbound) > initIndex);
  assert.equal(inbound.params.chat_id, "ENG");
  assert.equal(inbound.params.session_scope, "ENG-1");
  assert.match(inbound.params.text, /please check/);

  const sent = await p.request("send", {
    session_key: "linear:ENG:ENG-1",
    chat_id: "ENG",
    session_scope: "ENG-1",
    proactive: false,
    reply_to: { message_id: inbound.params.message_id, raw: inbound.params.raw },
    content: "On it",
  });
  assert.deepEqual(sent.result, { platform_message_id: "posted-1" });
  assert.equal(fake.state.comments[0].body, "[openbee-bot]\n\nOn it");
  assert.ok(!p.stderr().includes(API_KEY));
  assert.ok(!JSON.stringify(p.messages).includes(API_KEY));

  const shutdown = await p.request("shutdown", {});
  assert.deepEqual(shutdown.result, {});
  assert.equal(await p.exited, 0);
});

test("a missing api key is reported as a config error", async (t) => {
  const p = startPlugin([entry]);
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
  });
  const init = await p.request("initialize", initParams({ projects: ["Core"], states: ["Todo"] }));
  assert.equal(init.error.code, -32001);
  assert.match(init.error.message, /api_key is required/);
});
