import {Evaluator, Loc} from './evaluator';
import {Var, Vars} from './var';
import {hasSuffix, Pattern} from './strutil';
import {Value} from './ast';
export type Symbol = string;
export type SymbolSet = Set<string>;

// Type definitions for dependency nodes and rules
export interface DepNode {
  output: Symbol;
  has_rule: boolean;
  is_default_target: boolean;
  is_phony: boolean;
  is_restat: boolean;
  rule_vars: Vars | null;
  depfile_var: Var | null;
  ninja_pool_var: Var | null;
  tags_var: Var | null;
  cmds: Value[];
  actual_inputs: Symbol[];
  actual_order_only_inputs: Symbol[];
  actual_validations: Symbol[];
  implicit_outputs: Symbol[];
  deps: Array<{input: Symbol; node: DepNode}>;
  order_onlys: Array<{input: Symbol; node: DepNode}>;
  validations: Array<{input: Symbol; node: DepNode}>;
  output_pattern: Symbol | null;
  loc: Loc;
}

export interface NamedDepNode {
  name: Symbol;
  node: DepNode;
}

export interface Rule {
  loc: Loc;
  cmd_loc: () => Loc;
  cmd_lineno: number | null;
  outputs: Symbol[];
  inputs: Symbol[];
  order_only_inputs: Symbol[];
  output_patterns: Symbol[];
  cmds: Value[];
  is_double_colon: boolean;
  is_suffix_rule: boolean;
}

export type DepVars = Map<Symbol, Var>;

// Helper functions
function stripExt(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return path.substring(0, lastDot);
  }
  return path;
}

function getExt(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return path.substring(lastDot);
  }
  return '';
}

function replaceSuffix(s: Symbol, newsuf: Symbol): Symbol {
  return stripExt(s) + '.' + newsuf;
}

function applyOutputPattern(
  rule: Rule,
  output: Symbol,
  inputs: Symbol[],
  outInputs: Symbol[],
): void {
  if (inputs.length === 0) return;

  if (rule.is_suffix_rule) {
    for (const input of inputs) {
      outInputs.push(replaceSuffix(output, input));
    }
    return;
  }

  if (rule.output_patterns.length === 0) {
    outInputs.push(...inputs);
    return;
  }

  if (rule.output_patterns.length !== 1) {
    throw new Error('Multiple output patterns not supported');
  }

  const pat = new Pattern(rule.output_patterns[0]);
  for (const input of inputs) {
    const buf = pat.appendSubst(output, input);
    outInputs.push(buf);
  }
}

// Rule matching trie for efficient implicit rule lookup
class RuleTrieEntry {
  constructor(
    public rule: Rule,
    public suffix: string,
  ) {}
}

class RuleTrie {
  private rules_: RuleTrieEntry[] = [];
  private children_ = new Map<string, RuleTrie>();

  add(name: string, rule: Rule): void {
    if (name.length === 0 || name[0] === '%') {
      this.rules_.push(new RuleTrieEntry(rule, name));
      return;
    }

    const c = name[0];
    let child = this.children_.get(c);
    if (!child) {
      child = new RuleTrie();
      this.children_.set(c, child);
    }
    child.add(name.substring(1), rule);
  }

  get(name: string, rules: Rule[]): void {
    for (const entry of this.rules_) {
      if (
        (entry.suffix.length === 0 && name.length === 0) ||
        hasSuffix(name, entry.suffix.substring(1))
      ) {
        rules.push(entry.rule);
      }
    }

    if (name.length === 0) return;

    const child = this.children_.get(name[0]);
    if (child) {
      child.get(name.substring(1), rules);
    }
  }

  size(): number {
    let r = this.rules_.length;
    for (const child of this.children_.values()) {
      r += child.size();
    }
    return r;
  }
}

