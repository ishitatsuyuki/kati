import {Pattern, joinStrings, splitSpace} from '../utils/strutil';
import {getFuncInfo} from './func';
import {Evaluator, Loc} from './evaluator';
import {SimpleVar, RecursiveVar, VarOrigin} from './var';
import {Rule, Symbol, Intern} from './dep';
import * as fs from 'fs';
import * as path from 'path';

enum AssignOp {
  EQ = 'EQ',
  COLON_EQ = 'COLON_EQ',
  PLUS_EQ = 'PLUS_EQ',
  QUESTION_EQ = 'QUESTION_EQ',
}

enum AssignDirective {
  NONE = 0,
  OVERRIDE = 1,
  EXPORT = 2,
}

enum CondOp {
  IFEQ = 'IFEQ',
  IFNEQ = 'IFNEQ',
  IFDEF = 'IFDEF',
  IFNDEF = 'IFNDEF',
}

enum ParseExprOpt {
  NORMAL = 0,
  DEFINE = 1,
  COMMAND = 2,
  FUNC = 3,
}

enum RuleSep {
  NULL = 'NULL',
  SEMICOLON = 'SEMICOLON',
  EQ = 'EQ',
  FINALEQ = 'FINALEQ',
}

abstract class Value {
  constructor(public loc: Loc) {}

  abstract eval(ev: Evaluator): string;
  abstract isFunc(ev: Evaluator): boolean;
  abstract isLiteral(): boolean;
  abstract getLiteralValueUnsafe(): string;
  abstract debugString(): string;
}

class Literal extends Value {
  constructor(
    loc: Loc,
    private s: string,
  ) {
    super(loc);
  }

  eval(_ev: Evaluator): string {
    return this.s;
  }

  isFunc(_ev: Evaluator): boolean {
    return false;
  }

  isLiteral(): boolean {
    return true;
  }

  getLiteralValueUnsafe(): string {
    return this.s;
  }

  debugString(): string {
    return `"${this.s}"`;
  }
}

class ValueList extends Value {
  constructor(
    loc: Loc,
    private values: Value[],
  ) {
    super(loc);
  }

  eval(ev: Evaluator): string {
    return this.values.map(v => v.eval(ev)).join('');
  }

  isFunc(ev: Evaluator): boolean {
    return this.values.some(v => v.isFunc(ev));
  }

  isLiteral(): boolean {
    return false;
  }

  getLiteralValueUnsafe(): string {
    throw new Error('ValueList is not a literal');
  }

  debugString(): string {
    return `ValueList(${this.values.map(v => v.debugString()).join(', ')})`;
  }
}

class SymRef extends Value {
  constructor(
    loc: Loc,
    private name: string,
  ) {
    super(loc);
  }

  eval(ev: Evaluator): string {
    const var_ = ev.getVar(this.name);
    var_.used(ev, this.name);
    return var_.eval(ev);
  }

  isFunc(_ev: Evaluator): boolean {
    // Heuristic: if variable name is a number, likely a function parameter
    return /^\d+$/.test(this.name);
  }

  isLiteral(): boolean {
    return false;
  }

  getLiteralValueUnsafe(): string {
    throw new Error('SymRef is not a literal');
  }

  debugString(): string {
    return `SymRef(${this.name})`;
  }
}

class VarRef extends Value {
  constructor(
    loc: Loc,
    private nameExpr: Value,
  ) {
    super(loc);
  }

  eval(ev: Evaluator): string {
    const name = this.nameExpr.eval(ev);
    const var_ = ev.getVar(name);
    var_.used(ev, name);
    return var_.eval(ev);
  }

  isFunc(_ev: Evaluator): boolean {
    return true;
  }

  isLiteral(): boolean {
    return false;
  }

  getLiteralValueUnsafe(): string {
    throw new Error('VarRef is not a literal');
  }

  debugString(): string {
    return `VarRef(${this.nameExpr.debugString()})`;
  }
}

class VarSubst extends Value {
  constructor(
    loc: Loc,
    private nameExpr: Value,
    private pattern: Value,
    private subst: Value,
  ) {
    super(loc);
  }

  eval(ev: Evaluator): string {
    const name = this.nameExpr.eval(ev);
    const pat = this.pattern.eval(ev);
    const sub = this.subst.eval(ev);

    const var_ = ev.getVar(name);
    var_.used(ev, name);
    const varValue = var_.eval(ev);
    if (!varValue) {
      return '';
    }

    const pattern = new Pattern(pat);
    const words = splitSpace(varValue);
    const transformedWords = words.map((word: string) =>
      pattern.appendSubst(word, sub),
    );

    return joinStrings(transformedWords, ' ');
  }

