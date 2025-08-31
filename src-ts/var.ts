import {Evaluator, Loc} from './evaluator';
import {AssignOp, Literal, Value, ValueList} from './ast';
import {DepNode, Symbol as DepSymbol} from './dep';
import {Pattern, splitSpace} from './strutil';
import {FileUtil} from './fileutil';

export type Symbol = string;
export type SymbolSet = Set<string>;

export enum VarOrigin {
  UNDEFINED = 'UNDEFINED',
  DEFAULT = 'DEFAULT',
  ENVIRONMENT = 'ENVIRONMENT',
  ENVIRONMENT_OVERRIDE = 'ENVIRONMENT_OVERRIDE',
  FILE = 'FILE',
  COMMAND_LINE = 'COMMAND_LINE',
  OVERRIDE = 'OVERRIDE',
  AUTOMATIC = 'AUTOMATIC',
}

export function getOriginStr(origin: VarOrigin): string {
  switch (origin) {
    case VarOrigin.UNDEFINED:
      return 'undefined';
    case VarOrigin.DEFAULT:
      return 'default';
    case VarOrigin.ENVIRONMENT:
      return 'environment';
    case VarOrigin.ENVIRONMENT_OVERRIDE:
      return 'environment override';
    case VarOrigin.FILE:
      return 'file';
    case VarOrigin.COMMAND_LINE:
      return 'command line';
    case VarOrigin.OVERRIDE:
      return 'override';
    case VarOrigin.AUTOMATIC:
      return 'automatic';
  }
}

export interface Frame {
  filename: string;
  lineno: number;
}

export abstract class Var {
  protected readonly origin_: VarOrigin;
  protected definition_: Frame | null;
  protected assign_op_: AssignOp = AssignOp.EQ;
  protected readonly_ = false;
  protected deprecated_ = false;
  protected obsolete_ = false;
  protected self_referential_ = false;
  protected visibility_prefix_: string[] = [];
  protected loc_: Loc;

  private static diagnostic_messages_ = new WeakMap<Var, string>();

  constructor();
  constructor(origin: VarOrigin, definition: Frame | null, loc: Loc);
  constructor(origin?: VarOrigin, definition?: Frame | null, loc?: Loc) {
    this.origin_ = origin || VarOrigin.UNDEFINED;
    this.definition_ = definition || null;
    this.loc_ = loc || {filename: '<unknown>', lineno: 0};
  }

  abstract flavor(): string;
  abstract isDefined(): boolean;
  abstract isFunc(ev: Evaluator): boolean;
  abstract eval(ev: Evaluator): string;
  abstract string(): string;
  abstract debugString(): string;

  origin(): VarOrigin {
    return this.origin_;
  }

  definition(): Frame | null {
    return this.definition_;
  }

  // TODO: Add a "orig" field to modify output of $(value)
  appendVar(ev: Evaluator, v: Value): void {
    throw new Error('appendVar not supported by this variable type');
  }

  readOnly(): boolean {
    return this.readonly_;
  }

  setReadOnly(): void {
    this.readonly_ = true;
  }

  deprecated(): boolean {
    return this.deprecated_;
  }

  setDeprecated(msg: string): void {
    this.deprecated_ = true;
    Var.diagnostic_messages_.set(this, msg);
  }

  obsolete(): boolean {
    return this.obsolete_;
  }

  setObsolete(msg: string): void {
    this.obsolete_ = true;
    Var.diagnostic_messages_.set(this, msg);
  }

  selfReferential(): boolean {
    return this.self_referential_;
  }

  setSelfReferential(): void {
    this.self_referential_ = true;
  }

  visibilityPrefix(): string[] {
    return this.visibility_prefix_;
  }

  setVisibilityPrefix(prefixes: string[], name: string): void {
    const currentPrefixes = this.visibilityPrefix();
    if (currentPrefixes.length === 0) {
      this.visibility_prefix_ = [...prefixes];
    } else if (!this.arraysEqual(currentPrefixes, prefixes)) {
      throw new Error(`Visibility prefix conflict on variable: ${name}`);
    }
  }

  checkCurrentReferencingFile(loc: Loc, name: string): void {
    const prefixes = this.visibilityPrefix();
    if (prefixes.length === 0) {
      return;
    }

    let valid = false;
    for (const prefix of prefixes) {
      if (this.hasPathPrefix(loc.filename, prefix)) {
        valid = true;
        break;
      }
    }

    if (!valid) {
      const prefixesString = prefixes.join('\n');
      throw new Error(
        `${loc.filename} is not a valid file to reference variable ${name}. Line #${loc.lineno}.\nValid file prefixes:\n${prefixesString}`,
      );
    }
  }

