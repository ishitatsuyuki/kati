import {
  AssignDirective,
  AssignOp,
  AssignStmt,
  CommandStmt,
  CondOp,
  ExportStmt,
  Expr,
  Func,
  IfStmt,
  IncludeStmt,
  Literal,
  ParseErrorStmt,
  ParseExprOpt,
  RuleSep,
  RuleStmt,
  Stmt,
  SymRef,
  Value,
  ValueList,
  VarRef,
  VarSubst,
} from './ast';
import {Loc, MutableLoc} from './evaluator';
import {StrUtil} from './strutil';
import {FuncInfo, getFuncInfo} from './func';

type DirectiveHandler = (line: string, directive: string) => void;

interface IfState {
  stmt: IfStmt;
  isInElse: boolean;
  numNest: number;
}

export class Parser {
  private buf: string;
  private stmts: Stmt[];
  private outStmts: Stmt[];
  private mutableLoc: MutableLoc;
  private l = 0;
  private fixedLineno = false;
  private currentDirective: AssignDirective = AssignDirective.NONE;
  private afterRule = false;
  private ifStack: IfState[] = [];
  private defineName = '';
  private origLineWithDirectives = '';

  // Additional state properties for directive handling
  private numDefineNest = 0;
  private defineStart = 0;
  private defineStartLine = 0;
  private numIfNest = 0;

  private readonly makeDirectives: Map<string, DirectiveHandler> = new Map([
    ['include', this.parseInclude.bind(this)],
    ['-include', this.parseInclude.bind(this)],
    ['sinclude', this.parseInclude.bind(this)],
    ['define', this.parseDefine.bind(this)],
    ['ifdef', this.parseIfdef.bind(this)],
    ['ifndef', this.parseIfdef.bind(this)],
    ['ifeq', this.parseIfeq.bind(this)],
    ['ifneq', this.parseIfeq.bind(this)],
    ['else', this.parseElse.bind(this)],
    ['endif', this.parseEndif.bind(this)],
    ['override', this.parseOverride.bind(this)],
    ['export', this.parseExport.bind(this)],
    ['unexport', this.parseUnexport.bind(this)],
  ]);

  private readonly elseIfDirectives: Map<string, DirectiveHandler> = new Map([
    ['ifdef', this.parseIfdef.bind(this)],
    ['ifndef', this.parseIfdef.bind(this)],
    ['ifeq', this.parseIfeq.bind(this)],
    ['ifneq', this.parseIfeq.bind(this)],
  ]);

  private readonly assignDirectives: Map<string, DirectiveHandler> = new Map([
    ['define', this.parseDefine.bind(this)],
    ['export', this.parseExport.bind(this)],
    ['override', this.parseOverride.bind(this)],
  ]);

  private readonly shortestDirectiveLen: number = Math.min(
    ...Array.from(this.makeDirectives.keys()).map(k => k.length),
  );

  private readonly longestDirectiveLen: number = Math.max(
    ...Array.from(this.makeDirectives.keys()).map(k => k.length),
  );

  loc(): Loc {
    return Object.freeze({...this.mutableLoc});
  }

  constructor(buf: string, filename: string, stmts: Stmt[]);
  constructor(buf: string, loc: Loc, stmts: Stmt[]);
  constructor(buf: string, filenameOrLoc: string | Loc, stmts: Stmt[]) {
    this.buf = buf;
    this.stmts = stmts;
    this.outStmts = stmts;

    if (typeof filenameOrLoc === 'string') {
      this.mutableLoc = {filename: filenameOrLoc, lineno: 0};
      this.fixedLineno = false;
    } else {
      this.mutableLoc = {...filenameOrLoc};
      this.fixedLineno = true;
    }
  }

