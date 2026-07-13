/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Evaluator } from "./eval.ts";

test("recursive and simple variables expand with native strings", () => {
  const evaluator = new Evaluator({});
  evaluator.setVariable("A", { value: "before $(B)", flavor: "recursive", origin: "file" });
  evaluator.setVariable("B", { value: "one", flavor: "simple", origin: "file" });
  assert.equal(evaluator.expand("$(A)"), "before one");
  evaluator.setVariable("B", { value: "two", flavor: "simple", origin: "file" });
  assert.equal(evaluator.expand("$(A)"), "before two");
});

test("nested lazy functions only expand their selected branch", () => {
  const evaluator = new Evaluator({});
  assert.equal(evaluator.expand("$(if yes,PASS,$(error FAIL))"), "PASS");
  assert.equal(evaluator.expand("$(or ,,$(strip  pass  ))"), "pass");
  assert.equal(evaluator.expand("$(and yes,$(findstring oo,foo))"), "oo");
});

test("word and pattern builtins", () => {
  const evaluator = new Evaluator({});
  assert.equal(evaluator.expand("$(patsubst %.c,%.o,a.c b.h c.c)"), "a.o b.h c.o");
  assert.equal(evaluator.expand("$(filter %.c,a.c b.h c.c)"), "a.c c.c");
  assert.equal(evaluator.expand("$(wordlist 2,3,a b c d)"), "b c");
  assert.equal(evaluator.expand("$(sort z a z b)"), "a b z");
});

test("computed names and substitution references", () => {
  const evaluator = new Evaluator({});
  evaluator.setVariable("name", { value: "FILES", flavor: "simple", origin: "file" });
  evaluator.setVariable("FILES", { value: "a.c b.c", flavor: "simple", origin: "file" });
  assert.equal(evaluator.expand("$($(name):.c=.o)"), "a.o b.o");
});
