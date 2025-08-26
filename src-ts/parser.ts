import { Stmt, Loc, AssignDirective, CommandStmt, ParseErrorStmt, RuleStmt, AssignStmt, RuleSep, AssignOp } from './core/ast';
import { StrUtil } from './utils/strutil';

type DirectiveHandler = (line: string, directive: string) => void;

interface IfState {
    stmt: any; // Will be IfStmt when implemented
    isInElse: boolean;
    numNest: number;
}

export class Parser {
    private buf: string;
    private stmts: Stmt[];
    private outStmts: Stmt[];
    private loc: Loc;
    private l: number = 0;
    private fixedLineno: boolean = false;
    private currentDirective: AssignDirective = AssignDirective.NONE;
    private afterRule: boolean = false;
    private ifStack: IfState[] = [];
    private defineName: string = '';
    private origLineWithDirectives: string = '';

    private static readonly makeDirectives: Map<string, DirectiveHandler> = new Map([
        ['include', (line, directive) => { /* TODO */ }],
        ['-include', (line, directive) => { /* TODO */ }], 
        ['sinclude', (line, directive) => { /* TODO */ }],
        ['define', (line, directive) => { /* TODO */ }],
        ['ifdef', (line, directive) => { /* TODO */ }],
        ['ifndef', (line, directive) => { /* TODO */ }],
        ['ifeq', (line, directive) => { /* TODO */ }],
        ['ifneq', (line, directive) => { /* TODO */ }],
        ['else', (line, directive) => { /* TODO */ }],
        ['endif', (line, directive) => { /* TODO */ }],
        ['override', (line, directive) => { /* TODO */ }],
        ['export', (line, directive) => { /* TODO */ }]
    ]);

    private static readonly shortestDirectiveLen: number = Math.min(
        ...Array.from(Parser.makeDirectives.keys()).map(k => k.length)
    );

    private static readonly longestDirectiveLen: number = Math.max(
        ...Array.from(Parser.makeDirectives.keys()).map(k => k.length)
    );

    constructor(buf: string, filename: string, stmts: Stmt[]);
    constructor(buf: string, loc: Loc, stmts: Stmt[]);
    constructor(buf: string, filenameOrLoc: string | Loc, stmts: Stmt[]) {
        this.buf = buf;
        this.stmts = stmts;
        this.outStmts = stmts;
        
        if (typeof filenameOrLoc === 'string') {
            this.loc = { filename: filenameOrLoc, lineno: 0 };
            this.fixedLineno = false;
        } else {
            this.loc = { ...filenameOrLoc };
            this.fixedLineno = true;
        }
    }

    parse(): void {
        for (this.l = 0; this.l < this.buf.length;) {
            let lfCnt = 0;
            const e = this.findEndOfLine();
            
            if (!this.fixedLineno) {
                this.loc.lineno++;
            }
            
            let line = this.buf.substring(this.l, e);
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            
            this.origLineWithDirectives = line;
            this.parseLine(line);
            
            if (!this.fixedLineno) {
                this.loc.lineno += lfCnt - 1;
            }
            
            if (e === this.buf.length) {
                break;
            }
            
            this.l = e + 1;
        }

        if (this.ifStack.length > 0) {
            this.error("*** missing `endif'.");
        }
        if (this.defineName !== '') {
            this.error("*** missing `endef', unterminated `define'.");
        }
    }

    private findEndOfLine(): number {
        const newlinePos = this.buf.indexOf('\n', this.l);
        return newlinePos === -1 ? this.buf.length : newlinePos;
    }

    private trimLeftSpace(line: string): string {
        return line.replace(/^[ \t]+/, '');
    }

    private parseLine(line: string): void {
        if (this.defineName !== '') {
            this.parseInsideDefine(line);
            return;
        }

        if (line === '' || line === '\r') {
            return;
        }

        this.currentDirective = AssignDirective.NONE;

        if (line[0] === '\t' && this.afterRule) {
            const stmt = new CommandStmt(
                this.loc,
                line, // Will need proper expression parsing later
                line
            );
            this.outStmts.push(stmt);
            return;
        }

        line = this.trimLeftSpace(line);

        if (line[0] === '#') {
            return;
        }

        if (this.handleDirective(line, Parser.makeDirectives)) {
            return;
        }

        this.parseRuleOrAssign(line);
    }

    private parseInsideDefine(line: string): void {
        // TODO: Implement define parsing
    }

