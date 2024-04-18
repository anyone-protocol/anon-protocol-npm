import { ChildProcess, spawn } from 'child_process';
import { AnonProxyConfig, createAnonProxyConfigFile } from './config/config';
import { getBinaryPath } from './utils';

/**
 * Allows to run Anon Proxy with different configuration options
 */
export class AnonProxy {
  private options?: AnonProxyConfig;
  private process?: ChildProcess;

  public constructor(options?: AnonProxyConfig) {
    this.options = options;
  };

  /**
   * Starts Anon Proxy
   */
  public async start(args: string[]) {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }

    const configPath = await createAnonProxyConfigFile(this.options);
    this.process = this.runBinary('anon-proxy', args, configPath, () => this.onStop());
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

  private runBinary(name: string, args: string[], configPath?: string, onStop?: VoidFunction): ChildProcess {
    const binaryPath = getBinaryPath(name);

    let proxyArgs: string[] = [];
    if (configPath !== undefined) {
      proxyArgs = ['-f', configPath]
    }

    const child = spawn(binaryPath, proxyArgs.concat(args), { detached: false });

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
