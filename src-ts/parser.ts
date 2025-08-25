import { Stmt, Loc, AssignDirective, CommandStmt, ParseErrorStmt } from './core/ast';

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
        let pos = this.l;
        while (pos < this.buf.length && this.buf[pos] !== '\n') {
            pos++;
        }
        return pos;
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
        const prefix = line.substring(0, Math.min(line.length, Parser.longestDirectiveLen + 1));
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
        // TODO: Implement rule and assignment parsing
        // This is where we'll determine if a line is a rule or assignment
        // and create the appropriate AST node
    }

    private error(msg: string): void {
        const stmt = new ParseErrorStmt(this.loc, msg);
        this.outStmts.push(stmt);
    }
}