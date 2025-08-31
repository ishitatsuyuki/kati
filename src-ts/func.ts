import * as fs from 'fs';
import {execSync} from 'child_process';
import {Pattern, splitSpace, StrUtil} from './strutil';
import {FileUtil} from './fileutil';
import {Value} from './ast';
import {Evaluator} from './evaluator';
import {SimpleVar, VarOrigin} from './var';

// Function signature type
type FuncImpl = (args: Value[], ev: Evaluator) => string;

// Function info structure
export interface FuncInfo {
  name: string;
  func: FuncImpl;
  arity: number;
  minArity: number;
  // For all parameters
  trimSpace: boolean;
  // Only for the first parameter
  trimRightFirst: boolean;
}

// Helper function to strip shell comments
function stripShellComment(cmd: string): string {
  if (!cmd.includes('#')) {
    return cmd;
  }

  let result = '';
  let prevBackslash = false;
  let prevChar = ' '; // Set space as initial value so leading comment will be stripped
  let quote = '';
  const done = false;

  for (let i = 0; i < cmd.length && !done; i++) {
    const char = cmd[i];

    switch (char) {
      case '#':
        if (!quote && /\s/.test(prevChar)) {
          // Skip to end of line
          while (i + 1 < cmd.length && cmd[i] !== '\n') {
            i++;
          }
          break;
        }
        result += char;
        break;

      case "'":
      case '"':
      case '`':
        if (quote) {
          if (quote === char) {
            quote = '';
          }
        } else if (!prevBackslash) {
          quote = char;
        }
        result += char;
        break;

      case '\\':
        result += '\\';
        break;

      default:
        result += char;
    }

    prevBackslash = char === '\\' ? !prevBackslash : false;
    prevChar = char;
  }

  return result;
}

// Helper function to get numeric value
function getNumericValueForFunc(buf: string): number {
  const s = StrUtil.trimLeftSpace(buf);
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0) {
    return -1;
  }
  return n;
}

// Helper function to get file extension
function getExt(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const lastSlash = Math.max(
    filename.lastIndexOf('/'),
    filename.lastIndexOf('\\'),
  );

  if (lastDot > lastSlash && lastDot < filename.length - 1) {
    return filename.substring(lastDot);
  }
  return '';
}

// Helper function to strip file extension
function stripExt(filename: string): string {
  const ext = getExt(filename);
  if (ext) {
    return filename.substring(0, filename.length - ext.length);
  }
  return filename;
}

// Helper function to get directory name
function dirname(filepath: string): string {
  if (filepath === '/') return '/';
  const lastSlash = Math.max(
    filepath.lastIndexOf('/'),
    filepath.lastIndexOf('\\'),
  );
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return '/';
  return filepath.substring(0, lastSlash);
}

// Helper function to get basename
function basename(filepath: string): string {
  if (filepath === '/') return '/';
  const lastSlash = Math.max(
    filepath.lastIndexOf('/'),
    filepath.lastIndexOf('\\'),
  );
  return filepath.substring(lastSlash + 1);
}

// Helper function to make absolute path
function absPath(path: string): string {
  return FileUtil.resolvePath(path);
}

// String manipulation functions
function patsubstFunc(args: Value[], ev: Evaluator): string {
  const patStr = args[0].eval(ev);
  const repl = args[1].eval(ev);
  const str = args[2].eval(ev);

  const pat = new Pattern(patStr);
  const words = splitSpace(str);
  const result: string[] = [];

  for (const tok of words) {
    const substituted = pat.appendSubst(tok, repl);
    if (substituted.length > 0) {
      result.push(substituted);
    }
  }

  return result.join(' ');
}

function stripFunc(args: Value[], ev: Evaluator): string {
  const str = args[0].eval(ev);
  const words = splitSpace(str);
  const result: string[] = [];

  for (const tok of words) {
    if (tok.length > 0) {
      result.push(tok);
    }
  }

  return result.join(' ');
}

function substFunc(args: Value[], ev: Evaluator): string {
  const pat = args[0].eval(ev);
  const repl = args[1].eval(ev);
  const str = args[2].eval(ev);

  if (!pat) {
    return str + repl;
  }

  return str.split(pat).join(repl);
}

function findstringFunc(args: Value[], ev: Evaluator): string {
  const find = args[0].eval(ev);
  const inStr = args[1].eval(ev);

  return inStr.includes(find) ? find : '';
}