    private getDirective(line: string): string {
        const prefix = line.substring(0, Parser.longestDirectiveLen + 1);
        const spaceIndex = prefix.search(/[ \t#]/);
        return spaceIndex === -1 ? prefix : prefix.substring(0, spaceIndex);
    }

    private handleDirective(line: string, directiveMap: Map<string, DirectiveHandler>): boolean {
        const directive = this.getDirective(line);
        const handler = directiveMap.get(directive);
        
        if (!handler) {
            return false;
        }

        handler.call(this, line, directive);
        return true;
    }

    private parseRuleOrAssign(line: string): void {
        const sep = StrUtil.findThreeOutsideParen(line, ':', '=', ';');
        
        if (sep === -1 || line[sep] === ';') {
            this.parseRule(line, -1);
        } else if (line[sep] === '=') {
            this.parseAssign(line, sep);
        } else if (sep + 1 < line.length && line[sep + 1] === '=') {
            this.parseAssign(line, sep + 1);
        } else if (line[sep] === ':') {
            this.parseRule(line, sep);
        } else {
            throw new Error('Invalid parsing state');
        }
    }

    private parseExpr(_loc: Loc, s: string): any {
        // Placeholder implementation - will be replaced with proper expression parsing
        return s;
    }

    private parseRule(line: string, sep: number): void {
        if (this.currentDirective !== AssignDirective.NONE) {
            if (this.isInExport()) {
                return;
            }
            if (sep !== -1) {
                sep += this.origLineWithDirectives.length - line.length;
            }
            line = this.origLineWithDirectives;
        }

        line = StrUtil.trimLeftSpace(line);
        if (line.length === 0) {
            return;
        }

        if (this.origLineWithDirectives[0] === '\t') {
            this.error("*** commands commence before first target.");
            return;
        }

        const ruleStmt = new RuleStmt(this.loc, '', RuleSep.NULL, null);
        
        if (sep === -1) {
            // No separator found - just a target
            ruleStmt.lhs = this.parseExpr(this.loc, line);
            ruleStmt.sep = RuleSep.NULL;
            ruleStmt.rhs = null;
        } else {
            // Find additional separators in the part after the colon
            const found = StrUtil.findTwoOutsideParen(line.substring(sep + 1), '=', ';');
            
            if (found !== -1) {
                const foundPos = found + sep + 1;
                ruleStmt.lhs = this.parseExpr(this.loc, StrUtil.trimSpace(line.substring(0, foundPos)));
                
                if (line[foundPos] === ';') {
                    ruleStmt.sep = RuleSep.SEMICOLON;
                } else if (line[foundPos] === '=') {
                    if (line.length > (foundPos + 2) && 
                        line[foundPos + 1] === '$' && 
                        line[foundPos + 2] === '=') {
                        ruleStmt.sep = RuleSep.FINALEQ;
                        ruleStmt.rhs = this.parseExpr(this.loc, StrUtil.trimLeftSpace(line.substring(foundPos + 3)));
                    } else {
                        ruleStmt.sep = RuleSep.EQ;
                        ruleStmt.rhs = this.parseExpr(this.loc, StrUtil.trimLeftSpace(line.substring(foundPos + 1)));
                    }
                }
            } else {
                ruleStmt.lhs = this.parseExpr(this.loc, line);
                ruleStmt.sep = RuleSep.NULL;
                ruleStmt.rhs = null;
            }
        }
        
        this.outStmts.push(ruleStmt);
        this.afterRule = true;
    }

    private parseAssignStatement(line: string, sep: number): { lhs: string, rhs: string, op: AssignOp } {
        if (sep === 0) {
            throw new Error("*** empty variable name ***");
        }
        
        let op = AssignOp.EQ;
        let lhsEnd = sep;
        
        switch (line[sep - 1]) {
            case ':':
                lhsEnd--;
                op = AssignOp.COLON_EQ;
                break;
            case '+':
                lhsEnd--;
                op = AssignOp.PLUS_EQ;
                break;
            case '?':
                lhsEnd--;
                op = AssignOp.QUESTION_EQ;
                break;
        }
        
        const lhs = StrUtil.trimSpace(line.substring(0, lhsEnd));
        const rhs = StrUtil.trimLeftSpace(line.substring(Math.min(sep + 1, line.length)));
        
        return { lhs, rhs, op };
    }

    private parseAssign(line: string, separatorPos: number): void {
        if (separatorPos === 0) {
            this.error("*** empty variable name ***");
            return;
        }

        const { lhs, rhs: rawRhs, op } = this.parseAssignStatement(line, separatorPos);

        // Check for final assignment ($=)
        let rhs = rawRhs;
        const isFinal = (rhs.length >= 2 && rhs[0] === '$' && rhs[1] === '=');
        if (isFinal) {
            rhs = StrUtil.trimLeftSpace(rhs.substring(2));
        }

        const stmt = new AssignStmt(
            this.loc,
            this.parseExpr(this.loc, lhs),
            this.parseExpr(this.loc, rhs),
            rhs,
            op,
            this.currentDirective,
            isFinal
        );
        
        this.outStmts.push(stmt);
        this.afterRule = false;
    }

    private isInExport(): boolean {
        return (this.currentDirective & AssignDirective.EXPORT) !== 0;
    }

    private error(msg: string): void {
        const stmt = new ParseErrorStmt(this.loc, msg);
        this.outStmts.push(stmt);
    }
}