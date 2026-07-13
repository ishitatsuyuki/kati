/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  globSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { Evaluator, type Variable, type VariableOrigin } from "./eval.ts";
import { Pattern, findOutsideParen, trimLeadingCurdir, trimLeftSpace, trimRightSpace, trimSpace, words } from "./string.ts";

interface Location { file: string; line: number }
interface Command { text: string; location: Location }
interface TargetVariable {
  name: string;
  variable: Variable;
  force: boolean;
  private: boolean;
  appendGlobal?: boolean;
}
interface Rule {
  targets: string[];
  prerequisites: string[];
  orderOnly: string[];
  commands: Command[];
  location: Location;
  doubleColon: boolean;
  targetPattern?: string;
  staticDeps?: { targetPattern: string; prerequisites: string[]; orderOnly: string[] }[];
  suffixRule?: boolean;
  pendingOverride?: boolean;
}

interface Conditional {
  parentActive: boolean;
  condition: boolean;
  active: boolean;
  seenElse: boolean;
  chained?: boolean;
}

export interface MakeOptions {
  makefile: string;
  silent: boolean;
  dryRun: boolean;
  alwaysMake: boolean;
  keepGoing: boolean;
  syntaxCheck: boolean;
  commandVariables: readonly string[];
  targets: readonly string[];
  werrorOverride?: boolean;
  noBuiltinRules?: boolean;
  warnSuffixRules?: boolean;
  werrorSuffixRules?: boolean;
  warnImplicitRules?: boolean;
  werrorImplicitRules?: boolean;
  warnRealToPhony?: boolean;
  werrorRealToPhony?: boolean;
  warnPhonyLooksReal?: boolean;
  werrorPhonyLooksReal?: boolean;
  warnRealNoCommandsOrDeps?: boolean;
  werrorRealNoCommandsOrDeps?: boolean;
  warnRealNoCommands?: boolean;
  werrorRealNoCommands?: boolean;
  writable?: readonly string[];
  werrorWritable?: boolean;
  topLevelPhony?: boolean;
  werrorFind?: boolean;
  defaultPool?: string;
  genAllTargets?: boolean;
}

export interface NinjaGraphNode {
  target: string;
  prerequisites: string[];
  orderOnly: string[];
  validations: string[];
  implicitOutputs: string[];
  phony: boolean;
  commands: NinjaCommand[];
  pool?: string;
}

export interface NinjaCommand {
  text: string;
  echo: boolean;
  ignoreError: boolean;
}

function stripComment(value: string): string {
  let backslashes = 0;
  const close: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
      close.push(value[index + 1] === "(" ? ")" : "}");
      index++;
      backslashes = 0;
      continue;
    }
    if (char === close.at(-1)) {
      close.pop();
      backslashes = 0;
      continue;
    }
    if (char === "\\") {
      backslashes++;
    } else {
      if (char === "#" && close.length === 0 && backslashes % 2 === 0) return value.slice(0, index).replaceAll("\\#", "#");
      backslashes = 0;
    }
  }
  return value.replaceAll("\\#", "#");
}

function shellAssignmentQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function logicalLines(text: string): { text: string; line: number; command: boolean }[] {
  const physical = text.split("\n");
  const result: { text: string; line: number; command: boolean }[] = [];
  for (let index = 0; index < physical.length; index++) {
    const lineNumber = index + 1;
    let line = physical[index]!.replace(/\r$/, "");
    const command = line.startsWith("\t");
    const continues = (): boolean => {
      const match = /\\+$/.exec(line);
      return (match?.[0].length ?? 0) % 2 === 1;
    };
    while (continues() && index + 1 < physical.length) {
      const colon = line.indexOf(":");
      const semicolon = line.indexOf(";", colon + 1);
      const preserve = command || (colon >= 0 && semicolon > colon);
      line = preserve
        ? line.replace(/\\\r?$/, "\\\n")
        : trimRightSpace(line.replace(/\\\r?$/, "")) + " ";
      const next = physical[++index]!.replace(/\r$/, "");
      const continued = command && next.startsWith("\t") ? next.slice(1) : next;
      line += preserve ? continued : trimLeftSpace(continued);
    }
    result.push({ text: line, line: lineNumber, command });
  }
  return result;
}

function splitRule(value: string): number | undefined {
  return findOutsideParen(value, ":");
}

export class Make {
  readonly evaluator: Evaluator;
  readonly options: MakeOptions;
  readonly rules = new Map<string, Rule[]>();
  readonly patternRules: Rule[] = [];
  readonly phony = new Set<string>();
  readonly phonyLocations = new Map<string, Location>();
  readonly exports = new Map<string, boolean>();
  readonly targetVariables = new Map<string, TargetVariable[]>();
  readonly parsedFiles: string[] = [];
  private defaultTarget: string | undefined;
  private currentRule: Rule | undefined;
  private readonly building = new Set<string>();
  private readonly built = new Set<string>();
  private readonly conditionalStack: Conditional[] = [];

  constructor(options: MakeOptions) {
    this.options = options;
    this.evaluator = new Evaluator();
    this.evaluator.werrorFind = !!options.werrorFind;
    this.evaluator.evalText = (text) => {
      const file = this.evaluator.currentFile;
      const line = this.evaluator.currentLine;
      this.parseText(text, file, line - 1);
    };
    this.bootstrap();
  }

  private bootstrap(): void {
    const defaults: Record<string, string> = {
      CC: "cc", CXX: "g++", AR: "ar", MAKE_VERSION: "4.2.1", KATI: "ckati",
      SHELL: "/bin/sh", MAKE: `${process.execPath} ${process.argv[1]}${this.options.silent ? " -s" : ""}`, CURDIR: process.cwd(), MAKEFILE_LIST: "",
      MAKECMDGOALS: this.options.targets.join(" "),
    };
    for (const [name, value] of Object.entries(defaults)) {
      if (!this.evaluator.getVariable(name) || name === "SHELL") {
        const flavor = name === "CURDIR" || name === "MAKEFILE_LIST" ? "simple" : "recursive";
        this.evaluator.setVariable(name, { value, flavor, origin: "default" }, true);
      }
    }
    for (const assignment of words(process.env.MAKEFLAGS ?? "")) {
      if (assignment.includes("=")) this.assign(assignment, "command line", { file: "<command line>", line: 1 });
    }
    for (const assignment of this.options.commandVariables) this.assign(assignment, "command line", { file: "<command line>", line: 1 });
    if (!this.options.noBuiltinRules) {
      this.parseText(
        ".c.o:\n\t$(CC) $(CFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c -o $@ $<\n" +
        ".cc.o:\n\t$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c -o $@ $<\n",
        "<bootstrap>",
      );
    }
    this.currentRule = undefined;
  }

  parse(): void {
    this.parseFile(this.options.makefile, false);
    if (process.env.TKATI_NINJA_CHILD !== "1") this.validateRules();
  }

