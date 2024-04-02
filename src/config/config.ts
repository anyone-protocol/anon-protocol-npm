import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface ConfigOptions {
  socksPort?: number;
}

export async function createConfig(options?: ConfigOptions) {
  const tempAnonrcName = `anonrc-${Date.now()}`;
  const tempAnonrcPath = path.join(os.tmpdir(), tempAnonrcName);

  const tempDataDirName = `anon-data-${Date.now()}`;
  const tempDataDirPath = path.join(os.tmpdir(), tempDataDirName);

  let configItems = [
    `DataDirectory ${tempDataDirPath}`,
  ];

  if (options !== undefined) {
    if (options.socksPort !== undefined) {
      configItems.push(`SOCKSPort ${options.socksPort}`);
    }
  }

  const configData = configItems.join("\n");
  await fs.writeFile(tempAnonrcPath, configData);
  await fs.mkdir(tempDataDirPath)

  return tempAnonrcPath;
}
