import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as os from 'os';
import { ConfigOptions, createConfig } from './config/config';
import path from 'path';

export class Anon {
  options?: ConfigOptions;
  process?: ChildProcessWithoutNullStreams;

  constructor(options?: ConfigOptions) {
    this.options = options;
  };

  async start() {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }

    const configPath = await createConfig(this.options);
    this.process = runBinary('anon', configPath, this.onStop);
  }

  async stop() {
    if (this.process !== undefined) {
      this.process.kill('SIGTERM');
    }
  }

  private onStop() {
    this.process = undefined;
  }
}

function runBinary(name: string, configPath?: string, onStop?: VoidFunction): ChildProcessWithoutNullStreams {
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
