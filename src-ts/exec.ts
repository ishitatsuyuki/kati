import * as fs from 'fs';
import {spawn, SpawnOptions, spawnSync, SpawnSyncOptions} from 'child_process';
import {DepNode, NamedDepNode, Symbol} from './dep';
import {Evaluator} from './evaluator';
import {CommandEvaluator} from './var';

// Constants matching C++ implementation
const kNotExist = -2.0;
const kProcessing = -1.0;

// Command execution result
interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Main executor class that handles dependency graph execution
 */
class Executor {
  private ce_: CommandEvaluator;
  private done_: Map<Symbol, number> = new Map();
  private shell_: string;
  private shellflag_: string;
  private num_commands_ = 0;

  constructor(ev: Evaluator) {
    this.ce_ = new CommandEvaluator(ev);
    this.shell_ = ev.getShell();
    this.shellflag_ = ev.getShellFlag();
  }

  /**
   * Execute a dependency node and all its dependencies
   * @param n The dependency node to execute
   * @param neededBy The target that needs this node (for error reporting)
   * @returns The timestamp of the executed node
   */
  execNode(n: DepNode, neededBy: string | null): number {
    // Check if already processed
    const found = this.done_.get(n.output);
    if (found !== undefined) {
      if (found === kProcessing) {
        console.warn(
          `Circular ${neededBy ? neededBy : '(null)'} <- ${n.output} dependency dropped.`,
        );
      }
      return found;
    }

    // Mark as processing to detect circular dependencies
    this.done_.set(n.output, kProcessing);

    const outputTs = this.getTimestamp(n.output);

    return this.ce_.evaluator().withScope(scope => {
      n.rule_vars?.forEach((value, key) => {
        scope.set(key, value);
      });

      console.log(
        `*kati*: ExecNode: ${n.output} for ${neededBy ? neededBy : '(null)'}`,
      );

      // Check if target exists and has no rule
      if (!n.has_rule && outputTs === kNotExist && !n.is_phony) {
        if (neededBy) {
          throw new Error(
            `*** No rule to make target '${n.output}', needed by '${neededBy}'.`,
          );
        } else {
          throw new Error(`*** No rule to make target '${n.output}'.`);
        }
      }

      // Process order-only dependencies first
      let latest = kProcessing;
      for (const d of n.order_onlys) {
        if (fs.existsSync(d.node.output)) {
          continue;
        }
        const ts = this.execNode(d.node, n.output);
        if (latest < ts) {
          latest = ts;
        }
      }

      // Process regular dependencies
      for (const d of n.deps) {
        const ts = this.execNode(d.node, n.output);
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
          const result = this.runCommandSync(
            this.shell_,
            this.shellflag_,
            command.cmd,
          );

          process.stdout.write(result.stdout);

          if (result.exitCode !== 0) {
            if (command.ignore_error) {
              console.error(
                `[${command.output}] Error ${result.exitCode} (ignored)`,
              );
            } else {
              throw new Error(
                `*** [${command.output}] Error ${result.exitCode}`,
              );
            }
          }
        }
      }
      this.done_.set(n.output, outputTs);
      return outputTs;
    });
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
  private getTimestamp(path: string): number {
    try {
      const stat = fs.statSync(path);
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
    command: string,
  ): Promise<CommandResult> {
    return new Promise(resolve => {
      const options: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      };

      const child = spawn(shell, [shellFlag, command], options);

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', data => {
          stdout += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', data => {
          stderr += data.toString();
        });
      }

      child.on('close', code => {
        resolve({
          exitCode: code || 0,
          stdout,
          stderr,
        });
      });

      child.on('error', error => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: error.message,
        });
      });
    });
  }

  /**
   * Run a shell command synchronously
   * @param shell Shell executable
   * @param shellFlag Shell flag (usually -c)
   * @param command Command to execute
   * @returns Command execution result
   */
  private runCommandSync(
    shell: string,
    shellFlag: string,
    command: string,
  ): CommandResult {
    const options: SpawnSyncOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      encoding: 'utf8',
    };

    const result = spawnSync(shell, [shellFlag, command], options);

    return {
      exitCode: result.status || 0,
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
    };
  }
}

/**
 * Main execution function - entry point matching C++ Exec function
 * @param roots Root targets to execute
 * @param ev Evaluator instance
 */
export function exec(roots: NamedDepNode[], ev: Evaluator) {
  const executor = new Executor(ev);

  for (const root of roots) {
    executor.execNode(root.node, null);
  }

  if (executor.count() === 0) {
    for (const root of roots) {
      console.log(`kati: Nothing to be done for \`${root.name}'.`);
    }
  }
}
