import * as fs from 'fs';
import { Parser } from './parser.js';
import { Stmt } from './core/ast.js';

function stmtToDebugString(stmt: Stmt): string {
    return stmt.debugString();
}

function parseAndDumpDebugString(filename: string): void {
    try {
        // Read the makefile
        const content = fs.readFileSync(filename, 'utf8');
        
        // Create statements array and parser
        const stmts: Stmt[] = [];
        const parser = new Parser(content, filename, stmts);
        
        // Parse the content
        parser.parse();
        
        // Dump debug strings for all statements
        console.log(`=== Debug dump for ${filename} ===`);
        console.log(`Found ${stmts.length} statements:`);
        console.log('');
        
        stmts.forEach((stmt, index) => {
            console.log(`[${index}] ${stmt.constructor.name} at ${stmt.loc.filename}:${stmt.loc.lineno}`);
            console.log(`    ${stmtToDebugString(stmt)}`);
            console.log('');
        });
        
    } catch (error) {
        console.error(`Error parsing ${filename}:`, error);
        process.exit(1);
    }
}

function main(): void {
    const args = process.argv.slice(2);
    
    if (args.length !== 1) {
        console.error('Usage: node debug-harness.js <makefile>');
        process.exit(1);
    }
    
    const filename = args[0];
    
    if (!fs.existsSync(filename)) {
        console.error(`File not found: ${filename}`);
        process.exit(1);
    }
    
    parseAndDumpDebugString(filename);
}

if (require.main === module) {
    main();
}

export { parseAndDumpDebugString };