#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import { KatiFlags, createDefaultFlags } from './cli/flags';
import { run } from './cli/main';

const program = new Command();

function handleRealpath(args: string[]): void {
  for (const arg of args) {
    try {
      const realPath = fs.realpathSync(arg);
      console.log(realPath);
    } catch (error) {
      // Silently skip files that can't be resolved
    }
  }
}

function findFirstMakefile(): string | undefined {
  const candidates = ['GNUmakefile', 'makefile', 'Makefile'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseCommandLine(): KatiFlags {
  const flags = createDefaultFlags();
  
  program
    .name('tskati')
    .description('TypeScript port of Kati (GNU make clone)')
    .version('1.0.0')
    .option('-f, --file <makefile>', 'Read makefile as the makefile')
    .option('-C, --directory <dir>', 'Change to directory before doing anything')
    .option('-j, --jobs <n>', 'Number of jobs to run simultaneously', (value) => parseInt(value, 10), 1)
    .option('-n, --dry-run', 'Don\'t actually run any commands; just print them')
    .option('-s, --silent', 'Don\'t print the commands as they are executed')
    .option('--ninja', 'Generate ninja build file')
    .option('--regen', 'Regenerate ninja file when needed')
    .option('--regen_debug', 'Debug ninja regeneration')
    .option('--gen_all_targets', 'Generate all targets')
    .option('--use_find_emulator', 'Use find emulator')
    .option('--detect_android_echo', 'Detect Android echo')
    .option('--detect_depfiles', 'Detect dependency files')
    .option('--dump_kati_stamp', 'Dump kati stamp')
    .option('--dump_include_graph <file>', 'Dump include graph to file')
    .option('--enable_debug', 'Enable debug output')
    .option('--enable_kati_warnings', 'Enable kati warnings')
    .option('--enable_stat_logs', 'Enable stat logs')
    .option('--color_warnings', 'Colorize warning output')
    .option('--no_builtin_rules', 'Don\'t use built-in rules')
    .option('--syntax_check_only', 'Only check syntax, don\'t execute')
    .argument('[targets...]', 'Build targets')
    .allowUnknownOption()
    .parse();

  const options = program.opts();
  const targets = program.args;

  // Handle special cases first
  const argv = process.argv.slice(2);
  if (argv.length >= 1) {
    if (argv[0] === '--realpath') {
      handleRealpath(argv.slice(1));
      process.exit(0);
    } else if (argv[0] === '--dump_stamp_tool') {
      console.log('Dump stamp tool not yet implemented');
      process.exit(0);
    }
  }

  // Map commander options to flags
  if (options.file) flags.makefile = options.file;
  if (options.directory) flags.workingDir = options.directory;
  if (options.jobs) flags.numJobs = options.jobs;
  if (options.dryRun) flags.isDryRun = true;
  if (options.silent) flags.isSilentMode = true;
  if (options.ninja) flags.generateNinja = true;
  if (options.regen) flags.regen = true;
  if (options.regen_debug) flags.regenDebug = true;
  if (options.gen_all_targets) flags.genAllTargets = true;
  if (options.use_find_emulator) flags.useFindEmulator = true;
  if (options.detect_android_echo) flags.detectAndroidEcho = true;
  if (options.detect_depfiles) flags.detectDepfiles = true;
  if (options.dump_kati_stamp) flags.dumpKatiStamp = true;
  if (options.dump_include_graph) flags.dumpIncludeGraph = options.dump_include_graph;
  if (options.enable_debug) flags.enableDebug = true;
  if (options.enable_kati_warnings) flags.enableKatiWarnings = true;
  if (options.enable_stat_logs) flags.enableStatLogs = true;
  if (options.color_warnings) flags.colorWarnings = true;
  if (options.no_builtin_rules) flags.noBuiltinRules = true;
  if (options.syntax_check_only) flags.isSyntaxCheckOnly = true;

  flags.targets = targets;
  flags.numCpus = os.cpus().length;

  return flags;
}

async function main(): Promise<void> {
  try {
    const flags = parseCommandLine();

    // Change working directory if specified
    if (flags.workingDir) {
      try {
        process.chdir(flags.workingDir);
      } catch (error) {
        console.error(`*** ${flags.workingDir}: ${error}`);
        process.exit(1);
      }
    }

    // Find makefile if not specified
    if (!flags.makefile) {
      const foundMakefile = findFirstMakefile();
      if (!foundMakefile) {
        console.error('*** No targets specified and no makefile found.');
        process.exit(1);
      }
      flags.makefile = foundMakefile;
    }

    const exitCode = await run(flags);
    process.exit(exitCode);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}