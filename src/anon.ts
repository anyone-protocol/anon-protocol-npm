import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as os from 'os';
import { ConfigOptions, createConfigFile } from './config/config';
import path from 'path';

export class Anon {
  options?: ConfigOptions;
  process?: ChildProcessWithoutNullStreams;

  public constructor(options?: ConfigOptions) {
    this.options = options;
  };

  public async start() {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }

    const configPath = await createConfigFile(this.options);
    this.process = this.runBinary('anon', configPath, () => this.onStop());
  }

  public async stop() {
    if (this.process !== undefined) {
      this.process.kill('SIGTERM');
    }
  }

  public isRunning(): boolean {
    return this.process !== undefined;
  }

  private onStop() {
    this.process = undefined;
  }

  private runBinary(name: string, configPath?: string, onStop?: VoidFunction): ChildProcessWithoutNullStreams {
    const platform = os.platform();
    const arch = os.arch();
  
    let binaryPath = path.join(__dirname, '..', 'bin', platform, arch, name);
    if (platform === 'win32') {
      binaryPath += '.exe';
    }
  
    let args: Array<string> = [];
    if (configPath !== undefined) {
      args = ['-f', configPath]
    }
  
    const child = spawn(binaryPath, args);
  
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

