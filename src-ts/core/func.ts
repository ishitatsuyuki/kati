import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { splitSpace, Pattern, StrUtil } from '../utils/strutil.js';
import { FileUtil } from '../utils/fileutil.js';
import { Context, Value, Loc, Evaluator } from './ast.js';

// Function signature type
type FuncImpl = (args: Value[], ev: Evaluator) => string;

// Function info structure matching C++ FuncInfo
interface FuncInfo {
  name: string;
  func: FuncImpl;
  maxArgs: number;
  minArgs: number;
  hasVariadicArgs: boolean;
  trimRightFirstArg: boolean;
}


// Helper function to strip shell comments (similar to C++ StripShellComment)
function stripShellComment(cmd: string): string {
  if (!cmd.includes('#')) {
    return cmd;
  }

  let result = '';
  let prevBackslash = false;
  let prevChar = ' '; // Set space as initial value so leading comment will be stripped
  let quote = '';
  let done = false;

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

// Helper function to get numeric value (similar to C++ GetNumericValueForFunc)
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
  const lastSlash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  
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
  const lastSlash = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'));
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return '/';
  return filepath.substring(0, lastSlash);
}

// Helper function to get basename
function basename(filepath: string): string {
  if (filepath === '/') return '/';
  const lastSlash = Math.max(filepath.lastIndexOf('/'), filepath.lastIndexOf('\\'));
  return filepath.substring(lastSlash + 1);
}

// Helper function to make absolute path
function absPath(path: string): string {
  return FileUtil.resolvePath(path);
}

// String manipulation functions
function patsubstFunc(args: Value[], ev: Evaluator): string {
  const patStr = args[0].eval(ev as any);
  const repl = args[1].eval(ev as any);
  const str = args[2].eval(ev as any);
  
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
  const str = args[0].eval(ev as any);
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
  const pat = args[0].eval(ev as any);
  const repl = args[1].eval(ev as any);
  const str = args[2].eval(ev as any);
  
  if (!pat) {
    return str + repl;
  }
  
  return str.split(pat).join(repl);
}

function findstringFunc(args: Value[], ev: Evaluator): string {
  const find = args[0].eval(ev as any);
  const inStr = args[1].eval(ev as any);
  
  return inStr.includes(find) ? find : '';
}

function filterFunc(args: Value[], ev: Evaluator): string {
  const patBuf = args[0].eval(ev as any);
  const text = args[1].eval(ev as any);
  
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
  const patBuf = args[0].eval(ev as any);
  const text = args[1].eval(ev as any);
  
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
  const list = args[0].eval(ev as any);
  const words = splitSpace(list);
  
  // Sort and remove duplicates (stable sort like C++)
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
  const nStr = args[0].eval(ev as any);
  let n = getNumericValueForFunc(nStr);
  
  if (n < 0) {
    ev.error(`*** non-numeric first argument to 'word' function: '${nStr}'.`);
  }
  if (n === 0) {
    ev.error("*** first argument to 'word' function must be greater than 0.");
  }
  
  const text = args[1].eval(ev as any);
  const words = splitSpace(text);
  
  if (n <= words.length) {
    return words[n - 1]; // 1-based indexing
  }
  
  return '';
}

function wordlistFunc(args: Value[], ev: Evaluator): string {
  const sStr = args[0].eval(ev as any);
  const si = getNumericValueForFunc(sStr);
  
  if (si < 0) {
    ev.error(`*** non-numeric first argument to 'wordlist' function: '${sStr}'.`);
  }
  if (si === 0) {
    ev.error(`*** invalid first argument to 'wordlist' function: ${sStr}`);
  }
  
  const eStr = args[1].eval(ev as any);
  const ei = getNumericValueForFunc(eStr);
  
  if (ei < 0) {
    ev.error(`*** non-numeric second argument to 'wordlist' function: '${eStr}'.`);
  }
  
  const text = args[2].eval(ev as any);
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
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  return words.length.toString();
}

function firstwordFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  return words.length > 0 ? words[0] : '';
}

function lastwordFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  return words.length > 0 ? words[words.length - 1] : '';
}

function joinFunc(args: Value[], ev: Evaluator): string {
  const list1 = args[0].eval(ev as any);
  const list2 = args[1].eval(ev as any);
  
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
  const pat = args[0].eval(ev as any);
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
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  const result: string[] = [];
  
  for (const tok of words) {
    result.push(dirname(tok) + '/');
  }
  
  return result.join(' ');
}

function notdirFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
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
  const text = args[0].eval(ev as any);
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
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  const result: string[] = [];
  
  for (const tok of words) {
    result.push(stripExt(tok));
  }
  
  return result.join(' ');
}

function addsuffixFunc(args: Value[], ev: Evaluator): string {
  const suf = args[0].eval(ev as any);
  const text = args[1].eval(ev as any);
  const words = splitSpace(text);
  const result: string[] = [];
  
  for (const tok of words) {
    result.push(tok + suf);
  }
  
  return result.join(' ');
}