function isSuffixRule(output: Symbol): boolean {
  const str = output;
  if (str.length === 0 || !isSpecialTarget(output)) return false;

  const rest = str.substring(1);
  const dotIndex = rest.indexOf('.');

  // If there is no dot or multiple dots, this is not a suffix rule
  if (dotIndex === -1 || rest.substring(dotIndex + 1).indexOf('.') !== -1) {
    return false;
  }

  return true;
}

export function isSpecialTarget(output: Symbol): boolean {
  const str = output;
  return str.length >= 2 && str[0] === '.' && str[1] !== '.';
}

// Rule merger for combining multiple rules targeting the same output
class RuleMerger {
  rules: Rule[] = [];
  implicit_outputs: Array<{output: Symbol; merger: RuleMerger}> = [];
  validations: Symbol[] = [];
  primary_rule: Rule | null = null;
  parent: RuleMerger | null = null;
  parent_sym: Symbol | null = null;
  is_double_colon = false;

  addImplicitOutput(output: Symbol, merger: RuleMerger): void {
    this.implicit_outputs.push({output, merger});
  }

  addValidation(validation: Symbol): void {
    this.validations.push(validation);
  }

  setImplicitOutput(output: Symbol, p: Symbol, merger: RuleMerger): void {
    if (!merger.primary_rule) {
      throw new Error(
        `*** implicit output \`${output}' on phony target \`${p}'`,
      );
    }
    if (this.parent) {
      throw new Error(
        `*** implicit output \`${output}' of \`${p}' was already defined by \`${this.parent_sym}'`,
      );
    }
    if (this.primary_rule) {
      throw new Error(`*** implicit output \`${output}' may not have commands`);
    }
    this.parent = merger;
    this.parent_sym = p;
  }

  addRule(output: Symbol, rule: Rule): void {
    if (this.rules.length === 0) {
      this.is_double_colon = rule.is_double_colon;
    } else if (this.is_double_colon !== rule.is_double_colon) {
      throw new Error(
        `*** target file \`${output}' has both : and :: entries.`,
      );
    }

    if (
      this.primary_rule &&
      rule.cmds.length > 0 &&
      !isSuffixRule(output) &&
      !rule.is_double_colon
    ) {
      // Command override warning/error would go here
      this.primary_rule = rule;
    }

    if (!this.primary_rule && rule.cmds.length > 0) {
      this.primary_rule = rule;
    }

    this.rules.push(rule);
  }

  fillDepNodeFromRule(output: Symbol, rule: Rule, node: DepNode): void {
    if (this.is_double_colon) {
      node.cmds.push(...rule.cmds);
    }

    applyOutputPattern(rule, output, rule.inputs, node.actual_inputs);
    applyOutputPattern(
      rule,
      output,
      rule.order_only_inputs,
      node.actual_order_only_inputs,
    );

    if (rule.output_patterns.length >= 1) {
      if (rule.output_patterns.length !== 1) {
        throw new Error('Multiple output patterns not supported');
      }
      node.output_pattern = rule.output_patterns[0];
    }
  }

  fillDepNodeLoc(rule: Rule, node: DepNode): void {
    node.loc = rule.loc;
    if (rule.cmds.length > 0 && rule.cmd_lineno) {
      node.loc = {...node.loc, lineno: rule.cmd_lineno};
    }
  }

  fillDepNode(output: Symbol, patternRule: Rule | null, node: DepNode): void {
    if (this.primary_rule) {
      if (patternRule) {
        throw new Error('Pattern rule conflict');
      }
      this.fillDepNodeFromRule(output, this.primary_rule, node);
      this.fillDepNodeLoc(this.primary_rule, node);
      node.cmds = [...this.primary_rule.cmds];
    } else if (patternRule) {
      this.fillDepNodeFromRule(output, patternRule, node);
      this.fillDepNodeLoc(patternRule, node);
      node.cmds = [...patternRule.cmds];
    }

    for (const rule of this.rules) {
      if (rule === this.primary_rule) continue;
      this.fillDepNodeFromRule(output, rule, node);
      if (!node.loc.filename) {
        node.loc = rule.loc;
      }
    }

    for (const {output: implOut, merger} of this.implicit_outputs) {
      node.implicit_outputs.push(implOut);
      for (const rule of merger.rules) {
        this.fillDepNodeFromRule(output, rule, node);
      }
    }

    for (const validation of this.validations) {
      node.actual_validations.push(validation);
    }
  }
}

