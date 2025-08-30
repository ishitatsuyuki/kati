import * as fs from 'fs';
import {spawn, SpawnOptions} from 'child_process';
import {DepNode, NamedDepNode, Symbol} from './dep';
import {Evaluator, Loc} from './evaluator';

// Constants matching C++ implementation
const kNotExist = -2.0;
const kProcessing = -1.0;

// Command execution result
interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Interface for command evaluation (will be implemented)
interface CommandEvaluator {
  eval(node: DepNode): Command[];
  evaluator(): Evaluator;
}

// Command structure matching the C++ version
export interface Command {
  output: string;
  cmd: string;
  echo: boolean;
  ignore_error: boolean;
}

// Scoped frame for execution context (placeholder - matches C++ ScopedFrame)
class ScopedFrame {
  constructor(ev: Evaluator, frameType: string, output: string, loc: Loc) {
    // TODO: Implement proper frame management if needed
  }
}

/**
 * Main executor class that handles dependency graph execution
 * This is a TypeScript port of the C++ Executor class from src/exec.cc
 */
class Executor {
  private ce_: CommandEvaluator;
  private done_: Map<Symbol, number> = new Map();
  private shell_: string;
  private shellflag_: string;
  private num_commands_: number = 0;

  constructor(ev: Evaluator) {
    this.ce_ = new CommandEvaluatorImpl(ev);
    this.shell_ = ev.getShell();
    this.shellflag_ = ev.getShellFlag();
  }

  /**
   * Execute a dependency node and all its dependencies
   * @param n The dependency node to execute
   * @param neededBy The target that needs this node (for error reporting)
   * @returns The timestamp of the executed node
   */
  async execNode(n: DepNode, neededBy: string | null): Promise<number> {
    // Check if already processed
    const found = this.done_.get(n.output);
    if (found !== undefined) {
      if (found === kProcessing) {
        console.warn(
          `Circular ${neededBy ? neededBy : '(null)'} <- ${n.output} dependency dropped.`
        );
      }
      return found;
    }

    // Mark as processing to detect circular dependencies
    this.done_.set(n.output, kProcessing);

    // Create scoped frame for execution context
    const frame = new ScopedFrame(
      this.ce_.evaluator(),
      'EXEC',
      n.output,
      n.loc
    );

    const outputTs = await this.getTimestamp(n.output);

    console.log(`ExecNode: ${n.output} for ${neededBy ? neededBy : '(null)'}`);

    // Check if target exists and has no rule
    if (!n.has_rule && outputTs === kNotExist && !n.is_phony) {
      if (neededBy) {
        throw new Error(
          `*** No rule to make target '${n.output}', needed by '${neededBy}'.`
        );
      } else {
        throw new Error(`*** No rule to make target '${n.output}'.`);
      }
    }

    // Process order-only dependencies first
    let latest = kProcessing;
    for (const d of n.order_onlys) {
      if (await this.exists(d.node.output)) {
        continue;
      }
      const ts = await this.execNode(d.node, n.output);
      if (latest < ts) {
        latest = ts;
      }
    }

    // Process regular dependencies
    for (const d of n.deps) {
      const ts = await this.execNode(d.node, n.output);
      if (latest < ts) {
        latest = ts;
      }
    }

    // Check if rebuild is needed
    if (outputTs >= latest && !n.is_phony) {
      this.done_.set(n.output, outputTs);
      return outputTs;
    }

    // Execute commands for this target
    const commands = this.ce_.eval(n);
    for (const command of commands) {
      this.num_commands_++;
      
      if (command.echo) {
        console.log(command.cmd);
      }
      
      if (!this.ce_.evaluator().avoid_io()) {
        const result = await this.runCommand(
          this.shell_,
          this.shellflag_,
          command.cmd
        );
        
        process.stdout.write(result.stdout);
        
        if (result.exitCode !== 0) {
          if (command.ignore_error) {
            console.error(
              `[${command.output}] Error ${result.exitCode} (ignored)`
            );
          } else {
            console.error(`*** [${command.output}] Error ${result.exitCode}`);
            process.exit(1);
          }
        }
      }
    }

    this.done_.set(n.output, outputTs);
    return outputTs;
  }

  /**
   * Get the number of commands executed
   */
  count(): number {
    return this.num_commands_;
  }

  /**
   * Get timestamp of a file
   * @param path File path
   * @returns Timestamp or kNotExist if file doesn't exist
   */
  private async getTimestamp(path: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(path);
      return stat.mtime.getTime() / 1000; // Convert to seconds like C++
    } catch {
      return kNotExist;
    }
  }

  /**
   * Check if a file exists
   * @param path File path
   * @returns True if file exists
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a shell command
   * @param shell Shell executable
   * @param shellFlag Shell flag (usually -c)
   * @param command Command to execute
   * @returns Command execution result
   */
  private async runCommand(
    shell: string,
    shellFlag: string,
    command: string
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const options: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      };

      const child = spawn(shell, [shellFlag, command], options);
      
      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      child.on('close', (code) => {
        resolve({
          exitCode: code || 0,
          stdout,
          stderr,
        });
      });

      child.on('error', (error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: error.message,
        });
      });
    });
  }
}

/**
 * Implementation of CommandEvaluator
 * This is a simplified version that extracts commands from DepNode
 */
class CommandEvaluatorImpl implements CommandEvaluator {
  constructor(private ev_: Evaluator) {}

  eval(node: DepNode): Command[] {
    return node.cmds.map(cmd => {
      // Parse command for @ (silent) and - (ignore error) prefixes
      let actualCmd = cmd;
      let echo = true;
      let ignoreError = false;
      
      // Handle @ prefix (silent - don't echo)
      if (actualCmd.startsWith('@')) {
        echo = false;
        actualCmd = actualCmd.substring(1);
      }
      
      // Handle - prefix (ignore errors)
      if (actualCmd.startsWith('-')) {
        ignoreError = true;
        actualCmd = actualCmd.substring(1);
      }
      
      // Respect evaluator's silent mode
      if (this.ev_.getFlags().isSilentMode) {
        echo = false;
      }
      
      return {
        output: node.output,
        cmd: actualCmd,
        echo,
        ignore_error: ignoreError,
      };
    });
  }

  evaluator(): Evaluator {
    return this.ev_;
  }
}

/**
 * Main execution function - entry point matching C++ Exec function
 * @param roots Root targets to execute
 * @param ev Evaluator instance
 */
export async function exec(
  roots: NamedDepNode[],
  ev: Evaluator
): Promise<void> {
  const executor = new Executor(ev);
  
  for (const root of roots) {
    await executor.execNode(root.node, null);
  }
  
  if (executor.count() === 0) {
    for (const root of roots) {
      console.log(`kati: Nothing to be done for \`${root.name}'.`);
    }
  }
}