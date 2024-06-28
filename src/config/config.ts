import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface AnonConfig {
  /* Enables logging when set to true */
  displayLog?: boolean;

  /* Enables option to use execFile() instead of spawn() to start anon */
  useExecFile?: boolean;

  /* Sets SOCKS5 port of the client */
  socksPort?: number;

  /* Sets OR port of the relay */
  orPort?: number;
}

export async function createAnonConfigFile(options?: AnonConfig): Promise<string> {
  const tempAnonrcName = `anonrc-${Date.now()}`;
  const tempAnonrcPath = path.join(os.tmpdir(), tempAnonrcName);

  const tempDataDirName = `anon-data-${Date.now()}`;
  const tempDataDirPath = path.join(os.tmpdir(), tempDataDirName);

  const socksPort = options?.socksPort ?? 0;
  const orPort = options?.orPort ?? 0;

  let configItems = [
    `DataDirectory ${tempDataDirPath}`,
    `SOCKSPort ${socksPort}`,
    `ORPort ${orPort}`,
  ];

  const configData = configItems.join("\n");
  await fs.writeFile(tempAnonrcPath, configData);
  await fs.mkdir(tempDataDirPath)

  return tempAnonrcPath;
}

export interface AnonProxyConfig {
  /* Enables logging when set to true */
  displayLog?: boolean;

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
