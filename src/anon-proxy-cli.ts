#!/usr/bin/env node

import { AnonProxy } from "./anon-proxy";

const anonProxy = new AnonProxy();

(async () => {
  await anonProxy.start(process.argv.slice(2));
})();

function gracefulShutdown() {
  anonProxy.stop();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
