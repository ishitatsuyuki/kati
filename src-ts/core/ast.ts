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

// stub
type Expr = {}

function parseExpr(line: string): Expr {

}

interface Stmt {
    loc: Loc;
    orig?: string | undefined;
    eval(ctx: Context): void;
}

class RuleStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    lhs: Expr;
    sep: RuleSep;
    rhs: Expr | null;

    constructor(loc: Loc, lhs: Expr, sep: RuleSep, rhs: Expr | null = null, orig?: string) {
        this.loc = loc;
        this.lhs = lhs;
        this.sep = sep;
        this.rhs = rhs;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class AssignStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    lhs: Expr;
    rhs: Expr;
    orig_rhs: string;
    op: AssignOp;
    directive: AssignDirective;
    is_final: boolean;

    constructor(
        loc: Loc,
        lhs: Expr,
        rhs: Expr,
        orig_rhs: string,
        op: AssignOp,
        directive: AssignDirective = AssignDirective.NONE,
        is_final: boolean = false,
        orig?: string
    ) {
        this.loc = loc;
        this.lhs = lhs;
        this.rhs = rhs;
        this.orig_rhs = orig_rhs;
        this.op = op;
        this.directive = directive;
        this.is_final = is_final;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class CommandStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    expr: Expr;

    constructor(loc: Loc, expr: Expr, orig?: string) {
        this.loc = loc;
        this.expr = expr;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class IfStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    op: CondOp;
    lhs: Expr;
    rhs: Expr | null;
    true_stmts: Stmt[];
    false_stmts: Stmt[];

    constructor(
        loc: Loc,
        op: CondOp,
        lhs: Expr,
        rhs: Expr | null = null,
        orig?: string
    ) {
        this.loc = loc;
        this.op = op;
        this.lhs = lhs;
        this.rhs = rhs;
        this.true_stmts = [];
        this.false_stmts = [];
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class IncludeStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    expr: Expr;
    should_exist: boolean;

    constructor(loc: Loc, expr: Expr, should_exist: boolean, orig?: string) {
        this.loc = loc;
        this.expr = expr;
        this.should_exist = should_exist;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class ExportStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    expr: Expr;
    is_export: boolean;

    constructor(loc: Loc, expr: Expr, is_export: boolean, orig?: string) {
        this.loc = loc;
        this.expr = expr;
        this.is_export = is_export;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}

class ParseErrorStmt implements Stmt {
    loc: Loc;
    orig?: string | undefined;
    msg: string;

    constructor(loc: Loc, msg: string, orig?: string) {
        this.loc = loc;
        this.msg = msg;
        this.orig = orig;
    }

    eval(ctx: Context): void {
        // Implementation will be added later
    }
}