  private parseFile(filename: string, optional: boolean): void {
    let text: string;
    try { text = readFileSync(filename, "latin1"); }
    catch (error) {
      if (optional) return;
      throw new Error(`${this.evaluator.currentFile}:${this.evaluator.currentLine}: ${filename}: No such file or directory`);
    }
    this.parsedFiles.push(filename);
    const list = this.evaluator.expandVariable("MAKEFILE_LIST");
    const listedFilename = trimLeadingCurdir(filename);
    this.evaluator.setVariable("MAKEFILE_LIST", {
      value: list + " " + listedFilename,
      flavor: "simple", origin: "file", file: filename, line: 1,
    }, true);
    this.parseText(text, filename);
  }

  parseText(text: string, filename: string, lineOffset = 0): void {
    const lines = logicalLines(text);
    let define: { name: string; operator: string; start: number; lines: string[]; origin: VariableOrigin; depth: number } | undefined;
    for (let sourceIndex = 0; sourceIndex < lines.length; sourceIndex++) {
      const source = lines[sourceIndex]!;
      this.evaluator.currentFile = filename;
      this.evaluator.currentLine = source.line + lineOffset;
      const location = { file: filename, line: source.line + lineOffset };
      let line = source.text;

      if (define) {
        const directive = trimLeftSpace(line);
        if (directive.startsWith("define ") || directive === "define") {
          define.depth++;
          define.lines.push(line);
        } else if (/^endef(?:\s|$)/.test(directive)) {
          define.depth--;
          if (define.depth === 0) {
            const rest = trimSpace(stripComment(directive.slice("endef".length)));
            if (rest !== "") this.evaluator.warning("extraneous text after 'endef' directive");
            this.assignDefine(define.name, define.operator, define.lines.join("\n").replace(/[ \t]*\\\n[ \t]*/g, " "), define.origin, {
              file: filename, line: define.start,
            });
            define = undefined;
          } else {
            define.lines.push(line);
          }
        } else {
          define.lines.push(line);
        }
        continue;
      }

      const tabCandidate = source.command ? trimLeftSpace(line) : "";
      const tabConditional = /^(?:ifdef|ifndef|ifeq|ifneq|else|endif)(?:\s+|$)/.test(tabCandidate);
      if (source.command && tabConditional) line = tabCandidate;
      else if (source.command && this.currentRule && this.active()) {
        if (this.currentRule.pendingOverride && this.currentRule.commands.length > 0) {
          const target = this.currentRule.targets[0] ?? "";
          const old = this.currentRule.commands[0]!.location;
          if (this.options.werrorOverride) {
            throw new Error(`${location.file}:${location.line}: *** overriding commands for target '${target}', previously defined at ${old.file}:${old.line}`);
          }
          if (process.env.TKATI_NINJA_CHILD !== "1") {
            console.error(`${location.file}:${location.line}: warning: overriding commands for target '${target}'`);
            console.error(`${old.file}:${old.line}: warning: ignoring old commands for target '${target}'`);
          }
          this.currentRule.commands.length = 0;
          this.currentRule.pendingOverride = false;
        }
        this.currentRule.commands.push({ text: line.slice(1), location });
        continue;
      }
      if (source.command && !tabConditional && !this.active()) continue;
      if (source.command && !this.currentRule) {
        const candidate = trimLeftSpace(line);
        if (candidate.startsWith("#") || candidate === "") continue;
        const topLevelTab = /^(?:ifdef|ifndef|ifeq|ifneq|else|endif|override|private|export|unexport)(?:\s+|$)/.test(candidate) || this.isAssignment(candidate);
        if (!topLevelTab) throw new Error(`${filename}:${source.line + lineOffset}: *** commands commence before first target.`);
        line = candidate;
      }

      const leftTrimmed = trimLeftSpace(line);
      const directiveText = trimSpace(stripComment(leftTrimmed));
      if (this.handleConditional(directiveText, location)) continue;
      if (!this.active()) continue;
      if (directiveText === "" || directiveText.startsWith("#")) continue;

      let override = false;
      let privateDirective = false;
      let exportDirective = false;
      let unexportDirective = false;
      line = leftTrimmed;
      for (;;) {
        const match = /^(override|private|export|unexport)(?:\s+|$)/.exec(line);
        if (!match) break;
        if (match[1] === "override") override = true;
        if (match[1] === "private") privateDirective = true;
        if (match[1] === "export") exportDirective = true;
        if (match[1] === "unexport") unexportDirective = true;
        line = trimLeftSpace(line.slice(match[0].length));
      }
      if (override && line === ":") {
        override = false;
        line = "override :";
      }

      const defineMatch = /^define(?:\s+|$)(.*)$/.exec(line);
      if (defineMatch) {
        const parsed = /^(.*?)(\?=|\+=|:=|=)?\s*$/.exec(defineMatch[1]!)!;
        define = {
          name: trimSpace(stripComment(parsed[1]!)), operator: parsed[2] ?? "=", start: source.line,
          lines: [], origin: override ? "override" : "file", depth: 1,
        };
        this.currentRule = undefined;
        continue;
      }

      const include = /^(-?include|sinclude)\s+(.+)$/.exec(line);
      if (include) {
        for (const pattern of words(this.evaluator.expand(stripComment(include[2]!)))) {
          const files = /[?*[]/.test(pattern) ? globSync(pattern).sort() : [pattern];
          if (files.length === 0 && include[1] === "include") this.parseFile(pattern, false);
          for (const file of files) this.parseFile(file, include[1] !== "include");
        }
        this.currentRule = undefined;
        continue;
      }

      if ((exportDirective || unexportDirective) && !/[=:]/.test(line)) {
        for (const name of words(this.evaluator.expand(stripComment(line)))) {
          if (this.evaluator.obsoleteExport !== undefined) throw new Error(`*** ${name}: ${exportDirective ? "export" : "unexport"} is obsolete. ${this.evaluator.obsoleteExport}.`);
          if (this.evaluator.deprecatedExport !== undefined) this.evaluator.warning(`${name}: ${exportDirective ? "export" : "unexport"} has been deprecated. ${this.evaluator.deprecatedExport}.`);
          this.exports.set(name, exportDirective);
        }
        continue;
      }

      if (this.isAssignment(line)) {
        const name = this.assign(line, override ? "override" : "file", location);
        if (exportDirective || unexportDirective) {
          if (this.evaluator.obsoleteExport !== undefined) throw new Error(`*** ${name}: ${exportDirective ? "export" : "unexport"} is obsolete. ${this.evaluator.obsoleteExport}.`);
          if (this.evaluator.deprecatedExport !== undefined) this.evaluator.warning(`${name}: ${exportDirective ? "export" : "unexport"} has been deprecated. ${this.evaluator.deprecatedExport}.`);
          this.exports.set(name, exportDirective);
        }
        this.currentRule = undefined;
        continue;
      }

      if (exportDirective && line === "") continue;
      this.parseRule(line, location, lines[sourceIndex + 1]?.command ?? false);
    }
    if (define) throw new Error(`${filename}:${define.start}: *** missing 'endef', unterminated 'define'.`);
    if (this.conditionalStack.length > 0) throw new Error(`${filename}:${lines.at(-1)?.line ?? 1}: *** missing 'endif'.`);
  }

  private active(): boolean {
    return this.conditionalStack.every((condition) => condition.active);
  }

  private handleConditional(line: string, location: Location): boolean {
    const match = /^(ifdef|ifndef|ifeq|ifneq|else|endif)(?:\s+|$)(.*)$/.exec(line);
    if (!match) return false;
    const directive = match[1]!;
    const argument = match[2]!;
      if (directive === "endif") {
      if (this.conditionalStack.length === 0) throw new Error(`${location.file}:${location.line}: *** extraneous 'endif'.`);
      let popped = this.conditionalStack.pop();
      while (popped?.chained) popped = this.conditionalStack.pop();
      return true;
    }
    if (directive === "else") {
      const current = this.conditionalStack.at(-1);
      if (!current) throw new Error(`${location.file}:${location.line}: *** extraneous 'else'.`);
      if (current.seenElse) throw new Error(`${location.file}:${location.line}: *** only one 'else' per conditional.`);
      current.seenElse = true;
      current.active = current.parentActive && !current.condition;
      if (argument !== "") {
        const nested = this.handleConditional(argument, location);
        if (!nested) this.evaluator.warning("extraneous text after 'else' directive");
        else {
          const chained = this.conditionalStack.at(-1);
          if (chained !== current) chained!.chained = true;
        }
      }
      return true;
    }
    const parentActive = this.active();
    let condition = false;
    if (directive === "ifdef" || directive === "ifndef") {
      const expandedName = this.evaluator.expand(trimRightSpace(argument));
      const name = trimRightSpace(expandedName);
      if (name === "" || trimLeftSpace(name) !== name || [...words(name)].length !== 1) {
        throw new Error(`${location.file}:${location.line}: *** invalid syntax in conditional.`);
      }
      condition = (this.evaluator.getVariable(name)?.value ?? "") !== "";
      const conditionalVariable = this.evaluator.getVariable(name);
      if (conditionalVariable?.deprecated !== undefined) this.evaluator.warning(`${name} has been deprecated${conditionalVariable.deprecated}.`);
      if (directive === "ifndef") condition = !condition;
    } else {
      const pair = this.parseEquality(argument, location);
      condition = this.evaluator.expand(pair[0]) === this.evaluator.expand(pair[1]);
      if (pair[2] !== "") this.evaluator.warning(`extraneous text after '${directive}' directive`);
      if (directive === "ifneq") condition = !condition;
    }
    this.conditionalStack.push({ parentActive, condition, active: parentActive && condition, seenElse: false });
    return true;
  }

  private parseEquality(input: string, location: Location): [string, string, string] {
    input = trimSpace(input);
    if (input.startsWith("(") && input.endsWith(")")) {
      const body = input.slice(1, -1);
      const comma = findOutsideParen(body, ",");
      if (comma === undefined) throw new Error(`${location.file}:${location.line}: *** invalid syntax in conditional.`);
      return [trimRightSpace(body.slice(0, comma)), trimLeftSpace(body.slice(comma + 1)), ""];
    }
    const quote = input[0];
    if (quote !== "'" && quote !== '"') throw new Error(`${location.file}:${location.line}: *** invalid syntax in conditional.`);
    const end = input.indexOf(quote, 1);
    if (end < 0) throw new Error(`${location.file}:${location.line}: *** invalid syntax in conditional.`);
    const rest = trimLeftSpace(input.slice(end + 1));
    const quote2 = rest[0];
    const end2 = rest.indexOf(quote2, 1);
    if ((quote2 !== "'" && quote2 !== '"') || end2 < 0) throw new Error(`${location.file}:${location.line}: *** invalid syntax in conditional.`);
    return [input.slice(1, end), rest.slice(1, end2), trimSpace(rest.slice(end2 + 1))];
  }

  private isAssignment(line: string): boolean {
    const equal = findOutsideParen(line, "=");
    if (equal === undefined) return false;
    const colon = findOutsideParen(line, ":");
    return colon === undefined || equal <= colon + 1;
  }

  private assign(line: string, origin: VariableOrigin, location: Location): string {
    const match = /^(.*?)(::=|:=|\?=|\+=|!=|=)([\s\S]*)$/.exec(line);
    if (!match) throw new Error(`${location.file}:${location.line}: *** malformed assignment.`);
    const name = internName(this.evaluator.expand(trimRightSpace(match[1]!)));
    if (name === "") throw new Error(`${location.file}:${location.line}: *** empty variable name.`);
    const operator = match[2]!;
    let raw = trimLeftSpace(stripComment(match[3]!)).replace(/\\\n[ \t]*/g, " ");
    const finalAssignment = raw.startsWith("$=");
    if (finalAssignment) raw = trimLeftSpace(raw.slice(2));
    const previous = this.evaluator.getVariable(name);
    if (operator === "?=" && previous) return name;
    if (operator === "+=" && previous) {
      const addition = previous.flavor === "simple" ? this.evaluator.expand(raw) : raw;
      this.evaluator.setVariable(name, {
        ...previous, value: previous.value + " " + addition,
        file: location.file, line: location.line,
      });
      return name;
    }
    let value = raw;
    let flavor: "simple" | "recursive" = "recursive";
    if (operator === ":=" || operator === "::=") {
      value = this.evaluator.expand(raw);
      flavor = "simple";
    } else if (operator === "!=") {
      value = this.evaluator.shell(raw);
      flavor = "recursive";
    }
    this.evaluator.setVariable(name, { value, flavor, origin, file: location.file, line: location.line });
    if (finalAssignment) this.evaluator.getVariable(name)!.readonly = true;
    if (name === ".KATI_READONLY") {
      for (const readonlyName of words(this.evaluator.expandVariable(name))) {
        const readonlyVariable = this.evaluator.getVariable(readonlyName);
        if (!readonlyVariable) throw new Error(`${location.file}:${location.line}: *** unknown variable: ${readonlyName}`);
        readonlyVariable.readonly = true;
      }
    }
    return name;
  }

  private assignDefine(nameExpression: string, operator: string, raw: string, origin: VariableOrigin, location: Location): void {
    const name = this.evaluator.expand(trimSpace(nameExpression));
    const previous = this.evaluator.getVariable(name);
    if (operator === "?=" && previous) return;
    if (operator === "+=" && previous) {
      const addition = previous.flavor === "simple" ? this.evaluator.expand(raw) : raw;
      this.evaluator.setVariable(name, { ...previous, value: previous.value + "\n" + addition });
      return;
    }
    const simple = operator === ":=" || operator === "::=";
    this.evaluator.setVariable(name, {
      value: simple ? this.evaluator.expand(raw) : raw,
      flavor: simple ? "simple" : "recursive", origin, file: location.file, line: location.line,
    });
  }

  private parseRule(line: string, location: Location, hasFollowingRecipe = false): void {
    const rawColon = splitRule(line);
    if (rawColon !== undefined) {
      const rawTargets = [...words(this.evaluator.expand(line.slice(0, rawColon)))].map(trimLeadingCurdir);
      const doubleColonAssignment = line[rawColon + 1] === ":";
      let targetAssignment = trimLeftSpace(line.slice(rawColon + (doubleColonAssignment ? 2 : 1)));
      let force = false;
      let privateDirective = false;
      for (;;) {
        const directive = /^(override|private)(?:\s+|$)/.exec(targetAssignment);
        if (!directive) break;
        if (directive[1] === "override") force = true;
        if (directive[1] === "private") privateDirective = true;
        targetAssignment = trimLeftSpace(targetAssignment.slice(directive[0].length));
      }
      const assignmentOnly = targetAssignment;
      const targetAssignmentMatch = /^(.*?)(::=|:=|\?=|\+=|!=|=)/.exec(assignmentOnly);
      if (this.isAssignment(assignmentOnly) && targetAssignmentMatch && !targetAssignmentMatch[1]!.includes(";")) {
        const match = /^(.*?)(::=|:=|\?=|\+=|!=|=)/.exec(assignmentOnly)!;
        const variableName = this.evaluator.expand(trimRightSpace(match[1]!));
        for (const target of rawTargets) {
          const entries = this.targetVariables.get(target) ?? [];
          if (variableName === ".KATI_READONLY") {
            for (const readonlyName of words(this.evaluator.expand(trimLeftSpace(assignmentOnly.slice(match[0].length))))) {
              const targetVariable = entries.findLast((entry) => entry.name === readonlyName);
              if (!targetVariable) throw new Error(`${location.file}:${location.line}: *** unknown variable: ${readonlyName}`);
              targetVariable.variable.readonly = true;
            }
            continue;
          }
          const previous = this.evaluator.getVariable(variableName);
          const scoped = new Map<string, Variable | undefined>();
          for (const entry of entries) {
            if (!scoped.has(entry.name)) scoped.set(entry.name, this.evaluator.getVariable(entry.name));
            this.evaluator.setVariable(entry.name, { ...entry.variable }, true);
          }
          let variable: Variable;
          let appendGlobal = false;
          if (match[2] === "+=" && !entries.some((entry) => entry.name === variableName)) {
            let appendedValue = trimLeftSpace(stripComment(assignmentOnly.slice(match[0].length)));
            const finalTargetAssignment = appendedValue.startsWith("$=");
            if (finalTargetAssignment) appendedValue = trimLeftSpace(appendedValue.slice(2));
            variable = {
              value: appendedValue,
              flavor: "recursive", origin: force ? "override" : "file",
              file: location.file, line: location.line,
              readonly: finalTargetAssignment,
            };
            appendGlobal = true;
          } else {
            if (match[2] !== "?=" && !entries.some((entry) => entry.name === variableName)) {
              this.evaluator.restoreVariable(variableName, undefined);
            }
            this.assign(assignmentOnly, force ? "override" : "file", location);
            variable = { ...this.evaluator.getVariable(variableName)! };
          }
          for (const [name, saved] of scoped) this.evaluator.restoreVariable(name, saved);
          this.evaluator.restoreVariable(variableName, previous);
          entries.push({ name: variableName, variable, force, private: privateDirective, appendGlobal });
          this.targetVariables.set(target, entries);
          if (!target.includes("%") && !this.rules.has(target)) {
            const placeholder: Rule = {
              targets: rawTargets, prerequisites: [], orderOnly: [], commands: [], location, doubleColon: false,
            };
            this.rules.set(target, [placeholder]);
            if (!this.defaultTarget && !target.startsWith(".")) this.defaultTarget = target;
            this.currentRule = placeholder;
          } else if (!target.includes("%")) {
            this.currentRule = this.rules.get(target)![0];
          }
        }
        return;
      }
    }
    let expanded: string;
    const rawCommandColon = rawColon;
    let expansionInput = stripComment(line);
    let deferredCommand: string | undefined;
    if (rawCommandColon !== undefined) {
      const relativeSemicolon = findOutsideParen(line.slice(rawCommandColon + 1), ";");
      if (relativeSemicolon !== undefined) {
        const semicolon = rawCommandColon + 1 + relativeSemicolon;
        expansionInput = stripComment(line.slice(0, semicolon));
        deferredCommand = line.slice(semicolon + 1);
      }
    }
    expanded = this.evaluator.expand(expansionInput);
    if (deferredCommand !== undefined) expanded += ";" + deferredCommand;
    if (rawColon === undefined) {
      const generatedColon = splitRule(expanded);
      if (generatedColon !== undefined) {
        const generatedRhs = expanded.slice(generatedColon + 1);
        if (this.isAssignment(generatedRhs)) {
          this.parseRule(expanded, location, hasFollowingRecipe);
          return;
        }
      }
    }
    const colon = splitRule(expanded);
    if (colon === undefined) {
      if (trimSpace(line).replaceAll(";", "") === "" && line.includes(";")) {
        throw new Error(`${location.file}:${location.line}: *** missing rule before commands.`);
      }
      if (trimSpace(expanded.replaceAll(";", "")) !== "") throw new Error(`${location.file}:${location.line}: *** missing separator.`);
      return;
    }
    const doubleColon = expanded[colon + 1] === ":";
    if (findOutsideParen(expanded.slice(0, colon), ";") !== undefined) {
      throw new Error(`${location.file}:${location.line}: *** missing separator.`);
    }
    const rhsStart = colon + (doubleColon ? 2 : 1);
    const semicolon = findOutsideParen(expanded.slice(rhsStart), ";");
    let dependencyText = semicolon === undefined ? expanded.slice(rhsStart) : expanded.slice(rhsStart, rhsStart + semicolon);
    const staticColon = findOutsideParen(dependencyText, ":");
    let targetPattern: string | undefined;
    if (staticColon !== undefined) {
      targetPattern = trimLeadingCurdir(trimSpace(dependencyText.slice(0, staticColon)));
      dependencyText = dependencyText.slice(staticColon + 1);
    }
    const pipe = findOutsideParen(dependencyText, "|");
    const normal = pipe === undefined ? dependencyText : dependencyText.slice(0, pipe);
    const orderOnly = pipe === undefined ? "" : dependencyText.slice(pipe + 1);
    const targets = [...words(expanded.slice(0, colon))].map(trimLeadingCurdir);
    const allowRules = this.evaluator.expandVariable(".KATI_ALLOW_RULES");
    if (targets.length > 0 && allowRules === "warning") {
      console.error(`${location.file}:${location.line}: warning: Rule not allowed here for target: ${targets.join(" ")}`);
    } else if (targets.length > 0 && allowRules === "error") {
      throw new Error(`${location.file}:${location.line}: *** Rule not allowed here for target: ${targets.join(" ")}`);
    }
    const prerequisites = [...words(normal)].map(trimLeadingCurdir);
    const orderPrerequisites = [...words(orderOnly)].map(trimLeadingCurdir);
    // Old-style suffix rules are equivalent to a single-output pattern rule.
    let suffixRule = false;
    if (targets.length === 1 && /^\.[^/.]+\.[^/.]+$/.test(targets[0]!)) {
      suffixRule = true;
      if (this.options.werrorSuffixRules) throw new Error(`${location.file}:${location.line}: *** suffix rules are obsolete: ${targets[0]}`);
      if (this.options.warnSuffixRules) console.error(`${location.file}:${location.line}: warning: suffix rules are deprecated: ${targets[0]}`);
      const split = targets[0]!.indexOf(".", 1);
      const source = targets[0]!.slice(0, split);
      const destination = targets[0]!.slice(split);
      targets[0] = "%" + destination;
      prerequisites.unshift("%" + source);
    }
    const rule: Rule = {
      targets,
      prerequisites: targetPattern ? [] : prerequisites,
      orderOnly: targetPattern ? [] : orderPrerequisites,
      commands: [], location, doubleColon,
      staticDeps: targetPattern ? [{ targetPattern, prerequisites, orderOnly: orderPrerequisites }] : undefined,
      suffixRule,
    };
    if (targets.includes(".SUFFIXES") && prerequisites.length === 0) {
      for (let index = this.patternRules.length - 1; index >= 0; index--) {
        if (this.patternRules[index]!.suffixRule) this.patternRules.splice(index, 1);
      }
    }
    if (!suffixRule && targets.some((target) => target.includes("%"))) {
      const patternName = targets.find((target) => target.includes("%"))!;
      if (this.options.werrorImplicitRules) throw new Error(`${location.file}:${location.line}: *** implicit rules are obsolete: ${patternName}`);
      if (this.options.warnImplicitRules) console.error(`${location.file}:${location.line}: warning: implicit rules are deprecated: ${patternName}`);
    }
    if (targetPattern) {
      for (const target of targets) {
        if (!new Pattern(targetPattern).matches(target) && process.env.TKATI_NINJA_CHILD !== "1") console.error(`${location.file}:${location.line}: target '${target}' doesn't match the target pattern`);
      }
    }
    if (targets.length === 0) this.currentRule = rule;
    if (semicolon !== undefined) {
      rule.commands.push({ text: trimLeftSpace(expanded.slice(rhsStart + semicolon + 1)), location });
    }
    for (const target of targets) {
      if (target === ".POSIX") this.evaluator.posix = true;
      if (target === ".PHONY") {
        for (const prerequisite of rule.prerequisites) {
          this.phony.add(prerequisite);
          this.phonyLocations.set(prerequisite, location);
        }
        this.currentRule = rule;
        continue;
      }
      if (!this.defaultTarget && !target.startsWith(".") && !target.includes("%")) this.defaultTarget = target;
      if (target.includes("%")) {
        const same = this.patternRules.find((candidate) =>
          candidate.targets.length === rule.targets.length &&
          candidate.targets.every((value, index) => value === rule.targets[index]) &&
          candidate.prerequisites.join("\0") === rule.prerequisites.join("\0") &&
          candidate.suffixRule === rule.suffixRule);
        if (same) {
          same.commands = [];
          this.currentRule = same;
        }
        else {
          if (!this.patternRules.includes(rule)) this.patternRules.push(rule);
          this.currentRule = rule;
        }
      } else {
        const targetRule: Rule = rule.staticDeps ? {
          ...rule,
          targets: [target],
          prerequisites: [...rule.prerequisites],
          orderOnly: [...rule.orderOnly],
          staticDeps: rule.staticDeps.map((entry) => ({
            targetPattern: entry.targetPattern,
            prerequisites: [...entry.prerequisites],
            orderOnly: [...entry.orderOnly],
          })),
          commands: rule.commands,
        } : rule;
        const existing = this.rules.get(target) ?? [];
        if (existing.some((candidate) => candidate.doubleColon !== doubleColon)) {
          throw new Error(`${location.file}:${location.line}: *** target file '${target}' has both : and :: entries.`);
        }
        if (!doubleColon && existing.length > 0) {
          const main = existing[0]!;
          if (main.commands.length > 0) {
            main.prerequisites.unshift(...targetRule.prerequisites);
            main.orderOnly.unshift(...targetRule.orderOnly);
          } else {
            main.prerequisites.push(...targetRule.prerequisites);
            main.orderOnly.push(...targetRule.orderOnly);
          }
          if (targetRule.staticDeps) (main.staticDeps ??= []).unshift(...targetRule.staticDeps);
          else if (main.staticDeps && targetRule.prerequisites.length > 0) main.staticDeps.reverse();
          if (targetRule.commands.length > 0 || (rule.targets.length > 1 && hasFollowingRecipe)) main.commands = targetRule.commands;
          else if (main.commands.length > 0) main.pendingOverride = true;
          this.currentRule = main;
        } else {
          existing.push(targetRule);
          this.rules.set(target, existing);
          this.currentRule = targetRule;
        }
      }
    }
  }

  run(): number {
    if (this.options.syntaxCheck) return 0;
    const targets = this.options.targets.length > 0 ? this.options.targets : this.defaultTarget ? [this.defaultTarget] : [];
    if (targets.length === 0) throw new Error("*** No targets.");
    let status = 0;
    for (const target of targets) {
      try {
        const didWork = this.build(target);
        if (!didWork) console.log(`Nothing to be done for '${target}'.`);
      }
      catch (error) {
        status = 1;
        if (!this.options.keepGoing) throw error;
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    return status;
  }

  private validateRules(): void {
    const report = (location: Location, message: string, error: boolean): void => {
      const kind = error ? "***" : "warning:";
      const text = `${location.file}:${location.line}: ${kind} ${message}`;
      if (error) throw new Error(text);
      console.error(text);
    };
    if (this.options.topLevelPhony) {
      for (const rules of this.rules.values()) for (const rule of rules) for (const dependency of rule.prerequisites) {
        if (!this.rules.has(dependency) && !existsSync(dependency)) this.phony.add(dependency);
      }
    }
    for (const target of [...this.phony]) {
      for (const entry of this.targetVariables.get(target) ?? []) {
        if (entry.name === ".KATI_IMPLICIT_OUTPUTS") for (const output of words(entry.variable.value)) this.phony.add(output);
      }
    }
    if (this.options.warnPhonyLooksReal || this.options.werrorPhonyLooksReal) {
      for (const target of this.phony) if (target.includes("/")) {
        let location = this.rules.get(target)?.[0]?.commands[0]?.location;
        if (!location) {
          for (const [owner, entries] of this.targetVariables) if (entries.some((entry) => entry.name === ".KATI_IMPLICIT_OUTPUTS" && [...words(entry.variable.value)].includes(target))) {
            location = this.rules.get(owner)?.[0]?.commands[0]?.location;
          }
        }
        report(location ?? this.phonyLocations.get(target)!, `PHONY target '${target}' looks like a real file (contains a '/')`, !!this.options.werrorPhonyLooksReal);
      }
    }
    if (this.options.warnRealToPhony || this.options.werrorRealToPhony) {
      for (const [target, rules] of this.rules) {
        if (this.phony.has(target)) continue;
        for (const rule of rules) for (const dependency of rule.prerequisites) if (this.phony.has(dependency) || (this.options.topLevelPhony && !this.rules.has(dependency))) {
          report(rule.commands[0]?.location ?? rule.location, `real file '${target}' depends on PHONY target '${dependency}'`, !!this.options.werrorRealToPhony);
        }
      }
    }
    if (this.options.warnRealNoCommandsOrDeps || this.options.werrorRealNoCommandsOrDeps) {
      for (const [target, rules] of this.rules) {
        const rule = rules[0]!;
        if (!this.phony.has(target) && target.includes("/") && rule.commands.length === 0 && rule.prerequisites.length === 0) {
          report(rule.location, `target '${target}' has no commands or deps that could create it`, !!this.options.werrorRealNoCommandsOrDeps);
        }
      }
    }
    if (this.options.warnRealNoCommands || this.options.werrorRealNoCommands) {
      for (const [target, rules] of this.rules) {
        const rule = rules[0]!;
        if (this.phony.has(target) || !target.includes("/") || rule.commands.length > 0 || rule.prerequisites.length === 0) continue;
        const declaredOutput = rule.prerequisites.some((dependency) =>
          (this.targetVariables.get(dependency) ?? []).some((entry) => entry.name === ".KATI_IMPLICIT_OUTPUTS" && [...words(entry.variable.value)].includes(target)));
        if (!declaredOutput) report(rule.location, `target '${target}' has no commands. Should '${rule.prerequisites[0]}' be using .KATI_IMPLICIT_OUTPUTS?`, !!this.options.werrorRealNoCommands);
      }
    }
    if ((this.options.writable?.length ?? 0) > 0) {
      for (const [target, rules] of this.rules) {
        if (this.phony.has(target) || this.options.writable!.some((prefix) => target.startsWith(prefix)) || existsSync(target)) continue;
        const rule = rules[0]!;
        if (rule.commands.length > 0 || rule.prerequisites.length > 0) report(rule.commands[0]?.location ?? rule.location, `writing to readonly directory: '${target}'`, !!this.options.werrorWritable);
      }
    }
  }

  targetNames(): string[] {
    return [...this.rules.keys()].filter((target) => !target.startsWith(".") && target !== "");
  }

  defaultTargetName(): string | undefined {
    return this.defaultTarget;
  }

  ninjaGraph(roots: readonly string[]): NinjaGraphNode[] {
    const nodes: NinjaGraphNode[] = [];
    const seen = new Set<string>();
    const implicitOwner = (target: string): string | undefined => {
      for (const [owner, entries] of this.targetVariables) for (const entry of entries) {
        if (entry.name !== ".KATI_IMPLICIT_OUTPUTS") continue;
        const value = entry.variable.flavor === "simple" ? entry.variable.value : this.evaluator.expand(entry.variable.value);
        if ([...words(value)].map(trimLeadingCurdir).includes(target)) return owner;
      }
      return undefined;
    };
    const visit = (requestedTarget: string): void => {
      const target = implicitOwner(requestedTarget) ?? requestedTarget;
      if (seen.has(target) || seen.has(requestedTarget)) return;
      seen.add(target);
      seen.add(requestedTarget);
      const scopes: Map<string, Variable | undefined>[] = [this.applyTargetVariables(target)];
      const implicitOutputs: string[] = [];
      for (const entry of this.targetVariables.get(target) ?? []) {
        if (entry.name !== ".KATI_IMPLICIT_OUTPUTS") continue;
        const value = entry.variable.flavor === "simple" ? entry.variable.value : this.evaluator.expand(entry.variable.value);
        implicitOutputs.push(...[...words(value)].map(trimLeadingCurdir));
      }
      for (const output of implicitOutputs) {
        seen.add(output);
        scopes.push(this.applyTargetVariables(output));
      }
      const found = this.findRule(target);
      if (!found) {
        if (this.phony.has(target)) nodes.push({
          target, prerequisites: [], orderOnly: [], validations: [], implicitOutputs: [], phony: true, commands: [],
        });
        for (const scope of scopes.reverse()) for (const [name, variable] of scope) this.evaluator.restoreVariable(name, variable);
        return;
      }
      try {
        const prerequisites = found.rule.prerequisites.map((value) => value.replaceAll("%", found.stem));
        const orderOnly = found.rule.orderOnly.map((value) => value.replaceAll("%", found.stem));
        for (const output of implicitOutputs) {
          const outputRule = this.findRule(output);
          if (!outputRule) continue;
          for (const value of outputRule.rule.prerequisites) {
            const dependency = value.replaceAll("%", outputRule.stem);
            if (!prerequisites.includes(dependency)) prerequisites.push(dependency);
          }
          for (const value of outputRule.rule.orderOnly) {
            const dependency = value.replaceAll("%", outputRule.stem);
            if (!orderOnly.includes(dependency)) orderOnly.push(dependency);
          }
        }
        const validations = [...words(this.evaluator.expandVariable(".KATI_VALIDATIONS"))].map(trimLeadingCurdir);
        const pool = this.evaluator.expandVariable(".KATI_NINJA_POOL");
        const doubleRules = (this.rules.get(target) ?? []).filter((rule) => rule.doubleColon);
        const recipe = doubleRules.length > 1 ? doubleRules.flatMap((rule) => rule.commands) : found.rule.commands;
        const commands = this.expandNinjaCommands(recipe, target, prerequisites, orderOnly, found.stem);
        nodes.push({
          target, prerequisites, orderOnly, validations, implicitOutputs,
          phony: this.phony.has(target), commands, pool,
        });
        for (const dependency of [...prerequisites, ...orderOnly, ...validations]) visit(dependency);
      } finally {
        for (const scope of scopes.reverse()) for (const [name, variable] of scope) this.evaluator.restoreVariable(name, variable);
      }
    };
    for (const root of roots) visit(root);
    return nodes;
  }

  private expandNinjaCommands(
    commands: readonly Command[], target: string, prerequisites: readonly string[], orderOnly: readonly string[], stem: string,
  ): NinjaCommand[] {
    const automatic: Record<string, string> = {
      "@": target, "<": prerequisites[0] ?? "", "^": [...new Set(prerequisites)].join(" "),
      "+": prerequisites.join(" "), "?": "__TKATI_QUESTION__", "|": orderOnly.join(" "), "*": stem, "%": "",
    };
    const saved = new Map<string, Variable | undefined>();
    for (const [name, value] of Object.entries(automatic)) {
      saved.set(name, this.evaluator.getVariable(name));
      this.evaluator.setVariable(name, { value, flavor: "simple", origin: "automatic" }, true);
    }
    const delayedStart = this.evaluator.delayedNinjaCommands.length;
    const previousGeneratingNinja = this.evaluator.generatingNinja;
    try {
      this.evaluator.inRecipe = true;
      this.evaluator.generatingNinja = true;
      const expandedCommands = commands.flatMap((command) => {
        this.evaluator.currentFile = command.location.file;
        this.evaluator.currentLine = command.location.line;
        const expanded = this.evaluator.expand(command.text);
        const globalPrefix = /^[@+\-]+/.exec(expanded)?.[0] ?? "";
        const lines: string[] = [];
        let start = 0;
        for (let index = 0; index < expanded.length; index++) {
          if (expanded[index] === "\n" && (index === 0 || expanded[index - 1] !== "\\")) {
            lines.push(start === 0 ? expanded.slice(start, index) : globalPrefix + trimLeftSpace(expanded.slice(start, index)));
            start = index + 1;
          }
        }
        lines.push(start === 0 ? expanded.slice(start) : globalPrefix + trimLeftSpace(expanded.slice(start)));
        return lines.flatMap((line): NinjaCommand[] => {
          let text = trimLeftSpace(line);
          if (trimSpace(text) === "") return [];
          let echo = !this.options.silent;
          let ignoreError = false;
          while (text[0] === "@" || text[0] === "-" || text[0] === "+") {
            if (text[0] === "@") echo = false;
            if (text[0] === "-") ignoreError = true;
            text = text.slice(1);
          }
          return [{ text, echo, ignoreError }];
        });
      });
      const delayed = this.evaluator.delayedNinjaCommands.splice(delayedStart).map((text): NinjaCommand => ({
        text, echo: false, ignoreError: false,
      }));
      return [...delayed, ...expandedCommands];
    } finally {
      this.evaluator.inRecipe = false;
      this.evaluator.generatingNinja = previousGeneratingNinja;
      for (const [name, variable] of saved) this.evaluator.restoreVariable(name, variable);
    }
  }

  ninjaEnvironment(): string[] {
    const result: string[] = [];
    for (const [name, exported] of this.exports) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (exported) result.push(`export ${name}=${shellAssignmentQuote(this.evaluator.expandVariable(name))}`);
      else result.push(`unset ${name}`);
    }
    return result;
  }

  private findRule(target: string): { rule: Rule; stem: string } | undefined {
    const explicit = this.rules.get(target)?.[0];
    if (explicit) {
      const staticPrerequisites: string[] = [];
      const staticOrderOnly: string[] = [];
      let staticStem = "";
      for (const entry of explicit.staticDeps ?? []) {
        const pattern = new Pattern(entry.targetPattern);
        if (!pattern.matches(target)) continue;
        staticStem = pattern.stem(target);
        staticPrerequisites.push(...entry.prerequisites.map((value) => value.replaceAll("%", staticStem)));
        staticOrderOnly.push(...entry.orderOnly.map((value) => value.replaceAll("%", staticStem)));
      }
      const resolved = explicit.staticDeps ? {
        ...explicit,
        prerequisites: [...explicit.prerequisites, ...staticPrerequisites],
        orderOnly: [...explicit.orderOnly, ...staticOrderOnly],
      } : explicit;
      if (explicit.commands.length > 0 || explicit.staticDeps) return { rule: resolved, stem: staticStem };
      const implicit = this.findPatternRule(target);
      if (implicit) {
        return {
          stem: implicit.stem,
          rule: {
            ...implicit.rule,
            prerequisites: [...implicit.rule.prerequisites, ...resolved.prerequisites],
            orderOnly: [...implicit.rule.orderOnly, ...resolved.orderOnly],
          },
        };
      }
      return { rule: resolved, stem: staticStem };
    }
    const implicit = this.findPatternRule(target);
    if (implicit) return implicit;
    const fallback = this.rules.get(".DEFAULT")?.[0];
    if (fallback) return { rule: fallback, stem: target };
    return undefined;
  }

  private findPatternRule(target: string): { rule: Rule; stem: string } | undefined {
    const candidates: { rule: Rule; stem: string; order: number }[] = [];
    let order = 0;
    for (const rule of this.patternRules) {
      for (const candidate of rule.targets) {
        const pattern = new Pattern(candidate);
        if (pattern.matches(target)) {
          const stem = pattern.stem(target);
          const viable = rule.prerequisites.every((value) => this.canMake(value.replaceAll("%", stem), new Set([target])));
          if (viable) candidates.push({ rule, stem, order });
        }
        order++;
      }
    }
    candidates.sort((left, right) =>
      Number(left.rule.suffixRule) - Number(right.rule.suffixRule) ||
      left.stem.length - right.stem.length || left.order - right.order);
    const found = candidates[0];
    return found ? { rule: found.rule, stem: found.stem } : undefined;
  }

  private canMake(target: string, seen: Set<string>): boolean {
    if (existsSync(target) || this.rules.has(target)) return true;
    if (seen.has(target)) return false;
    seen.add(target);
    for (const rule of this.patternRules) {
      for (const candidate of rule.targets) {
        const pattern = new Pattern(candidate);
        if (!pattern.matches(target)) continue;
        const stem = pattern.stem(target);
        if (rule.prerequisites.every((value) => this.canMake(value.replaceAll("%", stem), new Set(seen)))) return true;
      }
    }
    return false;
  }

  private build(target: string, neededBy?: string): boolean {
    if (this.built.has(target)) return false;
    if (this.building.has(target)) {
      console.error(`Circular ${neededBy ?? target} <- ${target} dependency dropped.`);
      return false;
    }
    this.building.add(target);
    const scoped = this.applyTargetVariables(target);
    try {
      const doubleRules = (this.rules.get(target) ?? []).filter((rule) => rule.doubleColon);
      if (doubleRules.length > 1) {
        let work = false;
        for (const rule of doubleRules) {
          const prerequisites = rule.prerequisites;
          for (const prerequisite of [...prerequisites, ...rule.orderOnly]) {
            work = this.build(prerequisite, target) || work;
          }
          const needed = rule.prerequisites.length === 0 || this.phony.has(target) || !existsSync(target) ||
            rule.prerequisites.some((value) => existsSync(value) && (!existsSync(target) || statSync(value).mtimeMs > statSync(target).mtimeMs));
          if (needed) {
            this.execute(rule.commands, target, prerequisites, rule.orderOnly, "");
            work = work || rule.commands.length > 0;
          }
        }
        this.built.add(target);
        return work;
      }
      const found = this.findRule(target);
      if (!found) {
        if (this.phony.has(target) || (this.options.topLevelPhony && !this.rules.has(target))) { this.built.add(target); return false; }
        for (const [owner, entries] of this.targetVariables) {
          if (entries.some((entry) => entry.name === ".KATI_IMPLICIT_OUTPUTS" && [...words(entry.variable.value)].includes(target))) {
            const work = this.build(owner, neededBy);
            this.built.add(target);
            return work;
          }
        }
        const vpath = [...words(this.evaluator.expandVariable("VPATH"))];
        if (vpath.some((directory) => existsSync(`${directory}/${target}`))) {
          this.built.add(target);
          return false;
        }
        if (existsSync(target)) { this.built.add(target); return false; }
        throw new Error(`*** No rule to make target '${target}'${neededBy ? `, needed by '${neededBy}'` : ""}.`);
      }
      const { rule, stem } = found;
      const prerequisites = rule.prerequisites.map((value) => value.replaceAll("%", stem));
      const orderOnly = rule.orderOnly.map((value) => value.replaceAll("%", stem));
      let dependencyWork = false;
      for (const prerequisite of [...prerequisites, ...orderOnly]) {
        dependencyWork = this.build(prerequisite, target) || dependencyWork;
      }
      let needed = this.options.alwaysMake || this.phony.has(target) || !existsSync(target);
      if (!needed && existsSync(target)) {
        const targetTime = statSync(target).mtimeMs;
        needed = prerequisites.some((value) => existsSync(value) && statSync(value).mtimeMs > targetTime);
      }
      if (needed) this.execute(rule.commands, target, prerequisites, orderOnly, stem);
      if (needed && rule.targets.length > 1 && rule.targets.some((value) => value.includes("%"))) {
        for (const output of rule.targets) this.built.add(output.replaceAll("%", stem));
      }
      this.built.add(target);
      return dependencyWork || (needed && rule.commands.length > 0);
    } finally {
      for (const [name, variable] of scoped) this.evaluator.restoreVariable(name, variable);
      this.building.delete(target);
    }
  }

  private applyTargetVariables(target: string): Map<string, Variable | undefined> {
    const assignments: TargetVariable[] = [];
    for (const [pattern, variables] of this.targetVariables) {
      if (pattern.includes("%") && new Pattern(pattern).matches(target)) assignments.push(...variables);
    }
    assignments.push(...(this.targetVariables.get(target) ?? []));
    const saved = new Map<string, Variable | undefined>();
    for (const assignment of assignments) {
      if (!saved.has(assignment.name)) saved.set(assignment.name, this.evaluator.getVariable(assignment.name));
      if (assignment.appendGlobal) {
        const base = this.evaluator.expandVariable(assignment.name);
        this.evaluator.setVariable(assignment.name, {
          ...assignment.variable,
          value: base + (base === "" ? "" : " ") + assignment.variable.value,
        }, true);
      } else {
        this.evaluator.setVariable(assignment.name, { ...assignment.variable }, true);
      }
    }
    return saved;
  }

  private execute(commands: readonly Command[], target: string, prerequisites: readonly string[], orderOnly: readonly string[], stem: string): void {
    const automatic: Record<string, string> = {
      "@": target,
      "<": prerequisites[0] ?? "",
      "^": [...new Set(prerequisites)].join(" "),
      "+": prerequisites.join(" "),
      "?": (!existsSync(target) ? prerequisites : prerequisites.filter((value) => existsSync(value) && statSync(value).mtimeMs > statSync(target).mtimeMs)).join(" "),
      "|": orderOnly.join(" "),
      "*": stem,
      "%": "",
    };
    const saved = new Map<string, Variable | undefined>();
    for (const [name, value] of Object.entries(automatic)) {
      saved.set(name, this.evaluator.getVariable(name));
      this.evaluator.setVariable(name, { value, flavor: "simple", origin: "automatic" }, true);
    }
    try {
      this.evaluator.inRecipe = true;
      const expandedCommands = commands.flatMap((command) => {
        this.evaluator.currentFile = command.location.file;
        this.evaluator.currentLine = command.location.line;
        const expanded = this.evaluator.expand(command.text);
        const recipePrefix = /^[@+\-]+/.exec(expanded)?.[0] ?? "";
        const result: { command: Command; text: string }[] = [];
        let start = 0;
        for (let index = 0; index < expanded.length; index++) {
          if (expanded[index] === "\n" && (index === 0 || expanded[index - 1] !== "\\")) {
            const part = expanded.slice(start, index);
            result.push({ command, text: start === 0 ? part : recipePrefix + trimLeftSpace(part) });
            start = index + 1;
          }
        }
        const last = expanded.slice(start);
        result.push({ command, text: start === 0 ? last : recipePrefix + trimLeftSpace(last) });
        return result;
      });
      for (const { command, text: expandedText } of expandedCommands) {
        let text = trimLeftSpace(expandedText);
        if (trimSpace(text) === "") continue;
        let silent = this.options.silent;
        let ignore = false;
        while (text[0] === "@" || text[0] === "-" || text[0] === "+") {
          if (text[0] === "@") silent = true;
          if (text[0] === "-") ignore = true;
          text = text.slice(1);
        }
        if (!silent || this.options.dryRun) writeSync(1, text + "\n");
        if (this.options.dryRun) continue;
        const environment = { ...process.env };
        for (const [name, exported] of this.exports) {
          if (exported) environment[name] = this.evaluator.expandVariable(name);
          else delete environment[name];
        }
        const result = spawnSync(this.evaluator.expandVariable("SHELL") || "/bin/sh", [this.evaluator.posix ? "-ec" : "-c", text], {
          env: environment, stdio: "inherit",
        });
        if ((result.status ?? 127) !== 0 && ignore && process.env.TKATI_NINJA_CHILD !== "1") console.error(`[${target}] Error ${result.status ?? 127} (ignored)`);
        if ((result.status ?? 127) !== 0 && !ignore) {
          if (process.env.TKATI_NINJA_CHILD === "1") throw new Error("__silent__");
          throw new Error(`*** [${target}] Error ${result.status ?? 127}`);
        }
      }
    } finally {
      this.evaluator.inRecipe = false;
      for (const [name, variable] of saved) this.evaluator.restoreVariable(name, variable);
    }
  }
}

function internName(name: string): string {
  // Keep this helper visually explicit: variable names are an intern boundary,
  // while variable values stay as native (potentially rope-backed) strings.
  return name;
}
