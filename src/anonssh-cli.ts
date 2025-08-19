#!/usr/bin/env node

/**
 * AnonSSH CLI - Start Anon proxy and run SSH through it
 */

import { Process } from './process';
import { Config } from './config';
import { spawn } from 'child_process';

interface AnonSSHArgs {
  socksPort?: number;
  orPort?: number;
  controlPort?: number;
  verbose?: boolean;
  config?: string;
  binaryPath?: string;
  agree?: boolean;
  termsFilePath?: string;
  // SSH specific options
  user?: string;
  host: string;
  port?: number;
  sshArgs?: string[];
}

function parseAnonSSHArgs(): AnonSSHArgs {
  const args = process.argv.slice(2);
  let socksPort: number | undefined;
  let orPort: number | undefined;
  let controlPort: number | undefined;
  let verbose = false;
  let config: string | undefined;
  let binaryPath: string | undefined;
  let agree = false;
  let termsFilePath: string | undefined;
  let user: string | undefined;
  let port: number | undefined;
  
  const sshArgs: string[] = [];
  let host: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--socks-port' && args[i + 1]) {
      socksPort = parseInt(args[i + 1], 10);
      if (isNaN(socksPort)) {
        throw new Error('Invalid SOCKS port value');
      }
      i++;
    } else if (arg === '--or-port' && args[i + 1]) {
      orPort = parseInt(args[i + 1], 10);
      if (isNaN(orPort)) {
        throw new Error('Invalid OR port value');
      }
      i++;
    } else if (arg === '--control-port' && args[i + 1]) {
      controlPort = parseInt(args[i + 1], 10);
      if (isNaN(controlPort)) {
        throw new Error('Invalid control port value');
      }
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--config' && args[i + 1]) {
      config = args[i + 1];
      i++;
    } else if (arg === '--binary-path' && args[i + 1]) {
      binaryPath = args[i + 1];
      i++;
    } else if (arg === '--agree') {
      agree = true;
    } else if (arg === '--terms-file-path' && args[i + 1]) {
      termsFilePath = args[i + 1];
      i++;
    } else if (arg === '--user' && args[i + 1]) {
      user = args[i + 1];
      i++;
    } else if (arg === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        throw new Error('Invalid port value');
      }
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: anonssh [options] <host> [ssh-args...]

Options:
  --socks-port <port>     SOCKS port (default: 9050)
  --or-port <port>        OR port (default: 9001)
  --control-port <port>   Control port (default: 9051)
  --verbose, -v           Enable verbose logging
  --config <path>         Config file path
  --binary-path <path>    Binary path
  --agree                 Auto-agree to terms
  --terms-file-path <path> Terms file path
  --user <username>       SSH username
  --port <port>           SSH port (default: 22)
  --help, -h              Show this help

Examples:
  anonssh 11.22.33.44
  anonssh --user root 11.22.33.44
  anonssh --verbose --user admin 11.22.33.44 -p 2222
`);
      process.exit(0);
    } else if (!host && !arg.startsWith('-')) {
      // First non-option argument is the host
      host = arg;
    } else if (host) {
      // All arguments after host are SSH arguments
      sshArgs.push(arg);
    }
  }

  if (!host) {
    throw new Error('Host is required. Use --help for usage information.');
  }

  return {
    socksPort,
    orPort,
    controlPort,
    verbose,
    config,
    binaryPath,
    agree,
    termsFilePath,
    user,
    host,
    port,
    sshArgs
  };
}

function runSSH(host: string, port: number, user?: string, sshArgs: string[] = [], configFile?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sshCommand = 'ssh';
    const sshArgsArray = [
      '-o', `ProxyCommand=nc -X5 -x 127.0.0.1:${port} %h %p`,
      ...(configFile ? ['-F', configFile] : []),
      // If config file is used, let SSH config handle everything
      // If no config file, use user@host format if user is specified
      ...(configFile ? [host] : (user ? [`${user}@${host}`] : [host])),
      ...sshArgs
    ];

    console.log(`Running: ${sshCommand} ${sshArgsArray.join(' ')}`);
    
    const sshProcess = spawn(sshCommand, sshArgsArray, {
      stdio: 'inherit',
      detached: false
    });

    sshProcess.on('close', (code) => {
      // SSH exit codes: 
      // 0 = success, 
      // 1 = general error,
      // 2 = usage error,
      // 255 = connection error,
      // 127 = normal disconnect/exit
      // Treat most exit codes as normal (user-initiated exit or minor issues)
      if (code === 0 || code === 127 || code === 1) {
        resolve();
      } else if (code === 255) {
        // Connection error - this is usually a real problem
        reject(new Error(`SSH connection failed (exit code ${code})`));
      } else {
        // Other exit codes - log but don't treat as fatal
        console.log(`SSH exited with code ${code} (this may be normal)`);
        resolve();
      }
    });

    sshProcess.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    const args = parseAnonSSHArgs();
    
    // Create Anon configuration
    const config: Config = {
      displayLog: args.verbose || false,
      socksPort: args.socksPort || 9050,
      orPort: args.orPort || 9001,
      controlPort: args.controlPort || 9051,
      binaryPath: args.binaryPath,
      autoTermsAgreement: args.agree || false,
      termsFilePath: args.termsFilePath,
    };

    console.log('Starting Anon proxy client...');
    const anon = new Process(config);

    // Start Anon and wait for bootstrap
    await anon.start();
    console.log('Anon proxy is ready!');

    // Run SSH through the proxy
    const socksPort = anon.getSOCKSPort();
    try {
      await runSSH(args.host, socksPort, args.user, args.sshArgs, args.config);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
    } finally {
      await anon.stop();
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Handle graceful shutdown
function gracefulShutdown() {
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Run the main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 