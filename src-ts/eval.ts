/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, existsSync, globSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname as pathDirname, resolve } from "node:path";
import { intern, type Symbol } from "./symtab.ts";
import {
  Pattern,
  absPath,
  basename,
  dirname,
  formatForCommandSubstitution,
  normalizeWords,
  stripExt,
  trimSpace,
  words,
} from "./string.ts";

export type VariableFlavor = "recursive" | "simple";
export type VariableOrigin =
  | "default" | "environment" | "environment override" | "file"
  | "command line" | "override" | "automatic";

export interface Variable {
  value: string;
  flavor: VariableFlavor;
  origin: VariableOrigin;
  file?: string;
  line?: number;
  readonly?: boolean;
  deprecated?: string;
  obsolete?: string;
  visibility?: string[];
}

export interface RegenShellResult {
  command: string;
  result: string;
  shell: string;
  shellFlag: string;
}

export interface RegenFileWrite {
  filename: string;
  text: string;
  append: boolean;
}

type Builtin = (args: readonly string[], evaluator: Evaluator) => string;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delayedPrint(message: string, stderr = false): string {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
  return `printf '%b\\n' ${shellQuote(escaped)}${stderr ? " >&2" : ""}`;
}

function splitArguments(value: string, arity: number): string[] {
  const result: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
      stack.push(value[index + 1] === "(" ? ")" : "}");
      index++;
    } else if (char === "(" || char === "{") {
      stack.push(char === "(" ? ")" : "}");
    } else if (char === stack[stack.length - 1]) {
      stack.pop();
    } else if (char === "," && stack.length === 0 && (arity === 0 || result.length + 1 < arity)) {
      result.push(value.slice(start, index).replace(/[ \t]*\\\n[ \t]*/g, " "));
      start = index + 1;
    }
  }
  result.push(value.slice(start).replace(/[ \t]*\\\n[ \t]*/g, " "));
  return result;
}

function zipJoin(left: readonly string[], right: readonly string[]): string {
  const result: string[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) result.push((left[index] ?? "") + (right[index] ?? ""));
  return result.join(" ");
}

function numeric(value: string, functionName: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`*** non-numeric first argument to '${functionName}' function: '${value}'.`);
  return Number(value);
}

function expandedWords(value: string, evaluator: Evaluator): string[] {
  return [...words(evaluator.expand(value))];
}

const builtins = new Map<string, Builtin>();
const builtinArities = new Map<string, number>();
const builtin = (name: string, implementation: Builtin): void => {
  builtins.set(name, implementation);
};

for (const [name, arity] of Object.entries({
  patsubst: 3, strip: 1, subst: 3, findstring: 2, filter: 2, "filter-out": 2,
  sort: 1, word: 2, wordlist: 3, words: 1, firstword: 1, lastword: 1, join: 2,
  wildcard: 1, dir: 1, notdir: 1, suffix: 1, basename: 1, addsuffix: 2,
  addprefix: 2, realpath: 1, abspath: 1, if: 3, and: 0, or: 0, value: 1,
  eval: 1, shell: 1, call: 0, foreach: 3, origin: 1, flavor: 1, info: 1,
  warning: 1, error: 1, file: 2, KATI_foreach_sep: 4, KATI_variable_location: 1,
  KATI_extra_file_deps: 0, KATI_shell_no_rerun: 1, KATI_profile_makefile: 0,
  KATI_file_no_rerun: 2,
  KATI_debug_var: 1, KATI_deprecated_var: 2, KATI_obsolete_var: 2,
  KATI_deprecate_export: 1, KATI_obsolete_export: 1,
})) builtinArities.set(name, arity);