  isFunc(ev: Evaluator): boolean {
    return (
      this.nameExpr.isFunc(ev) ||
      this.pattern.isFunc(ev) ||
      this.subst.isFunc(ev)
    );
  }

  isLiteral(): boolean {
    return false;
  }

  getLiteralValueUnsafe(): string {
    throw new Error('VarSubst is not a literal');
  }

  debugString(): string {
    return `VarSubst(${this.nameExpr.debugString()}:${this.pattern.debugString()}=${this.subst.debugString()})`;
  }
}

class Func extends Value {
  private args: Value[] = [];

  constructor(
    loc: Loc,
    private name: string,
  ) {
    super(loc);
  }

  addArg(arg: Value): void {
    this.args.push(arg);
  }

  getName(): string {
    return this.name;
  }

  eval(ev: Evaluator): string {
    const funcInfo = getFuncInfo(this.name);
    if (!funcInfo) {
      throw new Error(`Unknown function: ${this.name}`);
    }

    // Check argument count using C++ arity semantics
    const nargs = this.args.length;

    if (nargs < funcInfo.minArity) {
      throw new Error(
        `*** insufficient number of arguments (${nargs}) to function '${this.name}'.`,
      );
    }

    return funcInfo.func(this.args, ev);
  }

  isFunc(_ev: Evaluator): boolean {
    return true;
  }

  isLiteral(): boolean {
    return false;
  }

  getLiteralValueUnsafe(): string {
    throw new Error('Func is not a literal');
  }

  debugString(): string {
    return `Func(${this.name} ${this.args.map(a => a.debugString()).join(',')})`;
  }
}

type Expr = Value;

interface Stmt {
  loc: Loc;
  orig?: string | undefined;
  eval(ev: Evaluator): void;
  debugString(): string;
}

class RuleStmt implements Stmt {
  constructor(
    public loc: Loc,
    public lhs: Expr,
    public sep: RuleSep,
    public rhs: Expr | null = null,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    // Evaluate the left-hand side (targets)
    const beforeTerm = this.lhs.eval(ev);

    // Check for empty targets (see semicolon.mk comment in C++ code)
    if (beforeTerm.match(/^\s*[;\s]*$/)) {
      if (this.sep === RuleSep.SEMICOLON) {
        ev.error('*** missing rule before commands.');
      }
      return;
    }

    // Parse targets from the left-hand side
    const colonPos = beforeTerm.indexOf(':');
    if (colonPos === -1) {
      ev.error('*** missing separator.');
    }

    const targetsString = beforeTerm.substring(0, colonPos);
    const afterTargets = beforeTerm.substring(colonPos + 1);

    // Split targets by whitespace and check for pattern rules
    const targetStrings = targetsString
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0);

    if (targetStrings.length === 0) {
      ev.error('*** missing target.');
    }

    let isPatternRule = false;
    for (const target of targetStrings) {
      if (target.includes('%')) {
        isPatternRule = true;
        break;
      }
    }

    // Check for double colon rules
    let remainingAfterTargets = afterTargets;
    let isDoubleColon = false;
    if (remainingAfterTargets.startsWith(':')) {
      isDoubleColon = true;
      remainingAfterTargets = remainingAfterTargets.substring(1);
    }

    // Parse prerequisites and order-only inputs
    let prereqString = remainingAfterTargets;
    let orderOnlyInputs: string[] = [];

    // Handle order-only prerequisites (after |)
    const pipePos = remainingAfterTargets.indexOf('|');
    if (pipePos !== -1) {
      prereqString = remainingAfterTargets.substring(0, pipePos);
      const orderOnlyString = remainingAfterTargets.substring(pipePos + 1);
      orderOnlyInputs = orderOnlyString
        .trim()
        .split(/\s+/)
        .filter(p => p.length > 0);
    }

    const prerequisites = prereqString
      .trim()
      .split(/\s+/)
      .filter(p => p.length > 0);

    // Create Rule object
    const rule: Rule = {
      loc: this.loc,
      cmd_loc: () => this.loc,
      cmd_lineno: null,
      outputs: isPatternRule ? [] : targetStrings.map(t => Intern(t)),
      inputs: prerequisites.map(p => Intern(p)),
      order_only_inputs: orderOnlyInputs.map(p => Intern(p)),
      output_patterns: isPatternRule ? targetStrings.map(t => Intern(t)) : [],
      cmds: [],
      is_double_colon: isDoubleColon,
      is_suffix_rule: false, // Will be detected in DepBuilder
    };

