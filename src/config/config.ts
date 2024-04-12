import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface ConfigOptions {
  /* Enables logging when set to true */
  displayLog?: boolean;

  /* Sets SOCKS5 port of the client */
  socksPort?: number;

  /* Sets OR port of the relay */
  orPort?: number;
}

export async function createConfigFile(options?: ConfigOptions) {
  const tempAnonrcName = `anonrc-${Date.now()}`;
  const tempAnonrcPath = path.join(os.tmpdir(), tempAnonrcName);

  const tempDataDirName = `anon-data-${Date.now()}`;
  const tempDataDirPath = path.join(os.tmpdir(), tempDataDirName);

  const socksPort = options?.socksPort ?? 0;
  const orPort = options?.socksPort ?? 0;

  let configItems = [
    `DataDirectory ${tempDataDirPath}`,
  ];

  configItems.push(`SOCKSPort ${socksPort}`);
  configItems.push(`ORPort ${orPort}`);

  const configData = configItems.join("\n");
  await fs.writeFile(tempAnonrcPath, configData);
  await fs.mkdir(tempDataDirPath)

  return tempAnonrcPath;
}