function filterFunc(args: Value[], ev: Evaluator): string {
  const patBuf = args[0].eval(ev);
  const text = args[1].eval(ev);

  const patterns = splitSpace(patBuf).map(pat => new Pattern(pat));
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    for (const pat of patterns) {
      if (pat.match(tok)) {
        result.push(tok);
        break;
      }
    }
  }

  return result.join(' ');
}

function filterOutFunc(args: Value[], ev: Evaluator): string {
  const patBuf = args[0].eval(ev);
  const text = args[1].eval(ev);

  const patterns = splitSpace(patBuf).map(pat => new Pattern(pat));
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    let matched = false;
    for (const pat of patterns) {
      if (pat.match(tok)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      result.push(tok);
    }
  }

  return result.join(' ');
}

function sortFunc(args: Value[], ev: Evaluator): string {
  const list = args[0].eval(ev);
  const words = splitSpace(list);

  // Sort and remove duplicates
  words.sort();
  const result: string[] = [];
  let prev = '';

  for (const tok of words) {
    if (prev !== tok) {
      result.push(tok);
      prev = tok;
    }
  }

  return result.join(' ');
}

// Word functions
function wordFunc(args: Value[], ev: Evaluator): string {
  const nStr = args[0].eval(ev);
  const n = getNumericValueForFunc(nStr);

  if (n < 0) {
    throw new Error(
      `*** non-numeric first argument to 'word' function: '${nStr}'.`,
    );
  }
  if (n === 0) {
    throw new Error(
      "*** first argument to 'word' function must be greater than 0.",
    );
  }

  const text = args[1].eval(ev);
  const words = splitSpace(text);

  if (n <= words.length) {
    return words[n - 1]; // 1-based indexing
  }

  return '';
}

function wordlistFunc(args: Value[], ev: Evaluator): string {
  const sStr = args[0].eval(ev);
  const si = getNumericValueForFunc(sStr);

  if (si < 0) {
    throw new Error(
      `*** non-numeric first argument to 'wordlist' function: '${sStr}'.`,
    );
  }
  if (si === 0) {
    throw new Error(
      `*** invalid first argument to 'wordlist' function: ${sStr}`,
    );
  }

  const eStr = args[1].eval(ev);
  const ei = getNumericValueForFunc(eStr);

  if (ei < 0) {
    throw new Error(
      `*** non-numeric second argument to 'wordlist' function: '${eStr}'.`,
    );
  }

  const text = args[2].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (let i = si - 1; i < Math.min(ei, words.length); i++) {
    if (i >= 0) {
      result.push(words[i]);
    }
  }

  return result.join(' ');
}

function wordsFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  return words.length.toString();
}

function firstwordFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  return words.length > 0 ? words[0] : '';
}

function lastwordFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  return words.length > 0 ? words[words.length - 1] : '';
}

function joinFunc(args: Value[], ev: Evaluator): string {
  const list1 = args[0].eval(ev);
  const list2 = args[1].eval(ev);

  const words1 = splitSpace(list1);
  const words2 = splitSpace(list2);
  const result: string[] = [];

  const maxLen = Math.max(words1.length, words2.length);

  for (let i = 0; i < maxLen; i++) {
    if (i < words1.length && i < words2.length) {
      result.push(words1[i] + words2[i]);
    } else if (i < words1.length) {
      result.push(words1[i]);
    } else if (i < words2.length) {
      result.push(words2[i]);
    }
  }

  return result.join(' ');
}

// File system functions
function wildcardFunc(args: Value[], ev: Evaluator): string {
  const pat = args[0].eval(ev);
  const patterns = splitSpace(pat);
  const result: string[] = [];

  for (const pattern of patterns) {
    try {
      const files = fs.globSync(pattern);
      for (const file of files) {
        result.push(file);
      }
    } catch (e) {
      // Ignore errors, just like GNU make
    }
  }

  return result.join(' ');
}

function dirFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    result.push(dirname(tok) + '/');
  }

  return result.join(' ');
}

function notdirFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    if (tok === '/') {
      // Skip empty entries
    } else {
      result.push(basename(tok));
    }
  }

  return result.join(' ');
}

function suffixFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    const suf = getExt(tok);
    if (suf) {
      result.push(suf);
    }
  }

  return result.join(' ');
}

function basenameFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    result.push(stripExt(tok));
  }

  return result.join(' ');
}

function addsuffixFunc(args: Value[], ev: Evaluator): string {
  const suf = args[0].eval(ev);
  const text = args[1].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    result.push(tok + suf);
  }

  return result.join(' ');
}

function addprefixFunc(args: Value[], ev: Evaluator): string {
  const pre = args[0].eval(ev);
  const text = args[1].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    result.push(pre + tok);
  }

  return result.join(' ');
}

function realpathFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);

  if (ev.avoid_io()) {
    // TODO: Return shell command for ninja mode
    return `$(realpath ${text})`;
  }

  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    try {
      const resolved = fs.realpathSync(tok);
      result.push(resolved);
    } catch (e) {
      // Ignore errors
    }
  }

  return result.join(' ');
}

function abspathFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);
  const words = splitSpace(text);
  const result: string[] = [];

  for (const tok of words) {
    result.push(absPath(tok));
  }

  return result.join(' ');
}

// Conditional and logical functions
function ifFunc(args: Value[], ev: Evaluator): string {
  const cond = args[0].eval(ev);

  if (!cond) {
    return args.length > 2 ? args[2].eval(ev) : '';
  } else {
    return args[1].eval(ev);
  }
}

function andFunc(args: Value[], ev: Evaluator): string {
  let cond = '';

  for (const arg of args) {
    cond = arg.eval(ev);
    if (!cond) {
      return '';
    }
  }

  return cond;
}

function orFunc(args: Value[], ev: Evaluator): string {
  for (const arg of args) {
    const cond = arg.eval(ev);
    if (cond) {
      return cond;
    }
  }

  return '';
}

// Advanced functions
function valueFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev);
  const variable = ev.lookupVar(varName);
  console.warn('value is not implemented');
  return variable ? variable.eval(ev) : '';
}

function evalFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev);

  if (ev.avoid_io()) {
    console.warn(`*warning*: $(eval) in a recipe is not recommended: ${text}`);
  }

  // TODO: Implement actual evaluation of make statements
  // For now, return empty string
  return '';
}

function shellFunc(args: Value[], ev: Evaluator): string {
  let cmd = args[0].eval(ev);

  if (ev.avoid_io() && !hasNoIoInShellScript(cmd)) {
    if (ev.eval_depth() > 1) {
      throw new Error(
        "kati doesn't support passing results of $(shell) to other make constructs: " +
          cmd,
      );
    }

    cmd = stripShellComment(cmd);
    return `$(${cmd})`;
  }

  const shell = ev.getShell();
  const shellflag = ev.getShellFlag();

  try {
    const result = execSync(
      `${shell} ${shellflag} "${cmd.replace(/"/g, '\\"')}"`,
      {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']},
    );
    return result.replace(/\n$/, ''); // Remove trailing newline
  } catch (error: unknown) {
    return '';
  }
}

function callFunc(args: Value[], ev: Evaluator): string {
  const funcName = StrUtil.trimSpace(args[0].eval(ev));
  const func = ev.lookupVar(funcName);

  if (!func) {
    console.warn(`*warning*: undefined user function: ${funcName}`);
    return '';
  }

  // Use scoping mechanism to bind parameters $(0), $(1), $(2), etc.
  return ev.withScope(scope => {
    // Set $(0) to the function name
    scope.set(
      '0',
      new SimpleVar(funcName, VarOrigin.FILE, null, {
        filename: '<scope>',
        lineno: 0,
      }),
    );

    // Set $(1), $(2), etc. to the parameter values
    for (let i = 1; i < args.length; i++) {
      const paramValue = args[i].eval(ev);
      scope.set(
        i.toString(),
        new SimpleVar(paramValue, VarOrigin.FILE, null, {
          filename: '<scope>',
          lineno: 0,
        }),
      );
    }

    // Evaluate the function body (which is already a parsed Value)
    return func.eval(ev);
  });
}

function foreachFunc(args: Value[], ev: Evaluator): string {
  const varname = args[0].eval(ev);
  const list = args[1].eval(ev);
  const expr = args[2];

  const words = splitSpace(list);
  const result: string[] = [];

  for (const word of words) {
    // Use scoping mechanism to temporarily bind the loop variable
    const iterResult = ev.withScope(scope => {
      scope.set(
        varname,
        new SimpleVar(word, VarOrigin.FILE, null, {
          filename: '<scope>',
          lineno: 0,
        }),
      );
      return expr.eval(ev);
    });
    result.push(iterResult);
  }

  return result.join(' ');
}

// Information functions
function originFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev);
  const variable = ev.lookupVar(varName);

  // TODO: Implement proper origin tracking
  return variable ? 'file' : 'undefined';
}

function flavorFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev);
  const variable = ev.lookupVar(varName);

  // TODO: Implement proper flavor tracking (simple/recursive)
  return variable ? 'simple' : 'undefined';
}

function infoFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev);

  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands
    return '';
  }

  console.log(msg);
  return '';
}

function warningFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev);

  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands
    return '';
  }

  console.warn(`${ev.loc().filename}:${ev.loc().lineno}: ${msg}`);
  return '';
}

function errorFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev);

  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands
    return '';
  }

  throw new Error(`*** ${msg}.`);
}

// File I/O functions
function fileFunc(args: Value[], ev: Evaluator): string {
  if (ev.avoid_io()) {
    throw new Error('*** $(file ...) is not supported in rules.');
  }

  const arg = args[0].eval(ev);
  const filename = StrUtil.trimSpace(arg);

  if (filename.length <= 1) {
    throw new Error('*** Missing filename');
  }

  if (filename[0] === '<') {
    // Read file
    const file = StrUtil.trimLeftSpace(filename.substring(1));
    if (!file) {
      throw new Error('*** Missing filename');
    }
    if (args.length > 1) {
      throw new Error('*** invalid argument');
    }

    try {
      let content = fs.readFileSync(file, 'utf8');
      if (content.endsWith('\n')) {
        content = content.slice(0, -1);
      }
      return content;
    } catch (error) {
      return ''; // File doesn't exist, return empty
    }
  } else if (filename[0] === '>') {
    // Write file
    let append = false;
    let file = filename.substring(1);

    if (file[0] === '>') {
      append = true;
      file = file.substring(1);
    }

    file = StrUtil.trimLeftSpace(file);
    if (!file) {
      throw new Error('*** Missing filename');
    }

    let text = '';
    if (args.length > 1) {
      text = args[1].eval(ev);
      if (!text.endsWith('\n')) {
        text += '\n';
      }
    }

    try {
      if (append) {
        fs.appendFileSync(file, text);
      } else {
        fs.writeFileSync(file, text);
      }
    } catch (error) {
      throw new Error('*** file write failed.');
    }

    return '';
  } else {
    throw new Error(`*** Invalid file operation: ${filename}. Stop.`);
  }
}

// Helper function for shell script IO check
function hasNoIoInShellScript(cmd: string): boolean {
  if (!cmd) return true;
  if (cmd.startsWith('echo $((') && cmd.endsWith('))')) return true;
  return false;
}

// KATI extension functions (simplified implementations)
function deprecatedVarFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement variable deprecation tracking
  console.warn('KATI_deprecated_var not fully implemented');
  return '';
}

function obsoleteVarFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement variable obsolescence tracking
  console.warn('KATI_obsolete_var not fully implemented');
  return '';
}

function deprecateExportFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement export deprecation
  console.warn('KATI_deprecate_export not fully implemented');
  return '';
}

function obsoleteExportFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement export obsolescence
  console.warn('KATI_obsolete_export not fully implemented');
  return '';
}

function profileFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement makefile profiling
  console.warn('KATI_profile_makefile not fully implemented');
  return '';
}

function variableLocationFunc(args: Value[], ev: Evaluator): string {
  const arg = args[0].eval(ev);
  const vars = splitSpace(arg);
  const result: string[] = [];

  for (const varName of vars) {
    // TODO: Implement proper location tracking
    result.push('<unknown>:0');
  }

  return result.join(' ');
}

function extraFileDepsFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement extra file dependencies tracking
  console.warn('KATI_extra_file_deps not fully implemented');
  return '';
}

function shellFuncNoRerun(args: Value[], ev: Evaluator): string {
  // Similar to shell but doesn't store command result for rerun avoidance
  return shellFunc(args, ev);
}

function foreachWithSepFunc(args: Value[], ev: Evaluator): string {
  const varname = args[0].eval(ev);
  const separator = args[1].eval(ev);
  const list = args[2].eval(ev);
  const expr = args[3];

  // TODO: Implement with custom separator
  return foreachFunc([args[0], args[2], args[3]], ev);
}

function fileFuncNoRerun(args: Value[], ev: Evaluator): string {
  // Similar to file but doesn't track for rerun detection
  return fileFunc(args, ev);
}

function varVisibilityFunc(args: Value[], ev: Evaluator): string {
  // TODO: Implement variable visibility prefix checking
  console.warn('KATI_visibility_prefix not fully implemented');
  return '';
}

