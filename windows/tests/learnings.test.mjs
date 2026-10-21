import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/core/bridge.ts";

test("learned rules bridge methods are defined and callable", async () => {
  assert.equal(typeof Bridge.getLearnedRules, "function");
  assert.equal(typeof Bridge.saveLearnedRule, "function");
  assert.equal(typeof Bridge.deleteLearnedRule, "function");
  assert.equal(typeof Bridge.openAntigravity, "function");
});

test("learning tag extraction pattern matches [LEARNED_RULE: topic | rule]", () => {
  const sample = "Harika! [LEARNED_RULE: antigravity | Antigravity masaüstü uygulamasını aç] Bundan sonra hep böyle yapacağım.";
  const regex = /\[LEARNED_RULE:\s*([^|]+)\|\s*([^\]]+)\]/;
  const match = sample.match(regex);
  assert.ok(match);
  assert.equal(match[1].trim(), "antigravity");
  assert.equal(match[2].trim(), "Antigravity masaüstü uygulamasını aç");
  const cleaned = sample.replace(regex, "").replace(/\s+/g, " ").trim();
  assert.equal(cleaned, "Harika! Bundan sonra hep böyle yapacağım.");
});
