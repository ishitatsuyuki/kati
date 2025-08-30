import * as fs from 'fs';
import {KatiFlags} from './flags';
import {Evaluator} from '../core/evaluator';

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