  deprecatedMessage(): string {
    return Var.diagnostic_messages_.get(this) || '';
  }

  used(ev: Evaluator, sym: Symbol): void {
    if (this.obsolete_) {
      throw new Error(`*** ${sym} is obsolete${this.diagnosticMessageText()}.`);
    } else if (this.deprecated_) {
      console.warn(
        `${sym} has been deprecated${this.diagnosticMessageText()}.`,
      );
    }
  }

  op(): AssignOp {
    return this.assign_op_;
  }

  setAssignOp(op: AssignOp): void {
    this.assign_op_ = op;
  }

  location(): Loc {
    return this.loc_;
  }

  private diagnosticMessageText(): string {
    const msg = Var.diagnostic_messages_.get(this);
    return msg ? `: ${msg}` : '';
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((val, i) => val === b[i]);
  }

  private hasPathPrefix(path: string, prefix: string): boolean {
    return path.startsWith(prefix);
  }

  static undefined(): Var {
    return UndefinedVar.instance();
  }
}

export class SimpleVar extends Var {
  constructor(
    protected v_: string,
    origin: VarOrigin,
    definition: Frame | null,
    loc: Loc,
  ) {
    super(origin, definition, loc);
  }

  flavor(): string {
    return 'simple';
  }

  isDefined(): boolean {
    return true;
  }

  isFunc(_ev: Evaluator): boolean {
    return false;
  }

  eval(_ev: Evaluator): string {
    return this.v_;
  }

  override appendVar(ev: Evaluator, v: Value): void {
    const buf = v.eval(ev);
    this.v_ += ' ' + buf;
    this.definition_ = {filename: ev.loc().filename, lineno: ev.loc().lineno};
  }

  string(): string {
    return this.v_;
  }

  debugString(): string {
    return this.v_;
  }
}

export class RecursiveVar extends Var {
  protected v_: Value;
  protected orig_: string;

  constructor(
    v: Value,
    origin: VarOrigin,
    definition: Frame | null,
    loc: Loc,
    orig: string,
  ) {
    super(origin, definition, loc);
    this.v_ = v;
    this.orig_ = orig;
  }

  flavor(): string {
    return 'recursive';
  }

  isDefined(): boolean {
    return true;
  }

  isFunc(ev: Evaluator): boolean {
    return this.v_.isFunc(ev);
  }

  eval(ev: Evaluator): string {
    return this.v_.eval(ev);
  }

  override appendVar(ev: Evaluator, v: Value): void {
    this.v_ = new ValueList(v.loc, [this.v_, new Literal(v.loc, ' '), v]);
    // TODO: append orig_
    this.definition_ = {filename: ev.loc().filename, lineno: ev.loc().lineno};
  }

  override used(ev: Evaluator, sym: Symbol): void {
    if (this.selfReferential()) {
      throw new Error(
        `*** Recursive variable "${sym}" references itself (eventually).`,
      );
    }
    super.used(ev, sym);
  }

  string(): string {
    return this.orig_;
  }

  debugString(): string {
    return this.v_.debugString();
  }
}

export class UndefinedVar extends Var {
  private static instance_: UndefinedVar | null = null;

  constructor() {
    super();
  }

  flavor(): string {
    return 'undefined';
  }

  isDefined(): boolean {
    return false;
  }

  isFunc(_ev: Evaluator): boolean {
    return false;
  }

  eval(_ev: Evaluator): string {
    return '';
  }

  string(): string {
    return '';
  }

  debugString(): string {
    return '*undefined*';
  }

  static instance(): UndefinedVar {
    if (!UndefinedVar.instance_) {
      UndefinedVar.instance_ = new UndefinedVar();
    }
    return UndefinedVar.instance_;
  }
}

export class VariableNamesVar extends Var {
  private name_: string;
  private all_: boolean;

  constructor(name: string, all: boolean) {
    super();
    this.name_ = name;
    this.all_ = all;
    this.setReadOnly();
    this.setAssignOp(AssignOp.COLON_EQ);
  }

  flavor(): string {
    return 'kati_variable_names';
  }

  isDefined(): boolean {
    return true;
  }

  isFunc(_ev: Evaluator): boolean {
    return false;
  }

  eval(ev: Evaluator): string {
    return this.concatVariableNames(ev);
  }

  string(): string {
    return this.name_;
  }

  debugString(): string {
    return '*VariableNamesVar*';
  }

  private concatVariableNames(ev: Evaluator): string {
    console.warn('TODO: implement VariableNamesVar');
    return '';
  }
}

export class ShellStatusVar extends Var {
  private static isSet_ = false;
  private static shellStatus_ = 0;
  private static shellStatusString_ = '';

