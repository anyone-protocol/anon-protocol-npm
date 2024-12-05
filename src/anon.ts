import { ChildProcess, spawn, execFile } from 'child_process';
import { AnonConfig, createAnonConfigFile } from './config/config';
import { getBinaryPath } from './utils';
import chalk from 'chalk';

/**
 * Allows to run Anon client with different configuration options
 */
export class Anon {
  private options: AnonConfig = {
    displayLog: false,
    useExecFile: false,
    socksPort: 9050,
    orPort: 0,
    controlPort: 9051,
    binaryPath: undefined,
    autoTermsAgreement: false,
  };
  private process?: ChildProcess;

  public constructor(options?: Partial<AnonConfig>) {
    this.options = { ...this.options, ...options };
  }

   /**
   * Retrieves the SOCKS port number configured for the Anon instance.
   * 
   * @returns {number} The SOCKS port number.
   */
   public getSOCKSPort(): number {
    return this.options.socksPort;
  }

  /**
   * Retrieves the Control port number configured for the Anon instance.
   * 
   * @returns {number} The Control port number.
   */
  public getControlPort(): number {
    return this.options.controlPort;
  }

  /**
   * Retrieves the OR (Onion Routing) port number configured for the Anon instance.
   * 
   * @returns {number} The OR port number.
   */
  public getORPort(): number {
    return this.options.orPort;
  }
  
  /**
   * Starts Anon client with options configured in constructor
   * 
   * @returns {Promise<void>} Promise that resolves when Anon is started
   */
  public async start(): Promise<void> {
    if (this.process !== undefined) {
      throw new Error('Anon process already started');
    }
  
    const configPath = await createAnonConfigFile(this.options);
    const binaryPath = this.options.binaryPath ?? getBinaryPath('anon');
  
    return this.startWithTimeout(binaryPath, configPath);
  }

  private startWithTimeout(binaryPath: string, configPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { cleanup, timeoutId } = this.setupTimeoutHandler(reject);
      try {
        this.process = this.runBinary(binaryPath, configPath, () => this.onStop(), (percentage) => this.handleBootstrapProgess(percentage, resolve, timeoutId));
        this.attachProcessListeners(this.process, cleanup, reject);
      } catch (error) {
        cleanup();
        reject(error);
      }
    })
  }

  private setupTimeoutHandler(reject: (reason: Error) => void){
    const timeoutId = setTimeout(() => {
      reject(new Error('Anon failed to bootstrap within 60 seconds'));
    }, 60000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (this.process) {
        this.process.kill();
        this.process = undefined;
      }
    };

    return { cleanup, timeoutId };
  }

  private handleBootstrapProgess(percentage: number, resolve: () => void, timeoutId: NodeJS.Timeout){
    if (percentage === 100) {
      clearTimeout(timeoutId);
      resolve();
    }
  }

  private attachProcessListeners(process: ChildProcess, cleanup: () => void, reject: (reason: Error) => void){
    this.process?.on('error', (error) => {
      cleanup();
      reject(error);
    });

    this.process?.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        cleanup();
        reject(new Error(`Anon process exited with code ${code}`));
      }
    });
  }



  /**
   * Stops Anon client
   */
  public async stop() {
    if (this.process !== undefined) {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * Allows to check if Anon is running
   * @returns {boolean} true if Anon is running
   */
  public isRunning(): boolean {
    return this.process !== undefined;
  }

  private onStop() {
    this.process = undefined;
  }

  private runBinary(binaryPath: string, configPath: string, onStop?: VoidFunction, onBootstrap?: (percentage: number) => void): ChildProcess {
    let args: Array<string> = [];
    if (configPath !== undefined) {
      args = ['-f', configPath]
    }

    if (this.options?.useExecFile === true) {
      const child = execFile(binaryPath, args);

      child.on('close', () => {
        if (onStop !== undefined) {
          onStop();
        }
      });

      child.on('exit', () => {
        if (onStop !== undefined) {
          onStop();
        }
      });

      return child;
    }

    const child = spawn(binaryPath, args, { detached: false });

    child.stdout.on('data', (data) => {
      const logLines = data.toString().split('\n');
    
      for (const line of logLines) {
        const bootstrapMatch = line.match(/Bootstrapped (\d+)%.*?: (.+)/);
        const versionMatch = line.match(/Anon (\d+\.\d+\.\d+[\w.-]+) .* running on/);
        
        if (this.options?.displayLog === true) {
          console.log(line);
          if (bootstrapMatch) {
            const [, percentage, status] = bootstrapMatch;
            if (onBootstrap) {
              onBootstrap(parseInt(percentage, 10));
            }
          }
        } else {
          const bootstrapMatch = line.match(/Bootstrapped (\d+)%.*?: (.+)/);
          const versionMatch = line.match(/Anon (\d+\.\d+\.\d+[\w.-]+) .* running on/);
          
          if (bootstrapMatch) {
            const [, percentage, status] = bootstrapMatch;
            const formattedPercentage = chalk.green(`${percentage}%`);
            const formattedStatus = chalk.blue(status);
            console.log(`Bootstrapped ${formattedPercentage}: ${formattedStatus}`);

            if (onBootstrap) {
              onBootstrap(parseInt(percentage, 10));
            }

          } else if (line.match(/\[err\]/i)) {
            console.log(chalk.red(line));

          } else if (versionMatch) {
            const [, version] = versionMatch;
            console.log(chalk.yellow(`Running Anon version ${version} `));
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (this.options?.displayLog === true) {
        console.log(`${data}`);
      }
    });

    child.on('close', () => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    child.on('exit', () => {
      if (onStop !== undefined) {
        onStop();
      }
    });

    return child;
  }
}