function addprefixFunc(args: Value[], ev: Evaluator): string {
  const pre = args[0].eval(ev as any);
  const text = args[1].eval(ev as any);
  const words = splitSpace(text);
  const result: string[] = [];
  
  for (const tok of words) {
    result.push(pre + tok);
  }
  
  return result.join(' ');
}

function realpathFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
  
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
      // Ignore errors, just like C++ version
    }
  }
  
  return result.join(' ');
}

function abspathFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
  const words = splitSpace(text);
  const result: string[] = [];
  
  for (const tok of words) {
    result.push(absPath(tok));
  }
  
  return result.join(' ');
}

// Conditional and logical functions
function ifFunc(args: Value[], ev: Evaluator): string {
  const cond = args[0].eval(ev as any);
  
  if (!cond) {
    return args.length > 2 ? args[2].eval(ev as any) : '';
  } else {
    return args[1].eval(ev as any);
  }
}

function andFunc(args: Value[], ev: Evaluator): string {
  let cond = '';
  
  for (const arg of args) {
    cond = arg.eval(ev as any);
    if (!cond) {
      return '';
    }
  }
  
  return cond;
}

function orFunc(args: Value[], ev: Evaluator): string {
  for (const arg of args) {
    const cond = arg.eval(ev as any);
    if (cond) {
      return cond;
    }
  }
  
  return '';
}

// Advanced functions
function valueFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev as any);
  const variable = ev.lookupVar(varName);
  return variable ? variable.toString() : '';
}

function evalFunc(args: Value[], ev: Evaluator): string {
  const text = args[0].eval(ev as any);
  
  if (ev.avoid_io()) {
    console.warn(`*warning*: $(eval) in a recipe is not recommended: ${text}`);
  }
  
  // TODO: Implement actual evaluation of make statements
  // For now, return empty string
  return '';
}

function shellFunc(args: Value[], ev: Evaluator): string {
  let cmd = args[0].eval(ev as any);
  
  if (ev.avoid_io() && !hasNoIoInShellScript(cmd)) {
    if (ev.eval_depth() > 1) {
      ev.error("kati doesn't support passing results of $(shell) to other make constructs: " + cmd);
    }
    
    cmd = stripShellComment(cmd);
    return `$(${cmd})`;
  }
  
  const shell = ev.getShell();
  const shellflag = ev.getShellFlag();
  
  try {
    const result = execSync(`${shell} ${shellflag} "${cmd.replace(/"/g, '\\"')}"`, 
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.replace(/\n$/, ''); // Remove trailing newline like C++ version
  } catch (error: any) {
    return '';
  }
}

function callFunc(args: Value[], ev: Evaluator): string {
  const funcName = StrUtil.trimSpace(args[0].eval(ev as any));
  const func = ev.lookupVar(funcName);
  
  if (!func) {
    console.warn(`*warning*: undefined user function: ${funcName}`);
    return '';
  }
  
  // TODO: Implement proper call semantics with parameter binding
  // For now, return placeholder
  return `$(call ${funcName})`;
}

function foreachFunc(args: Value[], ev: Evaluator): string {
  const varname = args[0].eval(ev as any);
  const list = args[1].eval(ev as any);
  const expr = args[2];
  
  const words = splitSpace(list);
  const result: string[] = [];
  
  // TODO: Implement proper variable scoping and evaluation
  // For now, simple placeholder implementation
  for (const word of words) {
    // Would set temporary variable and evaluate expr
    result.push(expr.eval(ev as any));
  }
  
  return result.join(' ');
}

// Information functions
function originFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev as any);
  const variable = ev.lookupVar(varName);
  
  // TODO: Implement proper origin tracking
  return variable ? 'file' : 'undefined';
}

function flavorFunc(args: Value[], ev: Evaluator): string {
  const varName = args[0].eval(ev as any);
  const variable = ev.lookupVar(varName);
  
  // TODO: Implement proper flavor tracking (simple/recursive)
  return variable ? 'simple' : 'undefined';
}

function infoFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev as any);
  
  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands
    return '';
  }
  
  console.log(msg);
  return '';
}

function warningFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev as any);
  
  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands  
    return '';
  }
  
  console.warn(`${ev.loc().filename}:${ev.loc().lineno}: ${msg}`);
  return '';
}

function errorFunc(args: Value[], ev: Evaluator): string {
  const msg = args[0].eval(ev as any);
  
  if (ev.avoid_io()) {
    // TODO: Add to delayed output commands
    return '';
  }
  
  ev.error(`*** ${msg}.`);
}