  constructor() {
    super();
    this.setReadOnly();
    this.setAssignOp(AssignOp.COLON_EQ);
  }

  static setValue(newShellStatus: number): void {
    if (
      !ShellStatusVar.isSet_ ||
      ShellStatusVar.shellStatus_ !== newShellStatus
    ) {
      ShellStatusVar.shellStatus_ = newShellStatus;
      ShellStatusVar.shellStatusString_ = newShellStatus.toString();
      ShellStatusVar.isSet_ = true;
    }
  }

  flavor(): string {
    return 'simple';
  }

  isDefined(): boolean {
    return ShellStatusVar.isSet_;
  }

  isFunc(_ev: Evaluator): boolean {
    return false;
  }

  eval(_ev: Evaluator): string {
    return ShellStatusVar.shellStatusString_;
  }

  string(): string {
    return ShellStatusVar.shellStatusString_;
  }

  debugString(): string {
    return `*ShellStatusVar(${ShellStatusVar.shellStatus_})*`;
  }
}

export interface Command {
  output: DepSymbol;
  cmd: string;
  echo: boolean;
  ignore_error: boolean;
  force_no_subshell?: boolean;
}

export function parseCommandPrefixes(s: string): {
  cmd: string;
  echo: boolean;
  ignore_error: boolean;
} {
  let cmd = s.trimStart();
  let echo = true;
  let ignore_error = false;

  while (cmd.length > 0) {
    const c = cmd[0];
    if (c === '@') {
      echo = false;
    } else if (c === '-') {
      ignore_error = true;
    } else if (c === '+') {
      // ignore recursion marker
    } else {
      break;
    }
    cmd = cmd.substring(1).trimStart();
  }

  return {cmd, echo, ignore_error};
}

export class CommandEvaluator {
  private ev_: Evaluator;
  private current_dep_node_: DepNode | null = null;
  private found_new_inputs_ = false;

  constructor(ev: Evaluator) {
    this.ev_ = ev;
    this.registerAutoVars();
  }

  private registerAutoVars(): void {
    const insertAutoVar = (
      name: string,
      varClass: new (ce: CommandEvaluator, sym: string) => AutoVar,
    ) => {
      const v = new varClass(this, name);
      this.ev_.setVar(name, v);
      this.ev_.setVar(name + 'D', new AutoSuffixDVar(this, name + 'D', v));
      this.ev_.setVar(name + 'F', new AutoSuffixFVar(this, name + 'F', v));
    };

    insertAutoVar('@', AutoAtVar);
    insertAutoVar('<', AutoLessVar);
    insertAutoVar('^', AutoHatVar);
    insertAutoVar('+', AutoPlusVar);
    insertAutoVar('*', AutoStarVar);
    insertAutoVar('?', AutoQuestionVar);
    insertAutoVar('%', AutoNotImplementedVar);
    insertAutoVar('|', AutoNotImplementedVar);
  }

  eval(node: DepNode): Command[] {
    const results: Command[] = [];
    this.current_dep_node_ = node;
    this.found_new_inputs_ = false;

    // Process each command value
    for (const cmdValue of node.cmds) {
      const lines = cmdValue.split('\n');

      for (const line of lines) {
        if (line.trim() === '') continue;

        const {cmd, echo, ignore_error} = parseCommandPrefixes(line);
        if (cmd.length === 0) continue;

        const command: Command = {
          output: node.output,
          cmd,
          echo,
          ignore_error,
        };
        results.push(command);
      }
    }

    this.current_dep_node_ = null;

    return results;
  }

  currentDepNode(): DepNode {
    if (!this.current_dep_node_) {
      throw new Error('No current dependency node');
    }
    return this.current_dep_node_;
  }

  setCurrentDepNode(node: DepNode | null): DepNode | null {
    const ret = this.current_dep_node_;
    this.current_dep_node_ = node;
    return ret;
  }

  evaluator(): Evaluator {
    return this.ev_;
  }

  foundNewInputs(): boolean {
    return this.found_new_inputs_;
  }

  setFoundNewInputs(val: boolean): void {
    this.found_new_inputs_ = val;
  }
}

export abstract class AutoVar extends Var {
  protected ce_: CommandEvaluator;
  protected sym_: string;

  constructor(ce: CommandEvaluator, sym: string) {
    super(VarOrigin.AUTOMATIC, null, {filename: '<automatic>', lineno: 0});
    this.ce_ = ce;
    this.sym_ = sym;
  }

  flavor(): string {
    return 'undefined';
  }

  isDefined(): boolean {
    return true;
  }

  override appendVar(_ev: Evaluator, _v: Value): void {
    throw new Error('Cannot append to automatic variable');
  }

