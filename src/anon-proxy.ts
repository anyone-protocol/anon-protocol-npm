import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import path from 'path';

/**
 * Allows to run Anon Proxy with different configuration options
 */
export class AnonProxy {
  private process?: ChildProcess;

  /**
   * Starts Anon Proxy
   */
  public async start(args: string[]) {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }

    this.process = this.runBinary('anon-proxy', args, () => this.onStop());
  }

  /**
   * Stops Anon Proxy
   */
  public async stop() {
    if (this.process !== undefined) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * Allows to check if Anon Proxy is running
   * @returns true if Anon Proxy is running
   */
  public isRunning(): boolean {
    return this.process !== undefined;
  }

  private onStop() {
    this.process = undefined;
  }

  private runBinary(name: string, args: string[], onStop?: VoidFunction): ChildProcess {
    const platform = os.platform();
    const arch = os.arch();

    let binaryPath = path.join(__dirname, '..', 'bin', platform, arch, name);
    if (platform === 'win32') {
      binaryPath += '.exe';
    }

    const child = spawn(binaryPath, args, { detached: false });

    child.stdout.on('data', (data) => {
        console.log(`${data}`);
    });

    child.stderr.on('data', (data) => {
        console.log(`${data}`);
    });

    child.on('close', (code) => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    child.on('exit', (code) => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    return child;
  }
}


