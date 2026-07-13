/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Kati intentionally uses native strings for all make text. V8 may represent
// repeated concatenations as cons strings (ropes), avoiding the explicit rope
// and StringPiece machinery used by the C++ implementation.
export type KatiString = string;

export const isSpace = (char: string): boolean =>
  char === " " || (char >= "\t" && char <= "\r");

export function skipUntil(value: string, pattern: string): number {
  for (let index = 0; index < value.length; index++) {
    if (pattern.includes(value[index]!)) return index;
  }
  return value.length;
}

export function trimLeftSpace(value: string): string {
  let index = 0;
  for (;;) {
    while (index < value.length && isSpace(value[index]!)) index++;
    if (value.startsWith("\\\r", index) || value.startsWith("\\\n", index)) index += 2;
    else break;
  }
  return value.slice(index);
}

export function trimRightSpace(value: string): string {
  let index = value.length;
  while (index > 0) {
    const char = value[index - 1]!;
    if (char === "\t" || char === "\x0b" || char === "\x0c" || char === " ") {
      index--;
    } else if (char === "\r" || char === "\n") {
      index--;
      if (index > 0 && value[index - 1] === "\\") index--;
    } else {
      break;
    }
  }
  return value.slice(0, index);
}

export function trimSpace(value: string): string {
  return trimRightSpace(trimLeftSpace(value));
}

export function* words(value: string): Generator<string> {
  let index = 0;
  while (index < value.length) {
    while (index < value.length && isSpace(value[index]!)) index++;
    const start = index;
    while (index < value.length && !isSpace(value[index]!)) index++;
    if (start !== index) yield value.slice(start, index);
  }
}

export function normalizeWords(value: string): string {
  return [...words(value)].join(" ");
}

export function concat(...parts: readonly string[]): string {
  let result = "";
  for (const part of parts) result += part;
  return result;
}

export function hasPathPrefix(value: string, prefix: string): boolean {
  return value.startsWith(prefix) &&
    (value.length === prefix.length || value[prefix.length] === "/");
}

export function hasWord(value: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const found = value.indexOf(word, from);
    if (found < 0) return false;
    const left = found === 0 || isSpace(value[found - 1]!);
    const end = found + word.length;
    const right = end === value.length || isSpace(value[end]!);
    if (left && right) return true;
    from = found + 1;
  }
}

export class Pattern {
  readonly pattern: string;
  readonly percentIndex: number;

  constructor(pattern: string) {
    this.pattern = pattern;
    this.percentIndex = pattern.indexOf("%");
  }

  matches(value: string): boolean {
    if (this.percentIndex < 0) return this.pattern === value;
    return value.startsWith(this.pattern.slice(0, this.percentIndex)) &&
      value.endsWith(this.pattern.slice(this.percentIndex + 1));
  }

  stem(value: string): string {
    if (!this.matches(value) || this.percentIndex < 0) return "";
    return value.slice(
      this.percentIndex,
      value.length - this.pattern.length + 1 + this.percentIndex,
    );
  }

  subst(value: string, replacement: string): string {
    if (this.percentIndex < 0) return value === this.pattern ? replacement : value;
    if (!this.matches(value)) return value;
    const replacementPercent = replacement.indexOf("%");
    if (replacementPercent < 0) return replacement;
    const stem = value.slice(
      this.percentIndex,
      this.percentIndex + value.length + 1 - this.pattern.length,
    );
    return replacement.slice(0, replacementPercent) + stem +
      replacement.slice(replacementPercent + 1);
  }

  substSuffix(value: string, replacement: string): string {
    if (this.percentIndex >= 0 && replacement.includes("%")) {
      return this.subst(value, replacement);
    }
    const base = value.endsWith(this.pattern)
      ? value.slice(0, value.length - this.pattern.length)
      : value;
    return base + replacement;
  }
}

export function dirname(value: string): string {
  const found = value.lastIndexOf("/");
  if (found < 0) return ".";
  if (found === 0) return "";
  return value.slice(0, found);
}

export function basename(value: string): string {
  const found = value.lastIndexOf("/");
  if (found <= 0) return value;
  return value.slice(found + 1);
}

export function getExt(value: string): string | undefined {
  const found = value.lastIndexOf(".");
  return found < 0 ? undefined : value.slice(found);
}

export function stripExt(value: string): string {
  const found = value.lastIndexOf(".");
  if (found < 0 || found < value.lastIndexOf("/")) return value;
  return value.slice(0, found);
}

export function normalizePath(value: string): string {
  if (value === "") return "";
  const absolute = value.startsWith("/");
  const result: string[] = [];
  for (const component of value.split("/")) {
    if (component === "" || component === "." || (component === ".." && absolute && result.length === 0)) {
      continue;
    }
    if (component === ".." && result.length > 0 && result[result.length - 1] !== "..") {
      result.pop();
    } else {
      result.push(component);
    }
  }
  if (absolute) return "/" + result.join("/");
  return result.join("/");
}

export function absPath(value: string): string {
  if (value.startsWith("/")) return normalizePath(value);
  return normalizePath(process.cwd() + (value === "" ? "" : "/" + value));
}

export function findOutsideParen(value: string, pattern: string): number | undefined {
  let previousBackslash = false;
  const close: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (pattern.includes(char) && close.length === 0 && !previousBackslash) return index;
    if (char === "(") close.push(")");
    else if (char === "{") close.push("}");
    else if ((char === ")" || char === "}") && close[close.length - 1] === char) close.pop();
    previousBackslash = char === "\\" && !previousBackslash;
  }
  return undefined;
}

export interface EndOfLine {
  line: string;
  rest: string;
  lineFeedCount: number;
}

export function findEndOfLine(value: string): EndOfLine {
  let lineFeedCount = 0;
  let end = 0;
  while (end < value.length) {
    const relative = skipUntil(value.slice(end), "\n\\\0");
    end += relative;
    if (end >= value.length || value[end] === "\0") break;
    if (value[end] === "\\") {
      if (value.startsWith("\\\r\n", end)) {
        end += 3;
        lineFeedCount++;
      } else if (value.startsWith("\\\n", end)) {
        end += 2;
        lineFeedCount++;
      } else if (value.startsWith("\\\\", end)) {
        end += 2;
      } else {
        end++;
      }
    } else {
      return {
        line: value.slice(0, end),
        rest: value.slice(end + 1),
        lineFeedCount: lineFeedCount + 1,
      };
    }
  }
  return { line: value.slice(0, end), rest: value.slice(end), lineFeedCount };
}

export function trimLeadingCurdir(value: string): string {
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

export function formatForCommandSubstitution(value: string): string {
  while (value.endsWith("\n")) value = value.slice(0, -1);
  return value.replaceAll("\n", " ");
}

export function concatDir(base: string, name: string): string {
  return normalizePath(base !== "" && !name.startsWith("/") ? base + "/" + name : name);
}

export function echoEscape(value: string): string {
  return value.replaceAll("\\", "\\\\\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function escapeShell(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if ('"$\\`'.includes(char)) {
      result += "\\";
      if (char === "$" && value[index + 1] === "$") result += value[index++]!;
    }
    result += char;
  }
  return result;
}

export function isInteger(value: string): boolean {
  return value !== "" && /^[0-9]+$/.test(value);
}
