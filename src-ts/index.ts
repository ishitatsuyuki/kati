#!/usr/bin/env node

/* eslint-disable n/no-process-exit */

import {parseArgs} from 'node:util';
import * as fs from 'fs';
import * as os from 'os';
import {createDefaultFlags, KatiFlags} from './flags';
import {run} from './main';

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

  const {values, positionals} = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: {type: 'string', short: 'f'},
      directory: {type: 'string', short: 'C'},
      jobs: {type: 'string', short: 'j'},
      'dry-run': {type: 'boolean', short: 'n'},
      silent: {type: 'boolean', short: 's'},
      ninja: {type: 'boolean'},
      regen: {type: 'boolean'},
      regen_debug: {type: 'boolean'},
      gen_all_targets: {type: 'boolean'},
      use_find_emulator: {type: 'boolean'},
      detect_android_echo: {type: 'boolean'},
      detect_depfiles: {type: 'boolean'},
      dump_kati_stamp: {type: 'boolean'},
      dump_include_graph: {type: 'string'},
      enable_debug: {type: 'boolean'},
      enable_kati_warnings: {type: 'boolean'},
      enable_stat_logs: {type: 'boolean'},
      color_warnings: {type: 'boolean'},
      no_builtin_rules: {type: 'boolean'},
      syntax_check_only: {type: 'boolean'},
      parse_only: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
      version: {type: 'boolean', short: 'v'},
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(`tskati - TypeScript port of Kati (GNU make clone)

Usage: tskati [options] [targets...]

Options:
  -f, --file <makefile>         Read makefile as the makefile
  -C, --directory <dir>         Change to directory before doing anything
  -j, --jobs <n>               Number of jobs to run simultaneously
  -n, --dry-run                Don't actually run any commands; just print them
  -s, --silent                 Don't print the commands as they are executed
  --ninja                      Generate ninja build file
  --regen                      Regenerate ninja file when needed
  --regen_debug                Debug ninja regeneration
  --gen_all_targets            Generate all targets
  --use_find_emulator          Use find emulator
  --detect_android_echo        Detect Android echo
  --detect_depfiles            Detect dependency files
  --dump_kati_stamp            Dump kati stamp
  --dump_include_graph <file>  Dump include graph to file
  --enable_debug               Enable debug output
  --enable_kati_warnings       Enable kati warnings
  --enable_stat_logs           Enable stat logs
  --color_warnings             Colorize warning output
  --no_builtin_rules           Don't use built-in rules
  --syntax_check_only          Only check syntax, don't execute
  --parse_only                 Parse makefile and dump debug information only
  -h, --help                   Display this help message
  -v, --version                Display version information

Arguments:
  [targets...]                 Build targets`);
    process.exit(0);
  }

  if (values.version) {
    console.log('tskati 1.0.0');
    process.exit(0);
  }

  const targets = positionals;

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

  // Map parseArgs values to flags
  if (values.file && typeof values.file === 'string')
    flags.makefile = values.file;
  if (values.directory && typeof values.directory === 'string')
    flags.workingDir = values.directory;
  if (values.jobs && typeof values.jobs === 'string')
    flags.numJobs = parseInt(values.jobs, 10);
  if (values['dry-run']) flags.isDryRun = true;
  if (values.silent) flags.isSilentMode = true;
  if (values.ninja) flags.generateNinja = true;
  if (values.regen) flags.regen = true;
  if (values.regen_debug) flags.regenDebug = true;
  if (values.gen_all_targets) flags.genAllTargets = true;
  if (values.use_find_emulator) flags.useFindEmulator = true;
  if (values.detect_android_echo) flags.detectAndroidEcho = true;
  if (values.detect_depfiles) flags.detectDepfiles = true;
  if (values.dump_kati_stamp) flags.dumpKatiStamp = true;
  if (
    values.dump_include_graph &&
    typeof values.dump_include_graph === 'string'
  )
    flags.dumpIncludeGraph = values.dump_include_graph;
  if (values.enable_debug) flags.enableDebug = true;
  if (values.enable_kati_warnings) flags.enableKatiWarnings = true;
  if (values.enable_stat_logs) flags.enableStatLogs = true;
  if (values.color_warnings) flags.colorWarnings = true;
  if (values.no_builtin_rules) flags.noBuiltinRules = true;
  if (values.syntax_check_only) flags.isSyntaxCheckOnly = true;
  if (values.parse_only) flags.isParseOnly = true;

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
  /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
  main();
}
