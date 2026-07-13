/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runMake(makefile: string): SpawnSyncReturns<string> {
  const directory = mkdtempSync(join(tmpdir(), "tkati-test-"));
  writeFileSync(join(directory, "Makefile"), makefile);
  return spawnSync(process.execPath, [resolve("src-ts/main.ts")], {
    cwd: directory, encoding: "utf8", env: { ...process.env, MAKEFLAGS: "", MAKELEVEL: "" },
  });
}

test("pattern rules without recipes are not implicit build candidates", () => {
  const result = runMake(`
test: setup output.o

setup:
\t@touch output-generated.c output.c

%.o: %-generated.c

%.o: %.c
\t@echo $<
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "output.c");
});

test("suffix-looking targets remain available as explicit rules", () => {
  const result = runMake(`
test: .module-common.o

.module-common.o:
	@echo explicit
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "explicit");
});

test("old-style suffix rules still build matching targets", () => {
  const result = runMake(`
test: output.o

output.c:
	@touch $@

.c.o:
	@echo $<
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /output\.c/);
});

test("recipe prefixes may be separated by whitespace", () => {
  const result = runMake(`
test:
	+ @echo PASS
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PASS");
});

test("private target variables do not leak to prerequisites", () => {
  const result = runMake(`
VALUE := global

parent: private VALUE := parent
parent: child
\t@echo parent=$(VALUE)

child:
\t@echo child=$(VALUE)
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "child=global\nparent=parent");
});

test("target-specific exports are visible to recipes", () => {
  const result = runMake(`
test: export VALUE := target
test:
\t@printf 'VALUE=%s\\n' "$$VALUE"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "VALUE=target");
});

test("a canonicalized current-directory target remains a valid default", () => {
  const result = runMake(`
PHONY := ./

./: built
\t@:

built:
\t@echo PASS
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PASS");
});

test("an empty phony prerequisite updates an existing target", () => {
  const result = runMake(`
.PHONY: FORCE

./: FORCE
\t@echo PASS

FORCE:
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PASS");
});