// File I/O functions
function fileFunc(args: Value[], ev: Evaluator): string {
  if (ev.avoid_io()) {
    ev.error("*** $(file ...) is not supported in rules.");
  }
  
  const arg = args[0].eval(ev as any);
  const filename = StrUtil.trimSpace(arg);
  
  if (filename.length <= 1) {
    ev.error("*** Missing filename");
  }
  
  if (filename[0] === '<') {
    // Read file
    const file = StrUtil.trimLeftSpace(filename.substring(1));
    if (!file) {
      ev.error("*** Missing filename");
    }
    if (args.length > 1) {
      ev.error("*** invalid argument");
    }
    
    try {
      let content = fs.readFileSync(file, 'utf8');
      if (content.endsWith('\n')) {
        content = content.slice(0, -1);
      }
      return content;
    } catch (error) {
      return ''; // File doesn't exist, return empty like C++ version
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
      ev.error("*** Missing filename");
    }
    
    let text = '';
    if (args.length > 1) {
      text = args[1].eval(ev as any);
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
      ev.error("*** file write failed.");
    }
    
    return '';
  } else {
    ev.error(`*** Invalid file operation: ${filename}. Stop.`);
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
  const arg = args[0].eval(ev as any);
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
  const varname = args[0].eval(ev as any);
  const separator = args[1].eval(ev as any);
  const list = args[2].eval(ev as any);
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
  ['patsubst', { name: 'patsubst', func: patsubstFunc, maxArgs: 3, minArgs: 3, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['strip', { name: 'strip', func: stripFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['subst', { name: 'subst', func: substFunc, maxArgs: 3, minArgs: 3, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['findstring', { name: 'findstring', func: findstringFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['filter', { name: 'filter', func: filterFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['filter-out', { name: 'filter-out', func: filterOutFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['sort', { name: 'sort', func: sortFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // Word functions
  ['word', { name: 'word', func: wordFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['wordlist', { name: 'wordlist', func: wordlistFunc, maxArgs: 3, minArgs: 3, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['words', { name: 'words', func: wordsFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['firstword', { name: 'firstword', func: firstwordFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['lastword', { name: 'lastword', func: lastwordFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // List functions
  ['join', { name: 'join', func: joinFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // File functions
  ['wildcard', { name: 'wildcard', func: wildcardFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['dir', { name: 'dir', func: dirFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['notdir', { name: 'notdir', func: notdirFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['suffix', { name: 'suffix', func: suffixFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['basename', { name: 'basename', func: basenameFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['addsuffix', { name: 'addsuffix', func: addsuffixFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['addprefix', { name: 'addprefix', func: addprefixFunc, maxArgs: 2, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['realpath', { name: 'realpath', func: realpathFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['abspath', { name: 'abspath', func: abspathFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // Conditional functions
  ['if', { name: 'if', func: ifFunc, maxArgs: 3, minArgs: 2, hasVariadicArgs: false, trimRightFirstArg: true }],
  ['and', { name: 'and', func: andFunc, maxArgs: 0, minArgs: 0, hasVariadicArgs: true, trimRightFirstArg: false }],
  ['or', { name: 'or', func: orFunc, maxArgs: 0, minArgs: 0, hasVariadicArgs: true, trimRightFirstArg: false }],
  
  // Advanced functions
  ['value', { name: 'value', func: valueFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['eval', { name: 'eval', func: evalFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['shell', { name: 'shell', func: shellFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['call', { name: 'call', func: callFunc, maxArgs: 0, minArgs: 0, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['foreach', { name: 'foreach', func: foreachFunc, maxArgs: 3, minArgs: 3, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // Information functions
  ['origin', { name: 'origin', func: originFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['flavor', { name: 'flavor', func: flavorFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // I/O functions
  ['info', { name: 'info', func: infoFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['warning', { name: 'warning', func: warningFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['error', { name: 'error', func: errorFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['file', { name: 'file', func: fileFunc, maxArgs: 2, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  
  // KATI extension functions
  ['KATI_deprecated_var', { name: 'KATI_deprecated_var', func: deprecatedVarFunc, maxArgs: 2, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_obsolete_var', { name: 'KATI_obsolete_var', func: obsoleteVarFunc, maxArgs: 2, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_deprecate_export', { name: 'KATI_deprecate_export', func: deprecateExportFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_obsolete_export', { name: 'KATI_obsolete_export', func: obsoleteExportFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_profile_makefile', { name: 'KATI_profile_makefile', func: profileFunc, maxArgs: 0, minArgs: 0, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_variable_location', { name: 'KATI_variable_location', func: variableLocationFunc, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_extra_file_deps', { name: 'KATI_extra_file_deps', func: extraFileDepsFunc, maxArgs: 0, minArgs: 0, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_shell_no_rerun', { name: 'KATI_shell_no_rerun', func: shellFuncNoRerun, maxArgs: 1, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_foreach_sep', { name: 'KATI_foreach_sep', func: foreachWithSepFunc, maxArgs: 4, minArgs: 4, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_file_no_rerun', { name: 'KATI_file_no_rerun', func: fileFuncNoRerun, maxArgs: 2, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
  ['KATI_visibility_prefix', { name: 'KATI_visibility_prefix', func: varVisibilityFunc, maxArgs: 2, minArgs: 1, hasVariadicArgs: false, trimRightFirstArg: false }],
]);

// Function to get function info by name
export function getFuncInfo(name: string): FuncInfo | null {
  return FUNC_INFO_MAP.get(name) || null;
}