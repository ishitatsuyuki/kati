/*
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A symbol remains a native string; Map only controls where interning occurs. */
export type Symbol = string;

const symbols = new Map<string, string>();

// Match the C++ and Rust fast path: every non-NUL single-byte symbol exists up
// front. JavaScript strings are immutable primitives, so returning the stored
// value gives callers a canonical native string without a wrapper allocation.
for (let byte = 1; byte <= 0xff; byte++) {
  const value = String.fromCharCode(byte);
  symbols.set(value, value);
}

export function intern(value: string): Symbol {
  const present = symbols.get(value);
  if (present !== undefined) return present;
  symbols.set(value, value);
  return value;
}

export function symbolCount(): number {
  // The native ports reserve index zero; retain that observable count.
  return symbols.size + 1;
}

export function allSymbols(): IterableIterator<Symbol> {
  return symbols.values();
}

export function resetSymbolsForTest(): void {
  for (const value of [...symbols.keys()]) {
    if (value.length !== 1 || value.charCodeAt(0) === 0 || value.charCodeAt(0) > 0xff) {
      symbols.delete(value);
    }
  }
}
