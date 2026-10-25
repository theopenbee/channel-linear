import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SeenSet, importLegacy } from "../dist/seen.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "linear-seen-"));
}

test("SeenSet persists added ids as NDJSON", async () => {
  const dir = join(tempDir(), "nested");
  const set = new SeenSet(dir, "seen.ndjson");
  await set.load();
  assert.equal(set.size, 0);
  await set.add(["a", "b", "a"]);
  await set.add(["b", "c"]);
  await set.add([]);
  assert.equal(readFileSync(join(dir, "seen.ndjson"), "utf8"), "a\nb\nc\n");
  assert.equal(statSync(join(dir, "seen.ndjson")).mode & 0o777, 0o600);
  const again = new SeenSet(dir, "seen.ndjson");
  await again.load();
  assert.equal(again.has("a") && again.has("b") && again.has("c"), true);
  assert.equal(again.has("d"), false);
});

test("SeenSet drops a partial last line and keeps later appends separate", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "seen.ndjson"), "a\n\nb\npartial");
  const set = new SeenSet(dir, "seen.ndjson");
  await set.load();
  assert.equal(set.has("a"), true);
  assert.equal(set.has("b"), true);
  assert.equal(set.has("partial"), false);
  await set.add(["c"]);
  const reloaded = new SeenSet(dir, "seen.ndjson");
  await reloaded.load();
  assert.equal(reloaded.has("c"), true);
  assert.equal(reloaded.has("partialc"), false);
});

test("importLegacy copies the built-in channel state once", async () => {
  const legacy = tempDir();
  const data = join(tempDir(), "data");
  writeFileSync(join(legacy, "seen_issues.ndjson"), "old\n");
  assert.equal(await importLegacy(data, legacy, "seen_issues.ndjson"), true);
  assert.equal(readFileSync(join(data, "seen_issues.ndjson"), "utf8"), "old\n");
  writeFileSync(join(legacy, "seen_issues.ndjson"), "newer\n");
  assert.equal(await importLegacy(data, legacy, "seen_issues.ndjson"), false);
  assert.equal(readFileSync(join(data, "seen_issues.ndjson"), "utf8"), "old\n");
  assert.equal(await importLegacy(data, legacy, "seen_comments.ndjson"), false);
});
