#!/usr/bin/env node
/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Make, type MakeOptions } from "./make.ts";
import { appendFileSync, chmodSync, existsSync, globSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, formatForCommandSubstitution, words } from "./string.ts";

interface ParsedOptions extends MakeOptions {
  directory?: string;
  generateNinja: boolean;
  regen: boolean;
  emitSandbox?: boolean;
}

function optionArgument(args: string[], index: number, prefix: string): [string, number] | undefined {
  const argument = args[index]!;
  if (argument === prefix) {
    if (index + 1 >= args.length) throw new Error(`missing argument to ${prefix}`);
    return [args[index + 1]!, index + 1];
  }
  if (argument.startsWith(prefix + "=")) return [argument.slice(prefix.length + 1), index];
  if (prefix.length === 2 && argument.startsWith(prefix) && argument.length > 2) return [argument.slice(2), index];
  return undefined;
}

function parseArgs(args: string[]): ParsedOptions {
  const options: ParsedOptions = {
    makefile: "Makefile", silent: false, dryRun: false, alwaysMake: false,
    keepGoing: false, syntaxCheck: false, commandVariables: [], targets: [],
    generateNinja: false,
    regen: false,
    werrorOverride: false,
    noBuiltinRules: false,
  };
  const commandVariables: string[] = [];
  const targets: string[] = [];
  const ignoredWithArgument = new Set([
    "--dump_include_graph", "--dump_variable_assignment_trace", "--variable_assignment_trace_filter",
    "--remote_num_jobs", "--ninja_suffix", "--ninja_dir", "--ignore_optional_include",
    "--ignore_dirty", "--no_ignore_dirty", "--writable", "--default_pool", "--cpu_profile", "--mem_profile",
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    let parsed: [string, number] | undefined;
    if ((parsed = optionArgument(args, index, "-f"))) {
      options.makefile = parsed[0]; index = parsed[1];
    } else if ((parsed = optionArgument(args, index, "-C"))) {
      options.directory = parsed[0]; index = parsed[1];
    } else if ((parsed = optionArgument(args, index, "-j"))) {
      index = parsed[1];
    } else if ((parsed = optionArgument(args, index, "--default_pool"))) {
      options.defaultPool = parsed[0]; index = parsed[1];
    } else if (argument === "-s") options.silent = true;
    else if (argument === "-i") options.dryRun = true;
    else if (argument === "-B") options.alwaysMake = true;
    else if (argument === "-k") options.keepGoing = true;
    else if (argument === "-c") options.syntaxCheck = true;
    else if (argument === "--ninja") options.generateNinja = true;
    else if (argument === "--regen") options.regen = true;
    else if (argument === "--gen_all_targets") options.genAllTargets = true;
    else if (argument === "--werror_overriding_commands") options.werrorOverride = true;
    else if (argument === "--no_builtin_rules") options.noBuiltinRules = true;
    else if (argument === "--warn_suffix_rules") options.warnSuffixRules = true;
    else if (argument === "--werror_suffix_rules") options.werrorSuffixRules = true;
    else if (argument === "--warn_implicit_rules") options.warnImplicitRules = true;
    else if (argument === "--werror_implicit_rules") options.werrorImplicitRules = true;
    else if (argument === "--warn_real_to_phony") options.warnRealToPhony = true;
    else if (argument === "--werror_real_to_phony") options.werrorRealToPhony = true;
    else if (argument === "--warn_phony_looks_real") options.warnPhonyLooksReal = true;
    else if (argument === "--werror_phony_looks_real") options.werrorPhonyLooksReal = true;
    else if (argument === "--warn_real_no_cmds_or_deps") options.warnRealNoCommandsOrDeps = true;
    else if (argument === "--werror_real_no_cmds_or_deps") options.werrorRealNoCommandsOrDeps = true;
    else if (argument === "--warn_real_no_cmds") options.warnRealNoCommands = true;
    else if (argument === "--werror_real_no_cmds") options.werrorRealNoCommands = true;
    else if (argument === "--werror_writable") options.werrorWritable = true;
    else if (argument === "--top_level_phony") options.topLevelPhony = true;
    else if (argument === "--werror_find_emulator") options.werrorFind = true;
    else if (argument === "--emit_sandbox_disabled") options.emitSandbox = true;
    else if (argument.startsWith("--writable=")) options.writable = [...(options.writable ?? []), argument.slice("--writable=".length)];
    else if (argument.startsWith("--")) {
      const option = argument.split("=", 1)[0]!;
      if (ignoredWithArgument.has(option) && !argument.includes("=")) index++;
      // Other Kati feature switches are consumed by their owning modules.
    } else if (argument.includes("=")) commandVariables.push(argument);
    else targets.push(argument);
  }
  options.commandVariables = commandVariables;
  options.targets = targets;
  return options;
}

function ninjaEscape(value: string): string {
  let result = "";
  for (const char of value) result += "$: ".includes(char) ? "$" + char : char;
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function translateCommand(input: string): string {
  let result = "";
  let previous = " ";
  let previousBackslash = false;
  let quote = "";
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === "#" && quote === "" && /\s/.test(previous)) {
      while (index + 1 < input.length && input[index + 1] !== "\n") index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      if (quote === char) quote = "";
      else if (quote === "" && !previousBackslash) quote = char;
      result += char;
    } else if (char === "\n") {
      if (previousBackslash) result = result.slice(0, -1);
      else result += " ";
    } else {
      result += char;
    }
    previousBackslash = char === "\\" ? !previousBackslash : false;
    previous = char;
  }
  if (previousBackslash) result = result.slice(0, -1);
  return result.replace(/[\s;]+$/, "");
}

