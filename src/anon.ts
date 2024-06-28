import { ChildProcess, spawn, execFile } from 'child_process';
import { AnonConfig, createAnonConfigFile } from './config/config';
import { getBinaryPath } from './utils';

/**
 * Allows to run Anon client with different configuration options
 */
export class Anon {
  private options?: AnonConfig;
  private process?: ChildProcess;

  public constructor(options?: AnonConfig) {
    this.options = options;
  };

  /**
   * Starts Anon client with options configured in constructor
   */
  public async start() {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }

    const configPath = await createAnonConfigFile(this.options);
    this.process = this.runBinary('anon', configPath, () => this.onStop());
  }

  /**
   * Stops Anon client
   */
  public async stop() {
    if (this.process !== undefined) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * Allows to check if Anon is running
   * @returns true if Anon is running
   */
  public isRunning(): boolean {
    return this.process !== undefined;
  }

  private onStop() {
    this.process = undefined;
  }

  private runBinary(name: string, configPath?: string, onStop?: VoidFunction): ChildProcess {
    const binaryPath = getBinaryPath(name);

    let args: Array<string> = [];
    if (configPath !== undefined) {
      args = ['-f', configPath]
    }

    if (this.options?.useExecFile === true) {
      const child = execFile(binaryPath, args);

      child.on('close', () => {
        if (onStop !== undefined) {
          onStop();
        }
      });

      child.on('exit', () => {
        if (onStop !== undefined) {
          onStop();
        }
      });

      return child;
    }

    const child = spawn(binaryPath, args, { detached: false });

    child.stdout.on('data', (data) => {
      if (this.options?.displayLog === true) {
        console.log(`${data}`);
      }
    });

    child.stderr.on('data', (data) => {
      if (this.options?.displayLog === true) {
        console.log(`${data}`);
      }
    });

    child.on('close', () => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    child.on('exit', () => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    return child;
  }
}
