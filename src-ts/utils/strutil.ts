export class StrUtil {
    static findOutsideParenImpl(s: string, predicate: (c: string) => boolean): number {
        let prevBackslash = false;
        const parenStack: string[] = [];
        
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            
            if (predicate(c) && parenStack.length === 0 && !prevBackslash) {
                return i;
            }
            
            switch (c) {
                case '(':
                    parenStack.push(')');
                    break;
                case '{':
                    parenStack.push('}');
                    break;
                case ')':
                case '}':
                    if (parenStack.length > 0 && c === parenStack[parenStack.length - 1]) {
                        parenStack.pop();
                    }
                    break;
            }
            
            prevBackslash = c === '\\' && !prevBackslash;
        }
        
        return -1; // string::npos equivalent
    }
    
    static findOutsideParen(s: string, c: string): number {
        return StrUtil.findOutsideParenImpl(s, (d: string) => d === c);
    }
    
    static findTwoOutsideParen(s: string, c1: string, c2: string): number {
        return StrUtil.findOutsideParenImpl(s, (d: string) => d === c1 || d === c2);
    }
    
    static findThreeOutsideParen(s: string, c1: string, c2: string, c3: string): number {
        return StrUtil.findOutsideParenImpl(s, (d: string) => d === c1 || d === c2 || d === c3);
    }
    
    static trimLeftSpace(s: string): string {
        return s.replace(/^[ \t]+/, '');
    }
    
    static trimRightSpace(s: string): string {
        return s.replace(/[ \t]+$/, '');
    }
    
    static trimSpace(s: string): string {
        return s.replace(/^[ \t]+|[ \t]+$/g, '');
    }
    
    static removeComment(line: string): string {
        const i = StrUtil.findOutsideParen(line, '#');
        if (i === -1) {
            return line;
        }
        return line.substring(0, i);
    }
}