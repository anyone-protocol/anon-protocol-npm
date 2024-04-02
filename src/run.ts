import { spawn } from 'child_process';
import * as os from 'os';
import { ConfigOptions, createConfig } from './config/config';
import path from 'path';

export async function runAnon(options?: ConfigOptions) {
  const configPath = await createConfig(options);
  runBinary('anon', configPath);
}

export async function runAnonGencert() {
  runBinary('anon-gencert');
}

function runBinary(name: string, configPath?: string) {
  const platform = os.platform();
  const arch = os.arch();

  let binaryPath = path.join(__dirname, 'bin', platform, name);
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
    console.log(`${code}`);
  });
}