// Export the function registry
export const FUNC_INFO_MAP = new Map<string, FuncInfo>([
  // String manipulation functions
  [
    'patsubst',
    {
      name: 'patsubst',
      func: patsubstFunc,
      arity: 3,
      minArity: 3,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'strip',
    {
      name: 'strip',
      func: stripFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'subst',
    {
      name: 'subst',
      func: substFunc,
      arity: 3,
      minArity: 3,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'findstring',
    {
      name: 'findstring',
      func: findstringFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'filter',
    {
      name: 'filter',
      func: filterFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'filter-out',
    {
      name: 'filter-out',
      func: filterOutFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'sort',
    {
      name: 'sort',
      func: sortFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // Word functions
  [
    'word',
    {
      name: 'word',
      func: wordFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'wordlist',
    {
      name: 'wordlist',
      func: wordlistFunc,
      arity: 3,
      minArity: 3,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'words',
    {
      name: 'words',
      func: wordsFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'firstword',
    {
      name: 'firstword',
      func: firstwordFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'lastword',
    {
      name: 'lastword',
      func: lastwordFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // List functions
  [
    'join',
    {
      name: 'join',
      func: joinFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // File functions
  [
    'wildcard',
    {
      name: 'wildcard',
      func: wildcardFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'dir',
    {
      name: 'dir',
      func: dirFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'notdir',
    {
      name: 'notdir',
      func: notdirFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'suffix',
    {
      name: 'suffix',
      func: suffixFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'basename',
    {
      name: 'basename',
      func: basenameFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'addsuffix',
    {
      name: 'addsuffix',
      func: addsuffixFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'addprefix',
    {
      name: 'addprefix',
      func: addprefixFunc,
      arity: 2,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'realpath',
    {
      name: 'realpath',
      func: realpathFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'abspath',
    {
      name: 'abspath',
      func: abspathFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // Conditional functions
  [
    'if',
    {
      name: 'if',
      func: ifFunc,
      arity: 3,
      minArity: 2,
      trimSpace: false,
      trimRightFirst: true,
    },
  ],
  [
    'and',
    {
      name: 'and',
      func: andFunc,
      arity: 0,
      minArity: 0,
      trimSpace: true,
      trimRightFirst: false,
    },
  ],
  [
    'or',
    {
      name: 'or',
      func: orFunc,
      arity: 0,
      minArity: 0,
      trimSpace: true,
      trimRightFirst: false,
    },
  ],

  // Advanced functions
  [
    'value',
    {
      name: 'value',
      func: valueFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'eval',
    {
      name: 'eval',
      func: evalFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'shell',
    {
      name: 'shell',
      func: shellFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'call',
    {
      name: 'call',
      func: callFunc,
      arity: 0,
      minArity: 0,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'foreach',
    {
      name: 'foreach',
      func: foreachFunc,
      arity: 3,
      minArity: 3,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // Information functions
  [
    'origin',
    {
      name: 'origin',
      func: originFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'flavor',
    {
      name: 'flavor',
      func: flavorFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // I/O functions
  [
    'info',
    {
      name: 'info',
      func: infoFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'warning',
    {
      name: 'warning',
      func: warningFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'error',
    {
      name: 'error',
      func: errorFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'file',
    {
      name: 'file',
      func: fileFunc,
      arity: 2,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],

  // KATI extension functions
  [
    'KATI_deprecated_var',
    {
      name: 'KATI_deprecated_var',
      func: deprecatedVarFunc,
      arity: 2,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_obsolete_var',
    {
      name: 'KATI_obsolete_var',
      func: obsoleteVarFunc,
      arity: 2,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_deprecate_export',
    {
      name: 'KATI_deprecate_export',
      func: deprecateExportFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_obsolete_export',
    {
      name: 'KATI_obsolete_export',
      func: obsoleteExportFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_profile_makefile',
    {
      name: 'KATI_profile_makefile',
      func: profileFunc,
      arity: 0,
      minArity: 0,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_variable_location',
    {
      name: 'KATI_variable_location',
      func: variableLocationFunc,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_extra_file_deps',
    {
      name: 'KATI_extra_file_deps',
      func: extraFileDepsFunc,
      arity: 0,
      minArity: 0,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_shell_no_rerun',
    {
      name: 'KATI_shell_no_rerun',
      func: shellFuncNoRerun,
      arity: 1,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_foreach_sep',
    {
      name: 'KATI_foreach_sep',
      func: foreachWithSepFunc,
      arity: 4,
      minArity: 4,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_file_no_rerun',
    {
      name: 'KATI_file_no_rerun',
      func: fileFuncNoRerun,
      arity: 2,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
  [
    'KATI_visibility_prefix',
    {
      name: 'KATI_visibility_prefix',
      func: varVisibilityFunc,
      arity: 2,
      minArity: 1,
      trimSpace: false,
      trimRightFirst: false,
    },
  ],
]);

// Function to get function info by name
export function getFuncInfo(name: string): FuncInfo | null {
  return FUNC_INFO_MAP.get(name) || null;
}