  parse(): void {
    for (this.l = 0; this.l < this.buf.length; ) {
      const {pos: e, lfCount: lfCnt} = this.findEndOfLine();

      if (!this.fixedLineno) {
        this.mutableLoc.lineno++;
      }

      let line = this.buf.substring(this.l, e);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      this.origLineWithDirectives = line;
      this.parseLine(line);

      if (!this.fixedLineno) {
        this.mutableLoc.lineno += lfCnt - 1;
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

  private findEndOfLine(): {pos: number; lfCount: number} {
    let e = this.l;
    let lfCount = 0;

    while (e < this.buf.length) {
      // Find next newline or backslash
      const nextSpecial = this.buf.substring(e).search(/[\n\\]/);
      if (nextSpecial === -1) {
        // No more special characters, end of buffer
        break;
      }

      e += nextSpecial;
      if (e >= this.buf.length) {
        break;
      }

      const c = this.buf[e];
      if (c === '\\') {
        if (e + 1 < this.buf.length) {
          const next = this.buf[e + 1];
          if (next === '\n') {
            // Escaped newline - skip both characters
            e += 2;
            lfCount++;
          } else if (
            next === '\r' &&
            e + 2 < this.buf.length &&
            this.buf[e + 2] === '\n'
          ) {
            // Escaped Windows newline - skip all three characters
            e += 3;
            lfCount++;
          } else if (next === '\\') {
            // Double backslash - skip both but don't treat as line continuation
            e += 2;
          } else {
            // Single backslash with other character
            e++;
          }
        } else {
          // Backslash at end of buffer
          e++;
        }
      } else if (c === '\n') {
        // Unescaped newline - this is the end of line
        lfCount++;
        return {pos: e, lfCount};
      }
    }

    return {pos: e, lfCount};
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
        this.loc(),
        this.parseExpr(
          {...this.mutableLoc},
          line.substring(1),
          ParseExprOpt.COMMAND,
        ),
        line,
      );
      this.outStmts.push(stmt);
      return;
    }

    line = this.trimLeftSpace(line);

    if (line[0] === '#') {
      return;
    }

    if (this.handleDirective(line, this.makeDirectives)) {
      return;
    }

    this.parseRuleOrAssign(line);
  }

  private parseInsideDefine(line: string): void {
    const trimmedLine = StrUtil.trimLeftSpace(line);
    const directive = this.getDirective(trimmedLine);

    if (directive === 'define') {
      this.numDefineNest++;
    } else if (directive === 'endef') {
      this.numDefineNest--;
    }

    if (this.numDefineNest > 0) {
      if (this.defineStart === 0) {
        this.defineStart = this.l;
      }
      return;
    }

    // Handle endef
    const rest = StrUtil.trimRightSpace(
      StrUtil.removeComment(StrUtil.trimLeftSpace(line.substring(5))), // 5 = 'endef'.length
    );
    if (rest !== '') {
      this.error("extraneous text after 'endef' directive");
    }

    const stmt = new AssignStmt(
      {filename: this.loc().filename, lineno: this.defineStartLine},
      this.parseExpr({...this.mutableLoc}, this.defineName),
      this.parseExpr(
        {...this.mutableLoc},
        this.defineStart
          ? this.buf.substring(this.defineStart, this.l - 1)
          : '',
        ParseExprOpt.DEFINE,
      ),
      this.defineStart ? this.buf.substring(this.defineStart, this.l - 1) : '',
      AssignOp.EQ,
      this.currentDirective,
      false,
    );

    this.outStmts.push(stmt);
    this.defineName = '';
  }

  private getDirective(line: string): string {
    const prefix = line.substring(0, this.longestDirectiveLen + 1);
    const spaceIndex = prefix.search(/[ \t#]/);
    return spaceIndex === -1 ? prefix : prefix.substring(0, spaceIndex);
  }

  private handleDirective(
    line: string,
    directiveMap: Map<string, DirectiveHandler>,
  ): boolean {
    const directive = this.getDirective(line);
    const handler = directiveMap.get(directive);

    if (!handler) {
      return false;
    }

    const lineWithoutDirective = StrUtil.trimLeftSpace(
      line.substring(directive.length),
    );
    handler.call(this, lineWithoutDirective, directive);
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

  private parseExpr(
    loc: MutableLoc,
    s: string,
    opt: ParseExprOpt = ParseExprOpt.NORMAL,
  ): Expr {
    return this.parseExprImpl(loc, s, null, opt).expr;
  }

  private parseExprImpl(
    loc: MutableLoc,
    s: string,
    terms: string[] | null,
    opt: ParseExprOpt = ParseExprOpt.NORMAL,
    trimRightSpace = false,
  ): {expr: Expr; index: number} {
    const listLoc = Object.freeze({...loc});

    // Remove carriage return if present
    if (s.endsWith('\r')) {
      s = s.slice(0, -1);
    }

    let b = 0;
    let saveParenChar = '';
    let parenDepth = 0;
    let i = 0;
    const list: Value[] = [];

    for (i = 0; i < s.length; i++) {
      const itemLoc = Object.freeze({...loc});
      const c = s[i];

      // Check for termination characters
      if (terms && terms.includes(c) && !saveParenChar) {
        break;
      }

      // Handle comments
      if (!terms && c === '#' && this.shouldHandleComments(opt)) {
        if (i > b) {
          list.push(new Literal(itemLoc, s.substring(b, i)));
        }
        let wasBackslash = false;
        for (; i < s.length && !(s[i] === '\n' && !wasBackslash); i++) {
          wasBackslash = !wasBackslash && s[i] === '\\';
        }
        return {expr: this.newExpr(itemLoc, list), index: i};
      }

      // Handle dollar variables and functions
      if (c === '$') {
        if (i + 1 >= s.length) {
          break;
        }
        if (i > b) {
          list.push(new Literal(itemLoc, s.substring(b, i)));
        }
        if (s[i + 1] === '$') {
          // Escaped dollar
          list.push(new Literal(itemLoc, '$'));
          i += 1;
          b = i + 1;
          continue;
        }
        if (terms && terms.includes(s[i + 1])) {
          list.push(new Literal(itemLoc, '$'));
          return {expr: this.newExpr(itemLoc, list), index: i + 1};
        }
        const dollarResult = this.parseDollar(loc, s.substring(i));
        list.push(dollarResult.expr);
        i += dollarResult.index;
        b = i;
        i--;
        continue;
      }

      // Handle parentheses in function context
      if ((c === '(' || c === '{') && opt === ParseExprOpt.FUNC) {
        const cp = this.closeParen(c);
        if (terms && terms.length > 0 && terms[0] === cp) {
          parenDepth++;
          saveParenChar = cp;
          terms = terms.slice(1);
        } else if (cp === saveParenChar) {
          parenDepth++;
        }
        continue;
      }

      if (c === saveParenChar) {
        parenDepth--;
        if (parenDepth === 0) {
          terms = [saveParenChar, ...(terms || [])];
          saveParenChar = '';
        }
      }

      // Handle backslashes (but not in command context)
      if (c === '\\' && i + 1 < s.length && opt !== ParseExprOpt.COMMAND) {
        const n = s[i + 1];
        if (n === '\\') {
          i++;
          continue;
        }
        if (n === '#' && this.shouldHandleComments(opt)) {
          list.push(new Literal(itemLoc, s.substring(b, i)));
          i++;
          b = i;
          continue;
        }
        if (n === '\r' || n === '\n') {
          loc.lineno++;
          if (terms && terms.includes(' ')) {
            break;
          }
          if (i > b) {
            list.push(
              new Literal(
                Object.freeze({...loc}),
                StrUtil.trimRightSpace(s.substring(b, i - b)),
              ),
            );
          }
          list.push(new Literal(Object.freeze({...loc}), ' '));
          i += 2;
          if (n === '\r' && i + 2 < s.length && s[i + 2] === '\n') {
            i++;
          }
          for (; i < s.length; i++) {
            if (
              s[i] === '\\' &&
              i + 1 < s.length &&
              (s[i + 1] === '\r' || s[i + 1] === '\n')
            ) {
              loc.lineno++;
              i++;
              continue;
            }
            if (s[i] !== ' ' && s[i] !== '\t') {
              break;
            }
          }
          b = i;
          i--;
        }
      }
    }

    // Add any remaining literal text
    if (i > b) {
      let rest = s.substring(b, i);
      if (trimRightSpace) {
        rest = StrUtil.trimRightSpace(rest);
      }
      if (rest.length > 0) {
        list.push(new Literal(listLoc, rest));
      }
    }

    return {expr: this.newExpr(listLoc, list), index: i};
  }

  private parseDollar(loc: Loc, s: string): {expr: Expr; index: number} {
    if (s.length < 2 || s[0] !== '$' || s[1] === '$') {
      throw new Error('Invalid dollar expression');
    }

    const startLoc = {...loc};
    const cp = this.closeParen(s[1]);

    if (!cp) {
      // Simple variable like $a
      return {expr: new SymRef(startLoc, s.substring(1, 2)), index: 2};
    }

    // Complex variable like ${var} or $(func)
    const terms = [cp, ':', ' '];
    let i = 2;

    /* eslint-disable-next-line no-constant-condition */
    while (true) {
      const vnameResult = this.parseExprImpl(
        loc,
        s.substring(i),
        terms,
        ParseExprOpt.NORMAL,
      );
      const vname = vnameResult.expr;
      i += vnameResult.index;

      if (s[i] === cp) {
        // Simple variable reference ${var}
        if (vname instanceof Literal) {
          const sym = vname.getLiteralValueUnsafe();
          return {expr: new SymRef(startLoc, sym), index: i + 1};
        }
        return {expr: new VarRef(startLoc, vname), index: i + 1};
      }

      if (s[i] === ' ' || s[i] === '\\') {
        // Function call ${func args}
        if (vname instanceof Literal) {
          const funcName = vname.getLiteralValueUnsafe();
          // TODO: Check if this is a valid function name
          const func = new Func(startLoc, funcName);
          const funcResult = this.parseFunc(loc, func, s, i + 1, [cp]);
          return {expr: func, index: funcResult};
        }
        // Not a function - continue parsing as variable
        i = 2;
        terms.splice(2, 1); // Remove ' ' from terms
        continue;
      }

      if (s[i] === ':') {
        // Variable substitution ${var:pattern=subst}
        terms.splice(2, 1); // Remove ' ' from terms
        terms[1] = '=';

        const patResult = this.parseExprImpl(
          loc,
          s.substring(i + 1),
          terms,
          ParseExprOpt.NORMAL,
        );
        const pat = patResult.expr;
        i += 1 + patResult.index;

        if (s[i] === cp) {
          // Just pattern without substitution ${var:pattern}
          const colonLit = new Literal(startLoc, ':');
          const combined = this.newExpr(startLoc, [vname, colonLit, pat]);
          return {expr: new VarRef(startLoc, combined), index: i + 1};
        }

        terms[1] = cp;
        const substResult = this.parseExprImpl(
          loc,
          s.substring(i + 1),
          terms,
          ParseExprOpt.NORMAL,
        );
        const subst = substResult.expr;
        i += 1 + substResult.index;

        return {expr: new VarSubst(startLoc, vname, pat, subst), index: i + 1};
      }

      // Handle unmatched parentheses case
      const found = s.indexOf(cp, i);
      if (found !== -1) {
        // Unmatched parentheses warning would go here
        return {
          expr: new SymRef(startLoc, s.substring(2, found)),
          index: s.length,
        };
      }

      throw new Error('Unterminated variable reference');
    }
  }

  private parseFunc(
    loc: Loc,
    func: Func,
    s: string,
    startIndex: number,
    terms: string[],
  ): number {
    let i = startIndex;
    let nargs = 1; // Functions have at least 1 argument (the function name itself is not counted)

    // Get function info to check arity limits
    const funcInfo = this.getFuncInfo(func);

    let funcTerms = [terms[0], ','];

    while (i < s.length) {
      // Skip whitespace
      if (s[i] === ' ' || s[i] === '\t') {
        i++;
        continue;
      }

      // Check if we should stop parsing due to arity limit
      if (funcInfo && funcInfo.arity > 0 && nargs >= funcInfo.arity) {
        // Stop parsing more arguments, but consume up to the closing delimiter
        funcTerms = [terms[0]];
      }

      const shouldTrimSpace = funcInfo?.trimSpace || false;
      const shouldTrimRightFirst = funcInfo?.trimRightFirst || false;
      const trimRightSpace =
        shouldTrimRightFirst && nargs === 1 ? true : shouldTrimSpace;

      const argResult = this.parseExprImpl(
        loc,
        s.substring(i),
        funcTerms,
        ParseExprOpt.FUNC,
        trimRightSpace,
      );
      func.addArg(argResult.expr);
      i += argResult.index;

      if (i === s.length) {
        throw new Error(`Unterminated call to function: missing '${terms[0]}'`);
      }

      nargs++;
      if (s[i] === terms[0]) {
        i++;
        break;
      }
      i++; // Should be ','
      if (i === s.length) {
        break;
      }
    }

    return i;
  }

  private getFuncInfo(func: Func): FuncInfo | null {
    const funcName = func.getName();
    return this.getFuncInfoByName(funcName);
  }

  private getFuncInfoByName(name: string): FuncInfo | null {
    return getFuncInfo(name);
  }

  private shouldHandleComments(opt: ParseExprOpt): boolean {
    return opt !== ParseExprOpt.DEFINE && opt !== ParseExprOpt.COMMAND;
  }

  private closeParen(c: string): string {
    switch (c) {
      case '(':
        return ')';
      case '{':
        return '}';
      default:
        return '';
    }
  }

  private newExpr(loc: Loc, values: Value[]): Expr {
    if (values.length === 0) {
      return new Literal(loc, '');
    } else if (values.length === 1) {
      return values[0];
    } else {
      return new ValueList(loc, values);
    }
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
      this.error('*** commands commence before first target.');
      return;
    }

    let lhs: Expr;
    let ruleSep: RuleSep;
    let rhs: Expr | null;

    if (sep === -1) {
      // No separator found - just a target
      lhs = this.parseExpr({...this.mutableLoc}, line);
      ruleSep = RuleSep.NULL;
      rhs = null;
    } else {
      // Find additional separators in the part after the colon
      const found = StrUtil.findTwoOutsideParen(
        line.substring(sep + 1),
        '=',
        ';',
      );

      if (found !== -1) {
        const foundPos = found + sep + 1;
        lhs = this.parseExpr(
          {...this.mutableLoc},
          StrUtil.trimSpace(line.substring(0, foundPos)),
        );

        if (line[foundPos] === ';') {
          ruleSep = RuleSep.SEMICOLON;
          rhs = null;
        } else if (line[foundPos] === '=') {
          if (
            line.length > foundPos + 2 &&
            line[foundPos + 1] === '$' &&
            line[foundPos + 2] === '='
          ) {
            ruleSep = RuleSep.FINALEQ;
            rhs = this.parseExpr(
              {...this.mutableLoc},
              StrUtil.trimLeftSpace(line.substring(foundPos + 3)),
            );
          } else {
            ruleSep = RuleSep.EQ;
            rhs = this.parseExpr(
              {...this.mutableLoc},
              StrUtil.trimLeftSpace(line.substring(foundPos + 1)),
            );
          }
        } else {
          ruleSep = RuleSep.NULL;
          rhs = null;
        }
      } else {
        lhs = this.parseExpr({...this.mutableLoc}, line);
        ruleSep = RuleSep.NULL;
        rhs = null;
      }
    }

    const ruleStmt = new RuleStmt(this.loc(), lhs, ruleSep, rhs);
    this.outStmts.push(ruleStmt);
    this.afterRule = true;
  }

  private parseAssignStatement(
    line: string,
    sep: number,
  ): {lhs: string; rhs: string; op: AssignOp} {
    if (sep === 0) {
      throw new Error('*** empty variable name ***');
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
    const rhs = StrUtil.trimLeftSpace(
      line.substring(Math.min(sep + 1, line.length)),
    );

    return {lhs, rhs, op};
  }

  private parseAssign(line: string, separatorPos: number): void {
    if (separatorPos === 0) {
      this.error('*** empty variable name ***');
      return;
    }

    const {
      lhs,
      rhs: rawRhs,
      op,
    } = this.parseAssignStatement(line, separatorPos);

    // Check for final assignment ($=)
    let rhs = rawRhs;
    const isFinal = rhs.length >= 2 && rhs[0] === '$' && rhs[1] === '=';
    if (isFinal) {
      rhs = StrUtil.trimLeftSpace(rhs.substring(2));
    }

    const stmt = new AssignStmt(
      this.loc(),
      this.parseExpr({...this.mutableLoc}, lhs),
      this.parseExpr({...this.mutableLoc}, rhs),
      rhs,
      op,
      this.currentDirective,
      isFinal,
    );

    this.outStmts.push(stmt);
    this.afterRule = false;
  }

  private isInExport(): boolean {
    return (this.currentDirective & AssignDirective.EXPORT) !== 0;
  }

  private error(msg: string): void {
    const stmt = new ParseErrorStmt(this.loc(), msg);
    this.outStmts.push(stmt);
  }

  private checkIfStack(keyword: string): boolean {
    if (this.ifStack.length === 0) {
      this.error(`*** extraneous '${keyword}'.`);
      return false;
    }
    return true;
  }

  private removeComment(line: string): string {
    return StrUtil.removeComment(line);
  }

  private enterIf(stmt: IfStmt): void {
    const st: IfState = {
      stmt: stmt,
      isInElse: false,
      numNest: this.numIfNest,
    };
    this.ifStack.push(st);
    this.outStmts = stmt.true_stmts;
  }

  private createExport(line: string, isExport: boolean): void {
    const stmt = new ExportStmt(
      this.loc(),
      this.parseExpr({...this.mutableLoc}, line),
      isExport,
    );
    this.outStmts.push(stmt);
  }

  // Directive parsing methods

  private parseInclude(line: string, directive: string): void {
    const stmt = new IncludeStmt(
      this.loc(),
      this.parseExpr({...this.mutableLoc}, line),
      directive[0] === 'i', // 'include' vs '-include' or 'sinclude'
    );
    this.outStmts.push(stmt);
    this.afterRule = false;
  }

  private parseDefine(line: string, directive: string): void {
    if (line === '') {
      this.error('*** empty variable name.');
      return;
    }
    this.defineName = line;
    this.numDefineNest = 1;
    this.defineStart = 0;
    this.defineStartLine = this.loc().lineno;
    this.afterRule = false;
  }

  private parseIfdef(line: string, directive: string): void {
    const stmt = new IfStmt(
      this.loc(),
      directive.startsWith('ifn') ? CondOp.IFNDEF : CondOp.IFDEF,
      this.parseExpr({...this.mutableLoc}, line),
      null,
    );
    this.outStmts.push(stmt);
    this.enterIf(stmt);
  }

  private parseIfeq(line: string, directive: string): void {
    const stmt = new IfStmt(
      this.loc(),
      directive.startsWith('ifneq') ? CondOp.IFNEQ : CondOp.IFEQ,
      new Literal(this.loc(), ''), // placeholder, will be set by parseIfEqCond
      null,
    );

    if (!this.parseIfEqCond(line, stmt)) {
      this.error('*** invalid syntax in conditional.');
      return;
    }

    this.outStmts.push(stmt);
    this.enterIf(stmt);
  }

  private parseElse(line: string, directive: string): void {
    if (!this.checkIfStack('else')) {
      return;
    }

    const st = this.ifStack[this.ifStack.length - 1];
    if (st.isInElse) {
      this.error("*** only one 'else' per conditional.");
      return;
    }

    st.isInElse = true;
    this.outStmts = st.stmt.false_stmts;

    const nextIf = StrUtil.trimLeftSpace(line);
    if (nextIf === '') {
      return;
    }

    this.numIfNest = st.numNest + 1;
    if (!this.handleDirective(nextIf, this.elseIfDirectives)) {
      this.error("extraneous text after 'else' directive");
    }
    this.numIfNest = 0;
  }

  private parseEndif(line: string, directive: string): void {
    if (!this.checkIfStack('endif')) {
      return;
    }

    if (line !== '') {
      this.error("extraneous text after 'endif' directive");
      return;
    }

    const numNest = this.ifStack[this.ifStack.length - 1].numNest;
    for (let i = 0; i <= numNest; i++) {
      this.ifStack.pop();
    }

    if (this.ifStack.length === 0) {
      this.outStmts = this.stmts;
    } else {
      const st = this.ifStack[this.ifStack.length - 1];
      if (st.isInElse) {
        this.outStmts = st.stmt.false_stmts;
      } else {
        this.outStmts = st.stmt.true_stmts;
      }
    }
  }

  private parseOverride(line: string, directive: string): void {
    this.currentDirective = AssignDirective.OVERRIDE | this.currentDirective;
    if (this.handleDirective(line, this.assignDirectives)) {
      return;
    }
    if (this.isInExport()) {
      this.createExport(line, true);
    }
    this.parseRuleOrAssign(line);
  }

  private parseExport(line: string, directive: string): void {
    this.currentDirective = AssignDirective.EXPORT | this.currentDirective;
    if (this.handleDirective(line, this.assignDirectives)) {
      return;
    }
    this.createExport(line, true);
    this.parseRuleOrAssign(line);
  }

  private parseUnexport(line: string, directive: string): void {
    this.createExport(line, false);
  }

  private parseIfEqCond(s: string, stmt: IfStmt): boolean {
    if (s === '') {
      return false;
    }

    if (s[0] === '(' && s[s.length - 1] === ')') {
      // Parenthesized form: (arg1,arg2)
      const inner = s.substring(1, s.length - 1);
      const commaPos = StrUtil.findOutsideParen(inner, ',');
      if (commaPos === -1) {
        return false;
      }

      stmt.lhs = this.parseExpr(
        {...this.mutableLoc},
        inner.substring(0, commaPos),
      );
      stmt.rhs = this.parseExpr(
        {...this.mutableLoc},
        StrUtil.trimLeftSpace(inner.substring(commaPos + 1)),
      );
      return true;
    } else {
      // Quoted form: "arg1" "arg2"
      let pos = 0;
      const args: Expr[] = [];

      for (let i = 0; i < 2; i++) {
        const trimmed = StrUtil.trimLeftSpace(s.substring(pos));
        if (trimmed === '') {
          return false;
        }

        const quote = trimmed[0];
        if (quote !== '"' && quote !== "'") {
          return false;
        }

        const end = trimmed.indexOf(quote, 1);
        if (end === -1) {
          return false;
        }

        const content = trimmed.substring(1, end);
        args.push(this.parseExpr({...this.mutableLoc}, content));
        pos += s.length - trimmed.length + end + 1;
      }

      stmt.lhs = args[0];
      stmt.rhs = args[1];

      const remaining = StrUtil.trimLeftSpace(s.substring(pos));
      if (remaining !== '') {
        // Warning: extraneous text after conditional
        return true; // But still valid
      }
      return true;
    }
  }
}
