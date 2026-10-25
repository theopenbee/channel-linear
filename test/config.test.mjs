import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ConfigError } from "@theopenbee/channel-sdk";

import { readConfig } from "../dist/linear.js";

const BASE = { api_key: " lin_x ", projects: ["Core"], states: ["Todo"] };

test("readConfig applies defaults", () => {
  assert.deepEqual(readConfig({ ...BASE, label_name: "", poll_interval: "", projects: [" Core ", ""] }), {
    apiKey: "lin_x",
    labelName: "openbee",
    projects: ["Core"],
    states: ["Todo"],
    pollIntervalMs: 10_000,
    maxMediaSize: 52428800,
  });
  const custom = readConfig({ ...BASE, label_name: "bot", poll_interval: "1m", max_media_size: 1024 });
  assert.equal(custom.labelName, "bot");
  assert.equal(custom.pollIntervalMs, 60_000);
  assert.equal(custom.maxMediaSize, 1024);
});

test("readConfig rejects missing or invalid values", () => {
  const rejects = (raw, pattern) => assert.throws(() => readConfig(raw), (err) => err instanceof ConfigError && pattern.test(err.message));
  rejects({ ...BASE, api_key: "" }, /api_key is required/);
  rejects({ ...BASE, projects: [] }, /projects is required/);
  rejects({ ...BASE, projects: [""] }, /projects is required/);
  rejects({ ...BASE, states: undefined }, /states is required/);
  rejects({ ...BASE, poll_interval: "10" }, /poll_interval/);
  rejects({ ...BASE, poll_interval: "0s" }, /poll_interval/);
});

test("the manifest declares the built-in channel's config keys", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openbee.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "linear");
  assert.deepEqual(
    manifest.config.map((f) => f.key),
    ["api_key", "label_name", "projects", "states", "poll_interval", "max_media_size"],
  );
});