builtin("patsubst", (args, ev) => {
  const pattern = new Pattern(ev.expand(args[0] ?? ""));
  const replacement = ev.expand(args[1] ?? "");
  return expandedWords(args[2] ?? "", ev).map((word) => pattern.subst(word, replacement)).join(" ");
});
builtin("strip", (args, ev) => normalizeWords(ev.expand(args[0] ?? "")));
builtin("subst", (args, ev) => {
  const pattern = ev.expand(args[0] ?? "");
  const replacement = ev.expand(args[1] ?? "");
  const value = ev.expand(args[2] ?? "");
  return pattern === "" ? value + replacement : value.split(pattern).join(replacement);
});
builtin("findstring", (args, ev) => {
  const needle = ev.expand(args[0] ?? "");
  return ev.expand(args[1] ?? "").includes(needle) ? needle : "";
});
builtin("filter", (args, ev) => {
  const patterns = expandedWords(args[0] ?? "", ev).map((value) => new Pattern(value));
  return expandedWords(args[1] ?? "", ev).filter((value) => patterns.some((pattern) => pattern.matches(value))).join(" ");
});
builtin("filter-out", (args, ev) => {
  const patterns = expandedWords(args[0] ?? "", ev).map((value) => new Pattern(value));
  return expandedWords(args[1] ?? "", ev).filter((value) => !patterns.some((pattern) => pattern.matches(value))).join(" ");
});
builtin("sort", (args, ev) => [...new Set(expandedWords(args[0] ?? "", ev))].sort().join(" "));
builtin("word", (args, ev) => {
  const index = numeric(trimSpace(ev.expand(args[0] ?? "")), "word");
  if (index === 0) throw new Error("*** first argument to 'word' function must be greater than 0.");
  return expandedWords(args[1] ?? "", ev)[index - 1] ?? "";
});
builtin("wordlist", (args, ev) => {
  const first = numeric(trimSpace(ev.expand(args[0] ?? "")), "wordlist");
  const last = numeric(trimSpace(ev.expand(args[1] ?? "")), "wordlist");
  if (first === 0) throw new Error("*** first argument to 'wordlist' function must be greater than 0.");
  return expandedWords(args[2] ?? "", ev).slice(first - 1, last).join(" ");
});
builtin("words", (args, ev) => String(expandedWords(args[0] ?? "", ev).length));
builtin("firstword", (args, ev) => expandedWords(args[0] ?? "", ev)[0] ?? "");
builtin("lastword", (args, ev) => expandedWords(args[0] ?? "", ev).at(-1) ?? "");
builtin("join", (args, ev) => zipJoin(expandedWords(args[0] ?? "", ev), expandedWords(args[1] ?? "", ev)));
builtin("wildcard", (args, ev) => {
  const result: string[] = [];
  const expandedPatterns = ev.expand(args[0] ?? "");
  for (let pattern of words(expandedPatterns)) {
    pattern = pattern.replace(/\\(.)/g, "$1");
    if (!/[?*[]/.test(pattern)) {
      if (existsSync(pattern)) result.push(pattern);
      continue;
    }
    const wildcard = pattern.search(/[?*[]/);
    const slash = pattern.lastIndexOf("/", wildcard);
    const prefix = slash < 0 ? "" : pattern.slice(0, slash + 1);
    const parentTraversal = prefix.indexOf("/../");
    if (parentTraversal >= 0 && !existsSync(prefix.slice(0, parentTraversal))) continue;
    for (const match of globSync(pattern).sort()) {
      result.push(prefix.includes("..") ? prefix + basename(match) : match);
    }
  }
  const value = result.join(" ");
  ev.globResults.set(expandedPatterns, value);
  return value;
});
builtin("dir", (args, ev) => expandedWords(args[0] ?? "", ev).map((value) => {
  const result = dirname(value);
  return result === "" ? "/" : result === "." ? "./" : result + "/";
}).join(" "));
builtin("notdir", (args, ev) => expandedWords(args[0] ?? "", ev).map((value) => value === "/" ? "" : basename(value)).join(" "));
builtin("suffix", (args, ev) => expandedWords(args[0] ?? "", ev).map((value) => {
  const dot = value.lastIndexOf(".");
  return dot > value.lastIndexOf("/") ? value.slice(dot) : "";
}).filter(Boolean).join(" "));
builtin("basename", (args, ev) => expandedWords(args[0] ?? "", ev).map(stripExt).join(" "));
builtin("addsuffix", (args, ev) => {
  const suffix = ev.expand(args[0] ?? "");
  return expandedWords(args[1] ?? "", ev).map((value) => value + suffix).join(" ");
});
builtin("addprefix", (args, ev) => {
  const prefix = ev.expand(args[0] ?? "");
  return expandedWords(args[1] ?? "", ev).map((value) => prefix + value).join(" ");
});
builtin("realpath", (args, ev) => expandedWords(args[0] ?? "", ev).map((value) => {
  try { return realpathSync(value); } catch { return ""; }
}).filter(Boolean).join(" "));
builtin("abspath", (args, ev) => expandedWords(args[0] ?? "", ev).map(absPath).join(" "));
builtin("if", (args, ev) => trimSpace(ev.expand(args[0] ?? "")) !== "" ? ev.expand(args[1] ?? "") : ev.expand(args[2] ?? ""));
builtin("and", (args, ev) => {
  let result = "";
  for (const arg of args) {
    result = ev.expand(trimSpace(arg));
    if (trimSpace(result) === "") return "";
  }
  return result;
});
builtin("or", (args, ev) => {
  for (const arg of args) {
    const result = ev.expand(trimSpace(arg));
    if (trimSpace(result) !== "") return result;
  }
  return "";
});
builtin("value", (args, ev) => ev.getVariable(trimSpace(ev.expand(args[0] ?? "")))?.value ?? "");
builtin("eval", (args, ev) => { ev.evalText(ev.expand(args[0] ?? ""), "<eval>"); return ""; });
builtin("shell", (args, ev) => {
  let command = ev.expand(args[0] ?? "");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1]!))) {
      command = command.slice(0, index);
      break;
    }
  }
  return ev.shell(command);
});
builtin("call", (args, ev) => {
  const name = trimSpace(ev.expand(args[0] ?? ""));
  const saved = new Map<string, Variable | undefined>();
  let index = 1;
  for (; index < args.length; index++) {
    const symbol = String(index);
    saved.set(symbol, ev.getVariable(symbol));
    ev.setVariable(symbol, { value: ev.expand(args[index]!), flavor: "simple", origin: "automatic" }, true);
  }
  for (;; index++) {
    const symbol = String(index);
    const previous = ev.getVariable(symbol);
    if (previous?.origin !== "automatic") break;
    saved.set(symbol, previous);
    ev.setVariable(symbol, { value: "", flavor: "simple", origin: "automatic" }, true);
  }
  try { return ev.expandMacro(name); } finally {
    for (const [name, variable] of saved) ev.restoreVariable(name, variable);
  }
});
builtin("foreach", (args, ev) => {
  const name = trimSpace(ev.expand(args[0] ?? ""));
  const values = expandedWords(args[1] ?? "", ev);
  const previous = ev.getVariable(name);
  const result: string[] = [];
  try {
    for (const value of values) {
      ev.setVariable(name, { value, flavor: "simple", origin: "automatic" }, true);
      result.push(ev.expand(args[2] ?? ""));
    }
  } finally { ev.restoreVariable(name, previous); }
  return result.join(" ");
});
builtin("origin", (args, ev) => ev.getVariable(trimSpace(ev.expand(args[0] ?? "")))?.origin ?? "undefined");
builtin("flavor", (args, ev) => ev.getVariable(trimSpace(ev.expand(args[0] ?? "")))?.flavor ?? "undefined");
builtin("info", (args, ev) => {
  const message = ev.expand(args[0] ?? "");
  if (ev.generatingNinja && ev.inRecipe) ev.delayedNinjaCommands.push(delayedPrint(message));
  else if (process.env.TKATI_NINJA_CHILD !== "1" || ev.inRecipe) writeSync(1, message + "\n");
  return "";
});
builtin("warning", (args, ev) => { ev.warning(ev.expand(args[0] ?? "")); return ""; });
builtin("error", (args, ev) => {
  const message = ev.expand(args[0] ?? "");
  if (ev.generatingNinja && ev.inRecipe) {
    ev.delayedNinjaCommands.push(delayedPrint(`${ev.currentFile}:${ev.currentLine}: *** ${message}.`, true) + " && false");
    return "";
  }
  throw new Error("*** " + message + ".");
});
builtin("file", (args, ev) => ev.fileFunction(args));
builtin("KATI_file_no_rerun", (args, ev) => ev.fileFunction(args, false));
builtin("KATI_foreach_sep", (args, ev) => {
  const name = trimSpace(ev.expand(args[0] ?? ""));
  const separator = ev.expand(args[1] ?? "");
  const values = expandedWords(args[2] ?? "", ev);
  const previous = ev.getVariable(name);
  try {
    return values.map((value) => {
      ev.setVariable(name, { value, flavor: "simple", origin: "automatic" }, true);
      return ev.expand(args[3] ?? "");
    }).join(separator);
  } finally { ev.restoreVariable(name, previous); }
});
builtin("KATI_variable_location", (args, ev) => {
  const result: string[] = [];
  for (const name of words(ev.expand(args[0] ?? ""))) {
    const variable = ev.getVariable(name);
    result.push(variable?.file ? `${variable.file}:${variable.line ?? 0}` : "<unknown>:0");
  }
  return result.join(" ");
});
builtin("KATI_extra_file_deps", (args, ev) => {
  for (const filename of words(ev.expand(args.join(",")))) {
    if (!existsSync(filename)) throw new Error(`file does not exist: ${filename}`);
    ev.extraFileDeps.add(filename);
  }
  return "";
});
builtin("KATI_shell_no_rerun", (args, ev) => {
  if (ev.inRecipe) throw new Error(`${ev.currentFile}:${ev.currentLine}: KATI_shell_no_rerun provides no benefit over regular $(shell) inside of a rule.`);
  return ev.shell(ev.expand(args[0] ?? ""), false);
});
builtin("KATI_profile_makefile", () => "");
builtin("KATI_debug_var", (args, ev) => {
  const name = trimSpace(ev.expand(args[0] ?? ""));
  const variable = ev.getVariable(name);
  console.error(`${name}: ${variable?.value ?? ""}`);
  return "";
});
builtin("KATI_deprecated_var", (args, ev) => {
  const detail = ev.expand(args[1] ?? "");
  const message = detail === "" ? "" : `. ${detail}`;
  for (const name of words(ev.expand(args[0] ?? ""))) {
    const variable = ev.getVariable(name) ?? { value: "", flavor: "recursive", origin: "file" } as Variable;
    if (variable.obsolete !== undefined) throw new Error(`*** Cannot call KATI_deprecated_var on already obsolete variable: ${name}.`);
    if (variable.deprecated !== undefined) throw new Error(`*** Cannot call KATI_deprecated_var on already deprecated variable: ${name}.`);
    variable.deprecated = message;
    ev.setVariable(name, variable, true);
  }
  return "";
});
builtin("KATI_obsolete_var", (args, ev) => {
  const detail = ev.expand(args[1] ?? "");
  const message = detail === "" ? "" : `. ${detail}`;
  for (const name of words(ev.expand(args[0] ?? ""))) {
    const variable = ev.getVariable(name) ?? { value: "", flavor: "recursive", origin: "file" } as Variable;
    if (variable.obsolete !== undefined) throw new Error(`*** Cannot call KATI_obsolete_var on already obsolete variable: ${name}.`);
    if (variable.deprecated !== undefined) throw new Error(`*** Cannot call KATI_obsolete_var on already deprecated variable: ${name}.`);
    variable.obsolete = message;
    ev.setVariable(name, variable, true);
  }
  return "";
});
builtin("KATI_deprecate_export", (args, ev) => { ev.deprecatedExport = ev.expand(args[0] ?? ""); return ""; });
builtin("KATI_obsolete_export", (args, ev) => { ev.obsoleteExport = ev.expand(args[0] ?? ""); return ""; });
builtin("KATI_visibility_prefix", (args, ev) => {
  const names = [...words(ev.expand(args[0] ?? ""))];
  const prefixes = [...words(ev.expand(args[1] ?? ""))];
  for (const prefix of prefixes) {
    if (prefix.startsWith("/")) throw new Error(`${ev.currentFile}:${ev.currentLine}: Visibility prefix should not start with /`);
    if (prefix === ".." || prefix.startsWith("../")) throw new Error(`${ev.currentFile}:${ev.currentLine}: Visibility prefix should not start with ../`);
    const normalized = prefix.replace(/\/$/, "");
    if (normalized !== prefix) throw new Error(`${ev.currentFile}:${ev.currentLine}: Visibility prefix ${prefix} is not normalized. Normalized prefix: ${normalized}`);
  }
  for (const prefix of prefixes) {
    const broader = prefixes.find((candidate) => candidate !== prefix && prefix.startsWith(candidate + "/"));
    if (broader) throw new Error(`${ev.currentFile}:${ev.currentLine}: Visibility prefix ${broader} is the prefix of another visibility prefix ${prefix}`);
  }
  for (const name of names) {
    const variable = ev.getVariable(name) ?? { value: "", flavor: "recursive", origin: "file" } as Variable;
    if (variable.visibility && variable.visibility.join("\0") !== prefixes.join("\0")) {
      throw new Error(`Visibility prefix conflict on variable: ${name}`);
    }
    variable.visibility = prefixes;
    ev.setVariable(name, variable, true);
  }
  return "";
});