  string(): string {
    throw new Error(`$(value ${this.sym_}) is not implemented yet`);
  }

  debugString(): string {
    return `AutoVar(${this.sym_})`;
  }

  isFunc(_ev: Evaluator): boolean {
    return true;
  }

  abstract eval(ev: Evaluator): string;
}

export class AutoAtVar extends AutoVar {
  eval(_ev: Evaluator): string {
    return this.ce_.currentDepNode().output;
  }
}

export class AutoLessVar extends AutoVar {
  eval(_ev: Evaluator): string {
    const actualInputs = this.ce_.currentDepNode().actual_inputs;
    return actualInputs.length > 0 ? actualInputs[0] : '';
  }
}

export class AutoHatVar extends AutoVar {
  eval(_ev: Evaluator): string {
    const seen = new Set<string>();
    const results: string[] = [];
    for (const input of this.ce_.currentDepNode().actual_inputs) {
      if (!seen.has(input)) {
        seen.add(input);
        results.push(input);
      }
    }
    return results.join(' ');
  }
}

export class AutoPlusVar extends AutoVar {
  eval(_ev: Evaluator): string {
    return this.ce_.currentDepNode().actual_inputs.join(' ');
  }
}

export class AutoStarVar extends AutoVar {
  eval(_ev: Evaluator): string {
    const node = this.ce_.currentDepNode();
    if (!node.output_pattern) {
      return '';
    }
    const pat = new Pattern(node.output_pattern);
    return pat.stem(node.output);
  }
}

export class AutoQuestionVar extends AutoVar {
  eval(ev: Evaluator): string {
    const seen = new Set<string>();
    const results: string[] = [];

    if (ev.avoid_io()) {
      results.push('${KATI_NEW_INPUTS}');
      if (!this.ce_.foundNewInputs()) {
        const commands: string[] = ['KATI_NEW_INPUTS=$(find'];
        for (const input of this.ce_.currentDepNode().actual_inputs) {
          if (!seen.has(input)) {
            seen.add(input);
            commands.push(input);
          }
        }
        commands.push(
          '$(test -e',
          this.ce_.currentDepNode().output,
          '&& echo -newer',
          this.ce_.currentDepNode().output,
          ')) && export KATI_NEW_INPUTS',
        );
        // TODO: Need to add delayed output commands support to Evaluator
        // ev.addDelayedOutputCommand(commands.join(' '));
        this.ce_.setFoundNewInputs(true);
      }
    } else {
      // For now, return all inputs since we can't easily do async timestamp checking in eval
      // This is a simplification - the real implementation would need async support
      for (const input of this.ce_.currentDepNode().actual_inputs) {
        if (!seen.has(input)) {
          seen.add(input);
          results.push(input);
        }
      }
    }
    return results.join(' ');
  }
}

export class AutoNotImplementedVar extends AutoVar {
  eval(ev: Evaluator): never {
    throw new Error(`Automatic variable \`$${this.sym_}\` isn't supported yet`);
  }
}

export class AutoSuffixDVar extends AutoVar {
  private wrapped_: Var;

  constructor(ce: CommandEvaluator, sym: string, wrapped: Var) {
    super(ce, sym);
    this.wrapped_ = wrapped;
  }

  eval(ev: Evaluator): string {
    const buf = this.wrapped_.eval(ev);
    const results: string[] = [];
    for (const token of splitSpace(buf)) {
      results.push(FileUtil.dirname(token));
    }
    return results.join(' ');
  }
}

export class AutoSuffixFVar extends AutoVar {
  private wrapped_: Var;

  constructor(ce: CommandEvaluator, sym: string, wrapped: Var) {
    super(ce, sym);
    this.wrapped_ = wrapped;
  }

  eval(ev: Evaluator): string {
    const buf = this.wrapped_.eval(ev);
    const results: string[] = [];
    for (const token of splitSpace(buf)) {
      results.push(FileUtil.basename(token));
    }
    return results.join(' ');
  }
}

export class Vars extends Map<Symbol, Var> {
  private static usedEnvVars_: SymbolSet = new Set<string>();

  lookup(name: Symbol): Var {
    const var_ = this.get(name);
    return var_ || Var.undefined();
  }

  peek(name: Symbol): Var | undefined {
    return this.get(name);
  }

  assign(name: Symbol, v: Var): {readonly: boolean} {
    const existing = this.get(name);
    const readonly = existing ? existing.readOnly() : false;

    if (!readonly) {
      this.set(name, v);
    }

    return {readonly};
  }

  static addUsedEnvVars(v: Symbol): void {
    Vars.usedEnvVars_.add(v);
  }

  static usedEnvVars(): SymbolSet {
    return Vars.usedEnvVars_;
  }
}