    // Handle semicolon separator (inline command)
    if (this.sep === RuleSep.SEMICOLON && this.rhs) {
      const command = this.rhs.eval(ev);
      rule.cmds.push(command);
    }

    // Add rule to evaluator
    ev.addRule(rule);
  }

  debugString(): string {
    const rhsStr = this.rhs ? ` ${this.sep} ${this.rhs.debugString()}` : '';
    return `RuleStmt(${this.lhs.debugString()}${rhsStr})`;
  }
}

class AssignStmt implements Stmt {
  private lhsSymCache: string | null = null;

  constructor(
    public loc: Loc,
    public lhs: Expr,
    public rhs: Expr,
    public orig_rhs: string,
    public op: AssignOp,
    public directive: AssignDirective = AssignDirective.NONE,
    public is_final: boolean = false,
    public orig?: string,
  ) {}

  getLhsSymbol(ev: Evaluator): string {
    // TODO: Remove sym cache
    if (!this.lhs.isLiteral()) {
      return this.lhs.eval(ev);
    }

    if (!this.lhsSymCache) {
      this.lhsSymCache = this.lhs.getLiteralValueUnsafe();
    }
    return this.lhsSymCache;
  }

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    const name = this.getLhsSymbol(ev);
    const currentVar = ev.getVar(name);

    switch (this.op) {
      case AssignOp.EQ:
        {
          // Recursively expanded variable - store as RecursiveVar
          const recursiveVar = new RecursiveVar(
            this.rhs,
            VarOrigin.FILE,
            null,
            this.loc,
            this.orig_rhs,
          );
          ev.setVar(name, recursiveVar);
        }
        break;

      case AssignOp.COLON_EQ:
        {
          // Simply expanded variable - evaluate and store as SimpleVar
          const value = this.rhs.eval(ev);
          const simpleVar = new SimpleVar(
            value,
            VarOrigin.FILE,
            null,
            this.loc,
          );
          ev.setVar(name, simpleVar);
        }
        break;

      case AssignOp.PLUS_EQ:
        {
          // Append to variable
          if (currentVar.isDefined()) {
            currentVar.appendVar(ev, this.rhs);
          } else {
            // Create new variable if it doesn't exist
            const newValue = this.rhs.eval(ev);
            const newVar = new SimpleVar(
              newValue,
              VarOrigin.FILE,
              null,
              this.loc,
            );
            ev.setVar(name, newVar);
          }
        }
        break;

      case AssignOp.QUESTION_EQ:
        {
          // Set only if undefined
          if (!currentVar.isDefined()) {
            const conditionalValue = this.rhs.eval(ev);
            const conditionalVar = new SimpleVar(
              conditionalValue,
              VarOrigin.FILE,
              null,
              this.loc,
            );
            ev.setVar(name, conditionalVar);
          }
        }
        break;
    }
  }

  debugString(): string {
    const finalStr = this.is_final ? '$=' : '';
    return `AssignStmt(${this.lhs.debugString()} ${this.op} ${finalStr}${this.rhs.debugString()})`;
  }
}

class CommandStmt implements Stmt {
  constructor(
    public loc: Loc,
    public expr: Expr,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    const command = this.expr.eval(ev);

    // Add command to the most recently added rule
    const rules = ev.getRules();
    if (rules.length > 0) {
      const lastRule = rules[rules.length - 1];
      lastRule.cmds.push(command);
      
      // Set command location if not already set
      if (!lastRule.cmd_lineno) {
        lastRule.cmd_lineno = this.loc.lineno;
      }
    } else {
      ev.error('*** commands commence before first target.');
    }
  }

  debugString(): string {
    return `CommandStmt(${this.expr.debugString()})`;
  }
}

class IfStmt implements Stmt {
  public true_stmts: Stmt[] = [];
  public false_stmts: Stmt[] = [];

