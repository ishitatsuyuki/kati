import { Pattern, joinStrings, splitSpace } from '../utils/strutil';
import { getFuncInfo } from './func.js';

interface Loc {
    filename: string;
    lineno: number;
}

enum AssignOp {
    EQ = 'EQ',
    COLON_EQ = 'COLON_EQ',
    PLUS_EQ = 'PLUS_EQ',
    QUESTION_EQ = 'QUESTION_EQ'
}

enum AssignDirective {
    NONE = 0,
    OVERRIDE = 1,
    EXPORT = 2
}

enum CondOp {
    IFEQ = 'IFEQ',
    IFNEQ = 'IFNEQ', 
    IFDEF = 'IFDEF',
    IFNDEF = 'IFNDEF'
}

enum ParseExprOpt {
    NORMAL = 0,
    DEFINE = 1,
    COMMAND = 2,
    FUNC = 3
}

enum RuleSep {
    NULL = 'NULL',
    SEMICOLON = 'SEMICOLON',
    EQ = 'EQ',
    FINALEQ = 'FINALEQ'
}

export class Evaluator {
    private variables: Map<string, any> = new Map();
    private _loc: Loc = { filename: '<unknown>', lineno: 0 };
    private _eval_depth: number = 0;

    set(name: string, value: any) {
        this.variables.set(name, value);
    }

    get(name: string): any {
        return this.variables.get(name);
    }

    // Evaluator interface implementation
    error(msg: string): never {
        throw new Error(msg);
    }

    lookupVar(name: string): any {
        return this.variables.get(name);
    }

    avoid_io(): boolean {
        // TODO: Implement proper IO avoidance logic
        return false;
    }

    loc(): Loc {
        return this._loc;
    }

    getShell(): string {
        return process.env.SHELL || '/bin/sh';
    }

    getShellFlag(): string {
        return '-c';
    }

    eval_depth(): number {
        return this._eval_depth;
    }

    setLoc(loc: Loc): void {
        this._loc = loc;
    }

    incrementEvalDepth(): void {
        this._eval_depth++;
    }

    decrementEvalDepth(): void {
        this._eval_depth--;
    }
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
    constructor(loc: Loc, private s: string) {
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
    constructor(loc: Loc, private values: Value[]) {
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
    constructor(loc: Loc, private name: string) {
        super(loc);
    }
    
    eval(ev: Evaluator): string {
        // Will need proper ev implementation
        return ev.get(this.name);
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
    constructor(loc: Loc, private nameExpr: Value) {
        super(loc);
    }
    
    eval(ev: Evaluator): string {
        const name = this.nameExpr.eval(ev);
        return ev.get(name);
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
    constructor(loc: Loc, private nameExpr: Value, private pattern: Value, private subst: Value) {
        super(loc);
    }
    
    eval(ev: Evaluator): string {
        const name = this.nameExpr.eval(ev);
        const pat = this.pattern.eval(ev);
        const sub = this.subst.eval(ev);
        
        const varValue = ev.get(name) || '';
        if (!varValue) {
            return '';
        }
        
        const pattern = new Pattern(pat);
        const words = splitSpace(varValue);
        const transformedWords = words.map((word: string) => pattern.appendSubst(word, sub));
        
        return joinStrings(transformedWords, ' ');
    }
    
    isFunc(ev: Evaluator): boolean {
        return this.nameExpr.isFunc(ev) || this.pattern.isFunc(ev) || this.subst.isFunc(ev);
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
    
    constructor(loc: Loc, private name: string, private _arity: number = 0, private _minArity: number = 0) {
        super(loc);
    }
    
    addArg(arg: Value): void {
        this.args.push(arg);
    }
    
    eval(ev: Evaluator): string {
        const funcInfo = getFuncInfo(this.name);
        if (!funcInfo) {
            throw new Error(`Unknown function: ${this.name}`);
        }

        // Check argument count
        if (funcInfo.hasVariadicArgs) {
            if (this.args.length < funcInfo.minArgs) {
                throw new Error(`Function ${this.name} expects at least ${funcInfo.minArgs} arguments, got ${this.args.length}`);
            }
        } else {
            if (this.args.length < funcInfo.minArgs || this.args.length > funcInfo.maxArgs) {
                throw new Error(`Function ${this.name} expects ${funcInfo.minArgs}-${funcInfo.maxArgs} arguments, got ${this.args.length}`);
            }
        }

        // Call the function implementation
        try {
            return funcInfo.func(this.args, ev);
        } catch (error) {
            throw new Error(`Error in function ${this.name}: ${error}`);
        }
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
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
    }
    
    debugString(): string {
        const rhsStr = this.rhs ? ` ${this.sep} ${this.rhs.debugString()}` : ``;
        return `RuleStmt(${this.lhs.debugString()}${rhsStr})`;
    }
}

class AssignStmt implements Stmt {
    constructor(
        public loc: Loc,
        public lhs: Expr,
        public rhs: Expr,
        public orig_rhs: string,
        public op: AssignOp,
        public directive: AssignDirective = AssignDirective.NONE,
        public is_final: boolean = false,
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
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
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
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
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
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
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
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
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
    }
    
    debugString(): string {
        const prefix = this.is_export ? 'export' : 'unexport';
        return `ExportStmt(${prefix} ${this.expr.debugString()})`;
    }
}

export { Loc, AssignOp, AssignDirective, RuleSep, CondOp, ParseExprOpt, Evaluator as Context, Expr, Value, Literal, ValueList, SymRef, VarRef, VarSubst, Func, Stmt, RuleStmt, AssignStmt, CommandStmt, IfStmt, IncludeStmt, ExportStmt };

export class ParseErrorStmt implements Stmt {
    constructor(
        public loc: Loc,
        public msg: string,
        public orig?: string
    ) {}

    eval(_ev: Evaluator): void {
        // Implementation will be added later
    }
    
    debugString(): string {
        return `ParseErrorStmt(${this.msg})`;
    }
}