interface FileSnapshot { exists: boolean; mtimeMs?: number; size?: number }
interface RegenStamp {
  version: 1;
  args: string;
  files: Record<string, FileSnapshot>;
  extraFiles: Record<string, FileSnapshot>;
  environment: Record<string, string | null>;
  globs: Record<string, string>;
  shellResults: { command: string; result: string; shell: string; shellFlag: string }[];
  fileReads: Record<string, FileSnapshot>;
  fileWrites: { filename: string; text: string; append: boolean }[];
}

function snapshot(filename: string): FileSnapshot {
  try {
    const stat = statSync(filename);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function currentGlob(patterns: string): string {
  const result: string[] = [];
  for (let pattern of words(patterns)) {
    pattern = pattern.replace(/\\(.)/g, "$1");
    if (!/[?*[]/.test(pattern)) {
      if (existsSync(pattern)) result.push(pattern);
      continue;
    }
    const wildcard = pattern.search(/[?*[]/);
    const slash = pattern.lastIndexOf("/", wildcard);
    const prefix = slash < 0 ? "" : pattern.slice(0, slash + 1);
    for (const match of globSync(pattern).sort()) result.push(prefix.includes("..") ? prefix + basename(match) : match);
  }
  return result.join(" ");
}

function argumentSignature(args: readonly string[]): string {
  return args.filter((argument) => argument !== "--regen").join("\0");
}

function needsRegeneration(args: readonly string[]): boolean {
  if (!existsSync(".kati_stamp") || !existsSync("build.ninja") || !existsSync("ninja.sh")) return true;
  let stamp: RegenStamp;
  try { stamp = JSON.parse(readFileSync(".kati_stamp", "utf8")) as RegenStamp; }
  catch { return true; }
  const dirty = (message: string): boolean => { console.error(message); return true; };
  if (stamp.version !== 1) return true;
  if (stamp.args !== argumentSignature(args)) return dirty("arguments changed, regenerating...");
  for (const [filename, old] of Object.entries(stamp.files)) {
    if (!sameSnapshot(old, snapshot(filename))) return dirty(`${filename} was modified, regenerating...`);
  }
  for (const [filename, old] of Object.entries(stamp.extraFiles)) {
    if (!sameSnapshot(old, snapshot(filename))) return dirty(`${filename} was modified, regenerating...`);
  }
  for (const [name, old] of Object.entries(stamp.environment)) {
    const value = process.env[name] ?? null;
    if (value !== old) return dirty(`Environment variable ${name} was modified, regenerating...`);
  }
  for (const [patterns, old] of Object.entries(stamp.globs)) {
    if (currentGlob(patterns) !== old) return dirty(`wildcard(${patterns}) was changed, regenerating...`);
  }
  for (const [filename, old] of Object.entries(stamp.fileReads)) {
    if (!sameSnapshot(old, snapshot(filename))) return dirty(`$(file <${filename}) was changed, regenerating...`);
  }
  for (const shellResult of stamp.shellResults) {
    const result = spawnSync(shellResult.shell, [shellResult.shellFlag, shellResult.command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const output = formatForCommandSubstitution(result.stdout ?? "");
    if (output !== shellResult.result) return dirty(`$(shell ${shellResult.command}) was changed, regenerating...`);
  }
  for (const write of stamp.fileWrites) {
    if (write.append) appendFileSync(write.filename, write.text, "latin1");
    else writeFileSync(write.filename, write.text, "latin1");
  }
  return false;
}

function writeRegenStamp(make: Make, args: readonly string[]): void {
  const files = Object.fromEntries(make.parsedFiles.map((filename) => [filename, snapshot(filename)]));
  const extraFiles = Object.fromEntries([...make.evaluator.extraFileDeps].map((filename) => [filename, snapshot(filename)]));
  const environmentNames = new Set([...make.evaluator.usedEnvironment, ...make.evaluator.usedUndefined, "PATH"]);
  const environment = Object.fromEntries([...environmentNames].map((name) => [name, process.env[name] ?? null]));
  const fileReads = Object.fromEntries([...make.evaluator.fileReads].map((filename) => [filename, snapshot(filename)]));
  const stamp: RegenStamp = {
    version: 1,
    args: argumentSignature(args),
    files, extraFiles, environment,
    globs: Object.fromEntries(make.evaluator.globResults),
    shellResults: make.evaluator.shellResults,
    fileReads,
    fileWrites: make.evaluator.fileWrites,
  };
  writeFileSync(".kati_stamp", JSON.stringify(stamp), "utf8");
}

function generateNinja(make: Make, options: ParsedOptions): void {
  const lines = ["# Generated by tkati", ""];
  const defaults = options.targets.length > 0 ? options.targets : make.defaultTargetName() ? [make.defaultTargetName()!] : [];
  if (defaults.length === 0) throw new Error("*** No targets.");
  const roots = options.genAllTargets ? make.targetNames() : defaults;
  lines.push("build _kati_always_build_: phony", "");
  let ruleId = 0;
  for (const node of make.ninjaGraph(roots)) {
    const prerequisites = node.prerequisites.map(ninjaEscape);
    if (node.phony) prerequisites.unshift("_kati_always_build_");
    const orderOnly = node.orderOnly.length > 0 ? ` || ${node.orderOnly.map(ninjaEscape).join(" ")}` : "";
    const validations = node.validations.length > 0 ? ` |@ ${node.validations.map(ninjaEscape).join(" ")}` : "";
    let rule = "phony";
    if (node.commands.length > 0) {
      rule = `rule${ruleId++}`;
      const translated = node.commands.map((command) => ({ ...command, text: translateCommand(command.text) }))
        .filter((command) => command.text !== "" && !(command.text.replace(/\/$/, "") === `mkdir -p ${node.target.includes("/") ? node.target.slice(0, node.target.lastIndexOf("/")) : "."}` && !command.echo));
      const question = `$(for f in ${node.prerequisites.map(shellQuote).join(" ")}; do if [ ! -e ${shellQuote(node.target)} ] || [ \"$f\" -nt ${shellQuote(node.target)} ]; then printf '%s ' \"$f\"; fi; done)`;
      const commandText = translated.map((command) => {
        const text = command.text.replaceAll("__TKATI_QUESTION__", question);
        const needsSubshell = translated.length > 1 || command.ignoreError;
        const body = needsSubshell ? `( ${text}${command.ignoreError ? " ; true" : ""} )` : text;
        return body;
      }).join(" && ");
      const shell = make.evaluator.expandVariable("SHELL") || "/bin/sh";
      const shellFlag = make.evaluator.posix ? "-ec" : "-c";
      const ninjaCommand = (`${shell} ${shellFlag} ${shellQuote(commandText)}`).split("$").join("$$");
      lines.push(`rule ${rule}`, `  command = ${ninjaCommand}`, `  description = TKATI ${ninjaEscape(node.target)}`);
      if (options.emitSandbox) lines.push("  sandbox_disabled = true");
      lines.push("");
    }
    const outputs = [ninjaEscape(node.target), ...node.implicitOutputs.map(ninjaEscape)];
    const outputText = outputs.length > 1 ? `${outputs[0]} | ${outputs.slice(1).join(" ")}` : outputs[0];
    lines.push(`build ${outputText}: ${rule}${prerequisites.length ? " " + prerequisites.join(" ") : ""}${orderOnly}${validations}`);
    if (node.pool && node.pool !== "none") lines.push(`  pool = ${node.pool}`);
    else if (!node.pool && options.defaultPool && node.commands.length > 0) lines.push(`  pool = ${options.defaultPool}`);
    lines.push("");
  }
  if (defaults.length > 0) lines.push(`default ${options.genAllTargets ? ninjaEscape(make.defaultTargetName()!) : defaults.map(ninjaEscape).join(" ")}`, "");
  writeFileSync("build.ninja", lines.join("\n"), "latin1");
  writeFileSync("ninja.sh", "#!/bin/sh\n. ./env.sh\nexec ninja -f build.ninja \"$@\"\n", "utf8");
  chmodSync("ninja.sh", 0o755);
  writeFileSync("env.sh", ["#!/bin/sh", ...make.ninjaEnvironment(), ""].join("\n"), "utf8");
  writeRegenStamp(make, process.argv.slice(2));
}

let activeMake: Make | undefined;
try {
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);
  if (options.directory) process.chdir(options.directory);
  if (options.generateNinja && options.regen && !needsRegeneration(rawArgs)) {
    process.exitCode = 0;
  } else {
    activeMake = new Make(options);
    activeMake.parse();
    if (options.generateNinja) {
      generateNinja(activeMake, options);
      process.exitCode = 0;
    } else {
      process.exitCode = activeMake.run();
    }
  }
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  if (activeMake && message.startsWith("***") && message !== "*** No targets." && !message.startsWith("*** No rule to make target") && !message.startsWith("*** [")) {
    message = `${activeMake.evaluator.currentFile}:${activeMake.evaluator.currentLine}: ${message}`;
  }
  if (message !== "__silent__") console.error(message);
  process.exitCode = 1;
}
