#!/usr/bin/env node

import { parseArgs } from "util";
import { Anon } from "./anon";

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
    }
  }
});

let socksPort: number | undefined = undefined;
if (args.values.socksPort !== undefined) {
  const value = parseInt(args.values.socksPort);
  if (isFinite(value)) {
    socksPort = value;
  }
}

let orPort: number | undefined = undefined;
if (args.values.orPort !== undefined) {
  const value = parseInt(args.values.orPort);
  if (isFinite(value)) {
    orPort = value;
  }
}

let controlPort: number | undefined = undefined;
if (args.values.controlPort !== undefined) {
  const value = parseInt(args.values.controlPort);
  if (isFinite(value)) {
    controlPort = value;
  }
}

const anon = new Anon({ displayLog: true, socksPort: socksPort, orPort: orPort, controlPort: controlPort });

(async () => {
  await anon.start();
})();

function gracefulShutdown() {
  anon.stop();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
