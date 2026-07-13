/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import { intern, resetSymbolsForTest, symbolCount } from "./symtab.ts";
import {
  Pattern,
  concat,
  findEndOfLine,
  findOutsideParen,
  normalizePath,
  normalizeWords,
  trimLeftSpace,
  trimSpace,
  words,
} from "./string.ts";

test("intern returns a canonical native string", () => {
  resetSymbolsForTest();
  const before = symbolCount();
  const assembled = ["fo", "o"].join("");
  assert.equal(intern(assembled), "foo");
  assert.equal(intern("foo"), intern(assembled));
  assert.equal(symbolCount(), before + 1);
});

test("make whitespace helpers operate on native strings", () => {
  assert.equal(trimSpace(" \t foo bar\r\n"), "foo bar");
  assert.deepEqual([...words("  foo\tbar\n baz ")], ["foo", "bar", "baz"]);
  assert.equal(normalizeWords("  foo\tbar\n baz "), "foo bar baz");
});

test("concatenation does not flatten through a custom buffer", () => {
  assert.equal(concat("a", "b", "c"), "abc");
});

test("patterns preserve GNU Make stem behavior", () => {
  assert.equal(new Pattern("%.c").subst("x.c", "%.o"), "x.o");
  assert.equal(new Pattern("c.%").subst("c.x", "o.%"), "o.x");
  assert.equal(new Pattern("%.c").subst("x.c.c", "%.o"), "x.c.o");
  assert.equal(new Pattern("x.c").subst("x.c", "OK"), "OK");
  assert.equal(new Pattern("%/").subst("/", "%"), "");
});

test("path normalization matches Kati", () => {
  const cases: Record<string, string> = {
    "": "", ".": "", "/": "/", "////tmp////": "/tmp", "a//.//b": "a/b",
    "a////b//../c/////": "a/c", "../foo": "../foo", "x/y/..//../foo": "foo",
    "x/../../foo": "../foo", "/../../foo": "/foo", "../../a/b": "../../a/b",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizePath(input), expected);
});

test("line and syntax scanners match escaped make input", () => {
  assert.deepEqual(findEndOfLine("foo\\\nbar\nbaz"), {
    line: "foo\\\nbar", rest: "baz", lineFeedCount: 2,
  });
  assert.equal(trimLeftSpace(" \\\n bar"), "bar");
  assert.equal(findOutsideParen("a(b:c)d", ":"), undefined);
  assert.equal(findOutsideParen("a(b)c:d", ":"), 5);
  assert.equal(findOutsideParen("a\\:b:c", ":"), 4);
});
