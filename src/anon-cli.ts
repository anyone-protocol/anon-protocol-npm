#!/usr/bin/env node

import { parseArgs } from "util";
import { Anon } from "./anon";
import { AnonConfig } from "./config/config";



const args = parseArgs({
  options: {
    socksPort: {
      type: 'string',
      short: 's',
    },
    orPort: {
      type: 'string',
      short: 'o',
    },
    controlPort: {
      type: 'string',
      short: 'c',
    },
    verbose: {
      type: 'boolean',
      short: 'v',
    },
    binaryPath: {
      type: 'string',
      short: 'b',
    }
  }
});

const anonConfig: AnonConfig = {
  displayLog: args.values.verbose === true,
  socksPort: 9050,
  orPort: 9001,
  controlPort: 9051,
  binaryPath: args.values.binaryPath,
};

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return isFinite(parsed) ? parsed : undefined;
}

const socksPort = parsePort(args.values.socksPort);
if (socksPort !== undefined) anonConfig.socksPort = socksPort;

const orPort = parsePort(args.values.orPort);
if (orPort !== undefined) anonConfig.orPort = orPort;

const controlPort = parsePort(args.values.controlPort);
if (controlPort !== undefined) anonConfig.controlPort = controlPort;

const anon = new Anon(anonConfig);

(async () => {
  await anon.start();
})();

function gracefulShutdown() {
  anon.stop();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