export function makeDep(
  ev: Evaluator,
  rules: Rule[],
  ruleVars: Map<Symbol, DepVars>,
  targets: Symbol[],
): NamedDepNode[] {
  const builder = new DepBuilder(rules, ruleVars);
  return builder.build(ev, targets);
}

class DepBuilder {
  private rules_ = new Map<Symbol, RuleMerger>();
  private rule_vars_: Map<Symbol, DepVars>;
  private implicit_rules_ = new RuleTrie();
  private suffix_rules_ = new Map<string, Rule[]>();
  private first_rule_: Symbol | null = null;
  private done_ = new Map<Symbol, DepNode>();
  private phony_ = new Set<Symbol>();
  private restat_ = new Set<Symbol>();

  private depfile_var_name_ = '.KATI_DEPFILE';
  private implicit_outputs_var_name_ = '.KATI_IMPLICIT_OUTPUTS';
  private ninja_pool_var_name_ = '.KATI_NINJA_POOL';
  private validations_var_name_ = '.KATI_VALIDATIONS';
  private tags_var_name_ = '.KATI_TAGS';

  constructor(rules: Rule[], ruleVars: Map<Symbol, DepVars>) {
    this.rule_vars_ = ruleVars;
    this.populateRules(rules);
    this.handleSpecialTargets();
  }

  private populateRules(rules: Rule[]): void {
    for (const rule of rules) {
      if (rule.outputs.length === 0) {
        this.populateImplicitRule(rule);
      } else {
        this.populateExplicitRule(rule);
      }
    }

    // Reverse suffix rules
    for (const ruleList of this.suffix_rules_.values()) {
      ruleList.reverse();
    }

    // Process implicit outputs and validations
    for (const [sym, merger] of this.rules_) {
      const vars = this.lookupRuleVars(sym);
      if (!vars) continue;

      // Handle implicit outputs
      const implicitOutputsVar = vars.get(this.implicit_outputs_var_name_);
      if (implicitOutputsVar) {
        // TODO: Process implicit outputs (simplified - would need proper evaluation)
        // const implicitOutputs = implicitOutputsVar.eval(ev);
        // Parse and process outputs...
      }

      // Handle validations
      const validationsVar = vars.get(this.validations_var_name_);
      if (validationsVar) {
        // TODO: Process validations (simplified - would need proper evaluation)
        // const validations = validationsVar.eval(ev);
        // Parse and process validations...
      }
    }
  }

  private populateExplicitRule(rule: Rule): void {
    for (const output of rule.outputs) {
      if (!this.first_rule_ && !isSpecialTarget(output)) {
        this.first_rule_ = output;
      }

      let merger = this.rules_.get(output);
      if (!merger) {
        merger = new RuleMerger();
        this.rules_.set(output, merger);
      }
      merger.addRule(output, rule);
      this.populateSuffixRule(rule, output);
    }
  }

  private populateSuffixRule(rule: Rule, output: Symbol): boolean {
    if (!isSuffixRule(output)) return false;

    const rest = output.substring(1);
    const dotIndex = rest.indexOf('.');
    const inputSuffix = rest.substring(0, dotIndex);
    const outputSuffix = rest.substring(dotIndex + 1);

    const suffixRule = {
      ...rule,
      inputs: [inputSuffix],
      is_suffix_rule: true,
    };

    let ruleList = this.suffix_rules_.get(outputSuffix);
    if (!ruleList) {
      ruleList = [];
      this.suffix_rules_.set(outputSuffix, ruleList);
    }
    ruleList.push(suffixRule);
    return true;
  }

