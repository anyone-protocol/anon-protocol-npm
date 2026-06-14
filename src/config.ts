import fs from 'fs/promises';
import fsbasic from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { getBinaryDir } from './utils';

export interface Config {
  /* Enables logging when set to true */
  displayLog?: boolean;

  /* Enables option to use execFile() instead of spawn() to start anon */
  useExecFile?: boolean;

  /* Sets SOCKS5 port of the client */
  socksPort: number;

  /* Sets OR port of the relay */
  orPort: number;

  /* Sets control port of the relay */
  controlPort: number;

  /* Sets the path to the configuration file */
  configFile?: string;

  /* Path to the binary */
  binaryPath?: string;

  /* Automatically agree to terms */
  autoTermsAgreement?: boolean;

  /* Custom path for the terms agreement file */
  termsFilePath?: string;

  /* Custom path for the data directory (default: auto-generated temp dir) */
  dataDir?: string;
}

export interface AnonConfigResult {
  configPath: string;
  dataDir: string;
}

async function askForAgreement() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Do you agree to the terms? (Press enter or y to agree, or ctrl-c to exit): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer === '');
    });
  });
}

export async function createAnonConfigFile(options: Config): Promise<AnonConfigResult> {
  if (options.configFile) {
    try {
      await fs.access(options.configFile);
      const dataDir = options.dataDir ?? path.dirname(options.configFile);
      return { configPath: options.configFile, dataDir };
    } catch {
    }
  }

  const configPath = options.configFile ?? path.join(os.tmpdir(), `anonrc-${Date.now()}`);
  const tempDataDirPath = options.dataDir ?? path.join(os.tmpdir(), `anon-data-${Date.now()}`);

  const binaryDir = options.binaryPath
      ? path.dirname(options.binaryPath)
      : getBinaryDir();

  const configItems = [
    `DataDirectory ${tempDataDirPath}`,
    `SOCKSPort ${options.socksPort}`,
    `ORPort ${options.orPort}`,
    `ControlPort ${options.controlPort}`,
    `GeoIPFile ${path.join(binaryDir, 'geoip')}`,
    `GeoIPv6File ${path.join(binaryDir, 'geoip6')}`,
    'VirtualAddrNetworkIPv4 10.192.0.0/10',
    'AutomapHostsOnResolve 1',
    'AutomapHostsSuffixes .anyone',
  ];

  await fs.writeFile(configPath, configItems.join('\n') + '\n');

  await fs.mkdir(tempDataDirPath, { recursive: true });

  const termsAgreementFileName = 'terms-agreement';
  const target = options.termsFilePath ?? path.join(process.cwd(), termsAgreementFileName);

  if (fsbasic.existsSync(target)) {
    const link = path.join(tempDataDirPath, termsAgreementFileName);
    await fs.copyFile(target, link).catch((err) => {
      console.error(`Error copying terms agreement file: ${err}`);
    });
  } else {
    if (options.autoTermsAgreement) {
      await fs.writeFile(target, 'agreed').catch((err) => {
        console.error(`Error creating terms agreement file: ${err}`);
      });
      const link = path.join(tempDataDirPath, termsAgreementFileName);
      await fs.copyFile(target, link).catch((err) => {
        console.error(`Error copying terms agreement file: ${err}`);
      });
    } else {
      const agreed = await askForAgreement();
      if (agreed) {
        await fs.writeFile(target, 'agreed').catch((err) => {
          console.error(`Error creating terms agreement file: ${err}`);
        });
        const link = path.join(tempDataDirPath, termsAgreementFileName);
        await fs.copyFile(target, link).catch((err) => {
          console.error(`Error copying terms agreement file: ${err}`);
        });
      } else {
        console.log('Agreement declined. Exiting...');
        process.exit(1);
      }
    }
  }

  return { configPath, dataDir: tempDataDirPath };
}

export async function createProxyConfigFile(socksPort?: number): Promise<string> {
  const tempConfigName = `anon-proxy-${Date.now()}`;
  const tempConfigPath = path.join(os.tmpdir(), tempConfigName);

  let configItems = [
    'strict_chain',
    'proxy_dns',
    'remote_dns_subnet 224',
    '',
    'tcp_read_time_out 15000',
    'tcp_connect_time_out 8000',
    'localnet 127.0.0.0/255.0.0.0',
    '',
    '[ProxyList]',
    `socks5 127.0.0.1 ${socksPort ?? 9050}`,
  ];

  const configData = configItems.join("\n");
  await fs.writeFile(tempConfigPath, configData);

  return tempConfigPath;
}