export class Evaluator {
  readonly variables = new Map<Symbol, Variable>();
  private readonly expanding = new Set<Symbol>();
  currentFile = "Makefile";
  currentLine = 0;
  shellStatus = 0;
  deprecatedExport: string | undefined;
  obsoleteExport: string | undefined;
  inRecipe = false;
  deferAutomatic = false;
  posix = false;
  werrorFind = false;
  generatingNinja = false;
  readonly delayedNinjaCommands: string[] = [];
  readonly usedEnvironment = new Set<string>();
  readonly usedUndefined = new Set<string>();
  readonly globResults = new Map<string, string>();
  readonly shellResults: RegenShellResult[] = [];
  readonly fileReads = new Set<string>();
  readonly fileWrites: RegenFileWrite[] = [];
  readonly extraFileDeps = new Set<string>();
  evalText: (text: string, filename: string) => void = () => {};

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined) this.variables.set(intern(name), { value, flavor: "recursive", origin: "environment" });
    }
    this.variables.set(intern(".SHELLSTATUS"), {
      value: "", flavor: "simple", origin: "default", readonly: true,
    });
  }

  getVariable(name: string): Variable | undefined {
    return this.variables.get(intern(name));
  }

  setVariable(name: string, variable: Variable, force = false): void {
    const symbol = intern(name);
    const previous = this.variables.get(symbol);
    if (!force && previous?.readonly) throw new Error(`*** cannot assign to readonly variable: ${name}`);
    if (!force && previous?.obsolete !== undefined) throw new Error(`*** ${name} is obsolete${previous.obsolete}.`);
    if (!force && previous?.deprecated !== undefined) {
      this.warning(`${name} has been deprecated${previous.deprecated}.`);
      variable.deprecated = previous.deprecated;
    }
    if (!force && previous?.visibility) variable.visibility = previous.visibility;
    if (!force && previous && (previous.origin === "command line" || previous.origin === "override") && variable.origin === "file") return;
    this.variables.set(symbol, variable);
  }

  restoreVariable(name: string, variable: Variable | undefined): void {
    const symbol = intern(name);
    if (variable) this.variables.set(symbol, variable);
    else this.variables.delete(symbol);
  }

  expandVariable(name: string): string {
    if (name === ".SHELLSTATUS" && this.inRecipe) {
      throw new Error(`${this.currentFile}:${this.currentLine}: Kati does not support using .SHELLSTATUS inside of a rule`);
    }
    const symbol = intern(name);
    if (name === ".VARIABLES") return [...this.variables.keys()].join(" ");
    if (name === ".KATI_SYMBOLS") {
      return [...this.variables.entries()]
        .filter(([, variable]) => variable.flavor === "simple" ||
          (!/\$\([0-9]+\)/.test(variable.value) && !/\$\(\$[({]/.test(variable.value)))
        .map(([symbol]) => symbol)
        .join(" ");
    }
    const variable = this.variables.get(symbol);
    if (!variable && this.deferAutomatic && "@<^+?|*%".includes(name)) return `$${name}`;
    if (!variable) {
      this.usedUndefined.add(name);
      return "";
    }
    if (variable.origin === "environment" || variable.origin === "environment override") this.usedEnvironment.add(name);
    if (variable.visibility && variable.visibility.length > 0 &&
        !variable.visibility.some((prefix) => this.currentFile === prefix || this.currentFile.startsWith(prefix + "/"))) {
      throw new Error(`${this.currentFile} is not a valid file to reference variable ${name}. Line #${this.currentLine}.\nValid file prefixes:\n${variable.visibility.join("\n")}`);
    }
    if (variable.obsolete !== undefined) throw new Error(`*** ${name} is obsolete${variable.obsolete}.`);
    if (variable.deprecated !== undefined) this.warning(`${name} has been deprecated${variable.deprecated}.`);
    if (variable.flavor === "simple") return variable.value;
    if (this.expanding.has(symbol)) {
      const prefix = variable.file ? `${variable.file}:${variable.line ?? 0}: ` : "";
      throw new Error(`${prefix}*** Recursive variable '${name}' references itself (eventually).`);
    }
    this.expanding.add(symbol);
    try { return this.expand(variable.value); } finally { this.expanding.delete(symbol); }
  }

  expandMacro(name: string): string {
    const variable = this.getVariable(name);
    if (!variable) return "";
    if (variable.deprecated !== undefined) this.warning(`${name} has been deprecated${variable.deprecated}.`);
    if (variable.obsolete !== undefined) throw new Error(`*** ${name} is obsolete${variable.obsolete}.`);
    return variable.flavor === "simple" ? variable.value : this.expand(variable.value);
  }

  expand(input: string): string {
    let output = "";
    let literalStart = 0;
    for (let index = 0; index < input.length; index++) {
      if (input[index] !== "$") continue;
      output += input.slice(literalStart, index);
      if (index + 1 >= input.length) {
        output += "$";
        literalStart = index + 1;
        continue;
      }
      const next = input[++index]!;
      if (next === "$") {
        output += "$";
      } else if (next !== "(" && next !== "{") {
        output += this.expandVariable(next);
      } else {
        const close = next === "(" ? ")" : "}";
        const stack = [close];
        const start = index + 1;
        const functionHead = /^([^\s,:)}]+)/.exec(input.slice(start))?.[1] ?? "";
        const allowRawParens = builtins.has(functionHead);
        while (stack.length > 0 && ++index < input.length) {
          if (input[index] === "$" && (input[index + 1] === "(" || input[index + 1] === "{")) {
            stack.push(input[index + 1] === "(" ? ")" : "}");
            index++;
          } else if (input[index] === next && allowRawParens) {
            stack.push(close);
          } else if (input[index] === stack[stack.length - 1]) {
            stack.pop();
          }
        }
        if (stack.length > 0) {
          if (builtins.has(functionHead)) throw new Error(`*** unterminated call to function '${functionHead}': missing '${close}'.`);
          const unmatchedClose = input.indexOf(close, start);
          if (unmatchedClose >= 0) {
            output += this.expandVariable(input.slice(start, unmatchedClose));
            index = input.length;
            literalStart = index;
            continue;
          }
          throw new Error("*** unterminated variable reference.");
        }
        output += this.expandReference(input.slice(start, index));
      }
      literalStart = index + 1;
    }
    return output + input.slice(literalStart);
  }

  private expandReference(reference: string): string {
    let separator = 0;
    while (separator < reference.length && reference[separator] !== " " && reference[separator] !== "\t" && reference[separator] !== ",") separator++;
    const functionName = reference.slice(0, separator);
    const implementation = builtins.get(functionName);
    if (implementation && separator < reference.length) {
      let body = reference.slice(separator);
      if (body[0] === " " || body[0] === "\t") body = body.replace(/^[ \t]+/, "");
      else if (body[0] === ",") body = body.slice(1);
      return implementation(splitArguments(body, builtinArities.get(functionName) ?? 0), this);
    }
    const expanded = this.expand(reference);
    if (expanded.length === 2 && (expanded[1] === "D" || expanded[1] === "F")) {
      if (this.deferAutomatic && !this.getVariable(expanded[0]!)) return `$(${expanded})`;
      const value = this.expandVariable(expanded[0]!);
      return [...words(value)].map((word) => expanded[1] === "D" ? dirname(word) : basename(word)).join(" ");
    }
    const colon = expanded.indexOf(":");
    const equal = colon < 0 ? -1 : expanded.indexOf("=", colon + 1);
    if (equal >= 0) {
      const value = this.expandVariable(expanded.slice(0, colon));
      const pattern = new Pattern(expanded.slice(colon + 1, equal));
      const replacement = expanded.slice(equal + 1);
      return [...words(value)].map((word) => pattern.substSuffix(word, replacement)).join(" ");
    }
    return this.expandVariable(expanded);
  }

  shell(command: string, rerun = true): string {
    if (this.generatingNinja && this.inRecipe && command !== "" && !/^echo \$\(\(.*\)\)$/.test(command)) {
      return `$(${command})`;
    }
    const shell = this.expandVariable("SHELL") || "/bin/sh";
    const shellFlag = this.posix ? "-ec" : "-c";
    const result = spawnSync(shell, [shellFlag, command], { encoding: "utf8" });
    this.shellStatus = result.status ?? 127;
    this.setVariable(".SHELLSTATUS", {
      value: String(this.shellStatus), flavor: "simple", origin: "default", readonly: true,
    }, true);
    if (result.stderr) process.stderr.write(result.stderr);
    if ((result.status ?? 0) !== 0 && this.werrorFind && /^\s*find\s/.test(command)) throw new Error("__silent__");
    const output = formatForCommandSubstitution(result.stdout ?? "");
    if (rerun) this.shellResults.push({ command, result: output, shell, shellFlag });
    return output;
  }

  fileFunction(args: readonly string[], rerun = true): string {
    const operation = this.expand(args[0] ?? "");
    if (operation.startsWith(">>")) {
      const filename = trimSpace(operation.slice(2));
      const text = this.expand(args[1] ?? "") + "\n";
      appendFileSync(filename, text, "latin1");
      if (rerun) this.fileWrites.push({ filename, text, append: true });
      return "";
    }
    if (operation.startsWith(">")) {
      const filename = trimSpace(operation.slice(1));
      const text = this.expand(args[1] ?? "") + "\n";
      writeFileSync(filename, text, "latin1");
      if (rerun) this.fileWrites.push({ filename, text, append: false });
      return "";
    }
    const filename = trimSpace(operation.startsWith("<") ? operation.slice(1) : operation);
    if (rerun) this.fileReads.add(filename);
    try { return readFileSync(filename, "latin1").replace(/\n$/, ""); }
    catch { return ""; }
  }

  warning(message: string): void {
    if (this.generatingNinja && this.inRecipe) {
      this.delayedNinjaCommands.push(delayedPrint(`${this.currentFile}:${this.currentLine}: ${message}`, true));
      return;
    }
    if (process.env.TKATI_NINJA_CHILD === "1" && !this.inRecipe) return;
    console.error(`${this.currentFile}:${this.currentLine}: ${message}`);
  }
}
