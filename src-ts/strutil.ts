export function hasPrefix(str: string, prefix: string): boolean {
  return (
    str.length >= prefix.length && str.substring(0, prefix.length) === prefix
  );
}

export function hasSuffix(str: string, suffix: string): boolean {
  return (
    str.length >= suffix.length &&
    str.substring(str.length - suffix.length) === suffix
  );
}

export function trimPrefix(str: string, prefix: string): string {
  if (
    str.length < prefix.length ||
    str.substring(0, prefix.length) !== prefix
  ) {
    return str;
  }
  return str.substring(prefix.length);
}

export function trimSuffix(str: string, suffix: string): string {
  if (
    str.length < suffix.length ||
    str.substring(str.length - suffix.length) !== suffix
  ) {
    return str;
  }
  return str.substring(0, str.length - suffix.length);
}

export function joinStrings(strings: string[], separator: string): string {
  return strings.join(separator);
}

export function splitSpace(str: string): string[] {
  // TODO: Check if filter hurts performance
  return (
    str
      /* eslint-disable-next-line no-control-regex */
      .split(/[\x09\x0a\x0b\x0c\x0d ]+/)
      .filter((word: string) => word.length > 0)
  );
}

export class StrUtil {
  static findOutsideParenImpl(
    s: string,
    predicate: (c: string) => boolean,
  ): number {
    let prevBackslash = false;
    const parenStack: string[] = [];

    for (let i = 0; i < s.length; i++) {
      const c = s[i];

      if (predicate(c) && parenStack.length === 0 && !prevBackslash) {
        return i;
      }

      switch (c) {
        case '(':
          parenStack.push(')');
          break;
        case '{':
          parenStack.push('}');
          break;
        case ')':
        case '}':
          if (
            parenStack.length > 0 &&
            c === parenStack[parenStack.length - 1]
          ) {
            parenStack.pop();
          }
          break;
      }

      prevBackslash = c === '\\' && !prevBackslash;
    }

    return -1; // string::npos equivalent
  }

  static findOutsideParen(s: string, c: string): number {
    return StrUtil.findOutsideParenImpl(s, (d: string) => d === c);
  }

  static findTwoOutsideParen(s: string, c1: string, c2: string): number {
    return StrUtil.findOutsideParenImpl(s, (d: string) => d === c1 || d === c2);
  }

  static findThreeOutsideParen(
    s: string,
    c1: string,
    c2: string,
    c3: string,
  ): number {
    return StrUtil.findOutsideParenImpl(
      s,
      (d: string) => d === c1 || d === c2 || d === c3,
    );
  }

  static trimLeftSpace(s: string): string {
    return s.replace(/^[ \t]+/, '');
  }

  static trimRightSpace(s: string): string {
    return s.replace(/[ \t]+$/, '');
  }

  static trimSpace(s: string): string {
    return s.replace(/^[ \t]+|[ \t]+$/g, '');
  }

  static removeComment(line: string): string {
    const i = StrUtil.findOutsideParen(line, '#');
    if (i === -1) {
      return line;
    }
    return line.substring(0, i);
  }
}

export class Pattern {
  private pat: string;
  private percentIndex: number;

  constructor(pat: string) {
    this.pat = pat;
    this.percentIndex = pat.indexOf('%');
  }

  match(str: string): boolean {
    if (this.percentIndex === -1) {
      return str === this.pat;
    }
    return this.matchImpl(str);
  }

  private matchImpl(str: string): boolean {
    return (
      hasPrefix(str, this.pat.substring(0, this.percentIndex)) &&
      hasSuffix(str, this.pat.substring(this.percentIndex + 1))
    );
  }

  stem(str: string): string {
    if (!this.match(str)) {
      return '';
    }
    const prefixLen = this.percentIndex;
    const suffixLen = this.pat.length - this.percentIndex - 1;
    return str.substring(prefixLen, str.length - suffixLen);
  }

  appendSubst(str: string, subst: string): string {
    if (this.percentIndex === -1) {
      if (str === this.pat) {
        return subst;
      } else {
        return str;
      }
    }

    if (this.matchImpl(str)) {
      const substPercentIndex = subst.indexOf('%');
      if (substPercentIndex === -1) {
        return subst;
      } else {
        const prefixLen = this.percentIndex;
        const suffixLen = this.pat.length - this.percentIndex - 1;
        const stem = str.substring(prefixLen, str.length - suffixLen);
        return (
          subst.substring(0, substPercentIndex) +
          stem +
          subst.substring(substPercentIndex + 1)
        );
      }
    }
    return str;
  }

  appendSubstRef(str: string, subst: string): string {
    if (this.percentIndex !== -1 && subst.indexOf('%') !== -1) {
      return this.appendSubst(str, subst);
    }
    const s = trimSuffix(str, this.pat);
    return s + subst;
  }

  // Additional method for buffer output
  appendSubstToBuffer(output: string, input: string, buf: string[]): void {
    const result = this.appendSubst(output, input);
    buf.push(result);
  }
}
