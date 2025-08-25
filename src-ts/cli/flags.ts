export interface KatiFlags {
  // Core behavior flags
  detectAndroidEcho: boolean;
  detectDepfiles: boolean;
  dumpKatiStamp: boolean;
  dumpIncludeGraph?: string;
  dumpVariableAssignmentTrace?: string;
  enableDebug: boolean;
  enableKatiWarnings: boolean;
  enableStatLogs: boolean;
  genAllTargets: boolean;
  generateNinja: boolean;
  generateEmptyNinja: boolean;
  isDryRun: boolean;
  isSilentMode: boolean;
  isSyntaxCheckOnly: boolean;
  regen: boolean;
  regenDebug: boolean;
  regenIgnoringKatiBinary: boolean;
  useFindEmulator: boolean;
  colorWarnings: boolean;
  noBuiltinRules: boolean;
  noNinjaPrelude: boolean;
  useNinjaPhonyOutput: boolean;
  useNinjaValidations: boolean;
  
  // Warning/error flags
  werrorFindEmulator: boolean;
  werrorOverridingCommands: boolean;
  warnImplicitRules: boolean;
  werrorImplicitRules: boolean;
  warnSuffixRules: boolean;
  werrorSuffixRules: boolean;
  topLevelPhony: boolean;
  warnRealToPhony: boolean;
  werrorRealToPhony: boolean;
  warnPhonyLooksReal: boolean;
  werrorPhonyLooksReal: boolean;
  werrorWritable: boolean;
  warnRealNoCmdsOrDeps: boolean;
  werrorRealNoCmdsOrDeps: boolean;
  warnRealNoCmds: boolean;
  werrorRealNoCmds: boolean;
  
  // String options
  defaultPool?: string;
  ignoreDirtyPattern?: string;
  noIgnoreDirtyPattern?: string;
  ignoreOptionalIncludePattern?: string;
  makefile?: string;
  ninjaDir?: string;
  ninjaSuffix?: string;
  workingDir?: string;
  
  // Numeric options
  numCpus: number;
  numJobs: number;
  remoteNumJobs: number;
  
  // Array options
  subkatiArgs: string[];
  targets: string[];
  clVars: string[];
  writable: string[];
  tracedVariablesPattern: string[];
}

export function createDefaultFlags(): KatiFlags {
  return {
    detectAndroidEcho: false,
    detectDepfiles: false,
    dumpKatiStamp: false,
    enableDebug: false,
    enableKatiWarnings: false,
    enableStatLogs: false,
    genAllTargets: false,
    generateNinja: false,
    generateEmptyNinja: false,
    isDryRun: false,
    isSilentMode: false,
    isSyntaxCheckOnly: false,
    regen: false,
    regenDebug: false,
    regenIgnoringKatiBinary: false,
    useFindEmulator: false,
    colorWarnings: false,
    noBuiltinRules: false,
    noNinjaPrelude: false,
    useNinjaPhonyOutput: false,
    useNinjaValidations: false,
    werrorFindEmulator: false,
    werrorOverridingCommands: false,
    warnImplicitRules: false,
    werrorImplicitRules: false,
    warnSuffixRules: false,
    werrorSuffixRules: false,
    topLevelPhony: false,
    warnRealToPhony: false,
    werrorRealToPhony: false,
    warnPhonyLooksReal: false,
    werrorPhonyLooksReal: false,
    werrorWritable: false,
    warnRealNoCmdsOrDeps: false,
    werrorRealNoCmdsOrDeps: false,
    warnRealNoCmds: false,
    werrorRealNoCmds: false,
    numCpus: 1,
    numJobs: 1,
    remoteNumJobs: 1,
    subkatiArgs: [],
    targets: [],
    clVars: [],
    writable: [],
    tracedVariablesPattern: []
  };
}