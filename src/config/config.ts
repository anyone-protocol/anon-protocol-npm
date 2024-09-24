import fs from 'fs/promises';
import fsbasic from 'fs';
import os from 'os';
import path from 'path';

export interface AnonConfig {
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
}

export async function createAnonConfigFile(options: AnonConfig): Promise<string> {
  if (options.configFile) {
    try {
      await fs.access(options.configFile);
      return options.configFile;
    } catch {
    }
  }

  const configPath = options.configFile ?? path.join(os.tmpdir(), `anonrc-${Date.now()}`);
  const tempDataDirName = `anon-data-${Date.now()}`;
  const tempDataDirPath = path.join(os.tmpdir(), tempDataDirName);

  const configItems = [
    `DataDirectory ${tempDataDirPath}`,
    `SOCKSPort ${options.socksPort}`,
    `ORPort ${options.orPort}`,
    `ControlPort ${options.controlPort}`,
  ];

  await fs.writeFile(configPath, configItems.join('\n') + '\n');

  await fs.mkdir(tempDataDirPath, { recursive: true });

  const termsAgreementFileName = 'terms-agreement';
  const target = path.join(process.cwd(), termsAgreementFileName);

  if (fsbasic.existsSync(target)) {
    const link = path.join(tempDataDirPath, termsAgreementFileName);
    await fs.symlink(target, link, 'file').catch((err) => {
      console.error(`Error creating symlink: ${err}`);
    });
  }

  return configPath;
}

export interface AnonProxyConfig {
  /* Sets SOCKS5 port of the client */
  socksPort?: number;
}

export async function createAnonProxyConfigFile(options?: AnonProxyConfig): Promise<string> {
  const tempConfigName = `anon-proxy-${Date.now()}`;
  const tempConfigPath = path.join(os.tmpdir(), tempConfigName);

  const socksPort = options?.socksPort ?? 9050;
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
    `socks5 127.0.0.1 ${socksPort}`,
  ];

  const configData = configItems.join("\n");
  await fs.writeFile(tempConfigPath, configData);

  return tempConfigPath;
}
