import * as fs from 'fs';
import {KatiFlags} from './flags';
import {Evaluator} from './evaluator';
import {Parser} from './parser';
import {Stmt} from './ast';

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
      console.log(
        `[${index}] ${stmt.constructor.name} at ${stmt.loc.filename}:${stmt.loc.lineno}`,
      );
      console.log(`    ${stmtToDebugString(stmt)}`);
      console.log('');
    });
  } catch (error) {
    throw new Error(`Error parsing ${filename}: ${error}`);
  }
}

export async function run(flags: KatiFlags): Promise<number> {
  const startTime = Date.now();

  console.log('*kati*: Starting TypeScript Kati');
  console.log(`*kati*: Makefile: ${flags.makefile}`);
  console.log(
    `*kati*: Targets: ${flags.targets.length > 0 ? flags.targets.join(', ') : '(default)'}`,
  );
  console.log(`*kati*: Working directory: ${process.cwd()}`);
  console.log(`*kati*: Generate ninja: ${flags.generateNinja}`);

  if (flags.enableDebug) {
    console.log('*kati*: Debug mode enabled');
    console.log('*kati*: Flags:', JSON.stringify(flags, null, 2));
  }

  // Check if makefile exists
  if (!fs.existsSync(flags.makefile!)) {
    console.error(`*kati*: Error: Makefile '${flags.makefile}' not found`);
    return 1;
  }

  // Handle parse-only mode
  if (flags.isParseOnly) {
    parseAndDumpDebugString(flags.makefile!);
    return 0;
  }

  try {
    // Initialize evaluator
    const evaluator = new Evaluator(flags);

    // Parse and evaluate makefile
    console.log(`*kati*: Parsing makefile: ${flags.makefile}`);
    await evaluator.parseMakefile(flags.makefile!);

    if (flags.isSyntaxCheckOnly) {
      console.log('*kati*: Syntax check completed successfully');
      return 0;
    }

    // Build dependency graph
    console.log('*kati*: Building dependency graph...');
    const nodes = await evaluator.buildDependencyGraph(flags.targets);

    if (flags.generateNinja) {
      console.log('*kati*: Generating Ninja build file...');
      await evaluator.generateNinja(nodes);
      console.log('*kati*: Ninja file generated successfully');
      return 0;
    }

    // Execute targets
    console.log('*kati*: Executing targets...');
    const result = await evaluator.execute(nodes);

    const endTime = Date.now();
    console.log(`*kati*: Build completed in ${endTime - startTime}ms`);

    return result;
  } catch (error) {
    console.error('*kati*: Error during build:', error);
    return 1;
  }
}