  private populateImplicitRule(rule: Rule): void {
    for (const outputPattern of rule.output_patterns) {
      // Add checks for ignorable implicit rules (RCS/SCCS) here if needed
      this.implicit_rules_.add(outputPattern, rule);
    }
  }

  private handleSpecialTargets(): void {
    // Handle .PHONY targets
    const phonyTargets = this.getRuleInputs('.PHONY');
    if (phonyTargets) {
      for (const target of phonyTargets) {
        this.phony_.add(target);
      }
    }

    // Handle .KATI_RESTAT targets
    const restatTargets = this.getRuleInputs('.KATI_RESTAT');
    if (restatTargets) {
      for (const target of restatTargets) {
        this.restat_.add(target);
      }
    }

    // Handle .SUFFIXES
    const suffixTargets = this.getRuleInputs('.SUFFIXES');
    if (suffixTargets) {
      if (suffixTargets.length === 0) {
        this.suffix_rules_.clear();
      } else {
        console.warn("kati doesn't support .SUFFIXES with prerequisites");
      }
    }
  }

  private getRuleInputs(sym: Symbol): Symbol[] | null {
    const merger = this.rules_.get(sym);
    if (!merger || merger.rules.length === 0) return null;

    const inputs: Symbol[] = [];
    for (const rule of merger.rules) {
      inputs.push(...rule.inputs);
    }
    return inputs;
  }

  private lookupRuleMerger(output: Symbol): RuleMerger | null {
    return this.rules_.get(output) || null;
  }

  private lookupRuleVars(output: Symbol): DepVars | null {
    return this.rule_vars_.get(output) || null;
  }

  build(ev: Evaluator, targets: Symbol[]): NamedDepNode[] {
    if (!this.first_rule_) {
      throw new Error('*** No targets.');
    }

    const targetList = targets.length > 0 ? targets : [this.first_rule_];
    const nodes: NamedDepNode[] = [];

    for (const target of targetList) {
      const node = this.buildPlan(ev, target, '');
      nodes.push({name: target, node});
    }

    return nodes;
  }

  private buildPlan(ev: Evaluator, output: Symbol, neededBy: Symbol): DepNode {
    const existing = this.done_.get(output);
    if (existing) {
      return existing;
    }

    const node: DepNode = {
      output,
      has_rule: false,
      is_default_target: false,
      is_phony: this.phony_.has(output),
      is_restat: this.restat_.has(output),
      rule_vars: null,
      depfile_var: null,
      ninja_pool_var: null,
      tags_var: null,
      cmds: [],
      actual_inputs: [],
      actual_order_only_inputs: [],
      actual_validations: [],
      implicit_outputs: [],
      deps: [],
      order_onlys: [],
      validations: [],
      output_pattern: null,
      loc: {filename: '<unknown>', lineno: 0},
    };

    this.done_.set(output, node);

    // Rule selection logic would go here
    const ruleMerger = this.lookupRuleMerger(output);
    if (ruleMerger) {
      ruleMerger.fillDepNode(output, null, node);
    }

    // Populate rule-specific variables
    const ruleVars = this.lookupRuleVars(output);
    if (ruleVars && ruleVars.size > 0) {
      node.rule_vars = new Vars();
      for (const [name, var_] of ruleVars) {
        node.rule_vars.set(name, var_);
      }
    }

    ev.withScope(scope => {
      node.rule_vars?.forEach((value, key) => {
        scope.set(key, value);
      });

      // Recursively build dependencies
      for (const input of node.actual_inputs) {
        const depNode = this.buildPlan(ev, input, output);
        node.deps.push({input, node: depNode});
      }

      for (const orderOnly of node.actual_order_only_inputs) {
        const depNode = this.buildPlan(ev, orderOnly, output);
        node.order_onlys.push({input: orderOnly, node: depNode});
      }

      for (const validation of node.actual_validations) {
        const depNode = this.buildPlan(ev, validation, output);
        node.validations.push({input: validation, node: depNode});
      }
    });

    node.has_rule = true;
    node.is_default_target = this.first_rule_ === output;

    return node;
  }
}