  constructor(
    public loc: Loc,
    public op: CondOp,
    public lhs: Expr,
    public rhs: Expr | null = null,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    let condition = false;
    const varName = this.lhs.eval(ev).trim();
    const lhsValue = ev.getVar(varName).string();

    switch (this.op) {
      case CondOp.IFDEF:
        // Check if variable is defined and non-empty
        condition = lhsValue !== '';
        break;

      case CondOp.IFNDEF:
        // Check if variable is undefined or empty
        condition = lhsValue === '';
        break;

      case CondOp.IFEQ:
        if (this.rhs) {
          const rhsValue = this.rhs.eval(ev).trim();
          condition = lhsValue === rhsValue;
        } else {
          condition = false;
        }
        break;

      case CondOp.IFNEQ:
        if (this.rhs) {
          const rhsValue = this.rhs.eval(ev).trim();
          condition = lhsValue !== rhsValue;
        } else {
          condition = true;
        }
        break;
    }

    // Execute appropriate statement list
    const stmts = condition ? this.true_stmts : this.false_stmts;
    for (const stmt of stmts) {
      stmt.eval(ev);
    }
  }

  debugString(): string {
    const rhsStr = this.rhs ? ` ${this.rhs.debugString()}` : '';
    return `IfStmt(${this.op} ${this.lhs.debugString()}${rhsStr})`;
  }
}

class IncludeStmt implements Stmt {
  constructor(
    public loc: Loc,
    public expr: Expr,
    public should_exist: boolean,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    const filename = this.expr.eval(ev);

    // Handle multiple space-separated filenames
    const filenames = filename
      .trim()
      .split(/\s+/)
      .filter(f => f.length > 0);

    for (const file of filenames) {
      let fullPath = file;

      // If not absolute, resolve relative to current file's directory
      if (!path.isAbsolute(file)) {
        const currentDir = path.dirname(this.loc.filename);
        fullPath = path.resolve(currentDir, file);
      }

      try {
        if (!fs.existsSync(fullPath)) {
          if (this.should_exist) {
            ev.error(
              `*** No rule to make target '${file}', needed by '${this.loc.filename}'.  Stop.`,
            );
          }
          // For -include, silently skip missing files
          continue;
        }

        // In a full implementation, this would:
        // 1. Parse the included file as a Makefile
        // 2. Execute its statements in the current context
        // 3. Handle recursive includes with cycle detection

        console.log(`Including file: ${fullPath}`);

        // For now, just log the inclusion
        // A full implementation would require integrating with the parser
      } catch (error) {
        if (this.should_exist) {
          ev.error(`Error including '${file}': ${error}`);
        }
        // For -include, silently skip errors
      }
    }
  }

  debugString(): string {
    const prefix = this.should_exist ? 'include' : '-include';
    return `IncludeStmt(${prefix} ${this.expr.debugString()})`;
  }
}

class ExportStmt implements Stmt {
  constructor(
    public loc: Loc,
    public expr: Expr,
    public is_export: boolean,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);

    const variables = this.expr.eval(ev);

    // Handle multiple space-separated variable names
    const varNames = variables
      .trim()
      .split(/\s+/)
      .filter(v => v.length > 0);

    if (varNames.length === 0) {
      // Export/unexport all variables
      if (this.is_export) {
        console.log('Exporting all variables');
        // In full implementation: mark all variables for export
      } else {
        console.log('Unexporting all variables');
        // In full implementation: unmark all variables from export
      }
      return;
    }

    for (const varName of varNames) {
      if (this.is_export) {
        // Export the variable to environment
        const var_ = ev.getVar(varName);
        const value = var_.eval(ev);
        process.env[varName] = value;
        console.log(`Exported ${varName}=${value}`);
      } else {
        // Unexport the variable from environment
        delete process.env[varName];
        console.log(`Unexported ${varName}`);
      }
    }
  }

  debugString(): string {
    const prefix = this.is_export ? 'export' : 'unexport';
    return `ExportStmt(${prefix} ${this.expr.debugString()})`;
  }
}

export {
  AssignOp,
  AssignDirective,
  RuleSep,
  CondOp,
  ParseExprOpt,
  Expr,
  Value,
  Literal,
  ValueList,
  SymRef,
  VarRef,
  VarSubst,
  Func,
  Stmt,
  RuleStmt,
  AssignStmt,
  CommandStmt,
  IfStmt,
  IncludeStmt,
  ExportStmt,
};

export class ParseErrorStmt implements Stmt {
  constructor(
    public loc: Loc,
    public msg: string,
    public orig?: string,
  ) {}

  eval(ev: Evaluator): void {
    ev.setLoc(this.loc);
    ev.error(this.msg);
  }

  debugString(): string {
    return `ParseErrorStmt(${this.msg})`;
  }
}
