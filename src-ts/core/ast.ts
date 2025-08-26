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

enum RuleSep {
    NULL = 'NULL',
    SEMICOLON = 'SEMICOLON',
    EQ = 'EQ',
    FINALEQ = 'FINALEQ'
}

class Context {
    private variables: Map<string, any> = new Map();

    set(name: string, value: any) {
        this.variables.set(name, value);
    }

    get(name: string): any {
        return this.variables.get(name);
    }
}

abstract class Value {
    constructor(public loc: Loc) {}
    
    abstract eval(ctx: Context): string;
    abstract isFunc(ctx: Context): boolean;
    abstract isLiteral(): boolean;
    abstract getLiteralValueUnsafe(): string;
    abstract debugString(): string;
}

class Literal extends Value {
    constructor(loc: Loc, private s: string) {
        super(loc);
    }
    
    eval(_ctx: Context): string {
        return this.s;
    }
    
    isFunc(_ctx: Context): boolean {
        return false;
    }
    
    isLiteral(): boolean {
        return true;
    }
    
    getLiteralValueUnsafe(): string {
        return this.s;
    }
    
    debugString(): string {
        return this.s;
    }
}

class ValueList extends Value {
    constructor(loc: Loc, private values: Value[]) {
        super(loc);
    }
    
    eval(ctx: Context): string {
        return this.values.map(v => v.eval(ctx)).join('');
    }
    
    isFunc(ctx: Context): boolean {
        return this.values.some(v => v.isFunc(ctx));
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
    
    eval(ctx: Context): string {
        // Will need proper ctx implementation
        return `\${${this.name}}`;
    }
    
    isFunc(_ctx: Context): boolean {
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
    
    eval(ctx: Context): string {
        const name = this.nameExpr.eval(ctx);
        // Will need proper ctx implementation
        return `\${${name}}`;
    }
    
    isFunc(_ctx: Context): boolean {
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
    
    eval(ctx: Context): string {
        const name = this.nameExpr.eval(ctx);
        const pat = this.pattern.eval(ctx);
        const sub = this.subst.eval(ctx);
        // Will need proper pattern substitution implementation
        return `\${${name}:${pat}=${sub}}`;
    }
    
    isFunc(ctx: Context): boolean {
        return this.nameExpr.isFunc(ctx) || this.pattern.isFunc(ctx) || this.subst.isFunc(ctx);
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
    
    constructor(loc: Loc, private name: string, private arity: number = 0, private minArity: number = 0) {
        super(loc);
    }
    
    addArg(arg: Value): void {
        this.args.push(arg);
    }
    
    eval(ctx: Context): string {
        const argStrs = this.args.map(arg => arg.eval(ctx));
        // Will need proper function implementation
        return `\$(${this.name} ${argStrs.join(',')})`;
    }
    
    isFunc(_ctx: Context): boolean {
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
    eval(ctx: Context): void;
}

class RuleStmt implements Stmt {
    constructor(
        public loc: Loc,
        public lhs: Expr,
        public sep: RuleSep,
        public rhs: Expr | null = null,
        public orig?: string
    ) {}

    eval(ctx: Context): void {
        // Implementation will be added later
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

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class CommandStmt implements Stmt {
    constructor(
        public loc: Loc,
        public expr: Expr,
        public orig?: string
    ) {}

    eval(ctx: Context): void {
        // Implementation will be added later
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

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class IncludeStmt implements Stmt {
    constructor(
        public loc: Loc,
        public expr: Expr,
        public should_exist: boolean,
        public orig?: string
    ) {}

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class ExportStmt implements Stmt {
    constructor(
        public loc: Loc,
        public expr: Expr,
        public is_export: boolean,
        public orig?: string
    ) {}

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

export { Loc, AssignOp, AssignDirective, RuleSep, CondOp, Context, Expr, Value, Literal, ValueList, SymRef, VarRef, VarSubst, Func, Stmt, RuleStmt, AssignStmt, CommandStmt, IfStmt, IncludeStmt, ExportStmt };

export class ParseErrorStmt implements Stmt {
    constructor(
        public loc: Loc,
        public msg: string,
        public orig?: string
    ) {}

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}