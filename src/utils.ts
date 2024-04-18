import * as os from 'os';
import path from 'path';

export function getBinaryPath(binaryName: string): string {
    const platform = os.platform();
    const arch = os.arch();

    let binaryPath = path.join(__dirname, '..', 'bin', platform, arch, binaryName);
    if (platform === 'win32') {
      binaryPath += '.exe';
    }

    return path.resolve(binaryPath);
}
