# Anon Protocol NPM Package

## Install

```sh
npm install @anyone-protocol/anyone-client
```

## Run Anon Client

```sh
npx anon-protocol
```

## Run Anon Proxy (Example Usage)

```sh
npx anon-proxy curl icanhazip.com
```

## Build

```sh
npm run build
```

## Usage Example (Typescript)

```typescript
import { Anon } from '@anyone-protocol/anyone-client';
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';

const socksPort = 9050;

// Create Anon client
const anon = new Anon({ socksPort });

// Set up axios to use Anon
const proxyOptions = `socks5h://127.0.0.1:${socksPort}`;
const httpAgent = new SocksProxyAgent(proxyOptions);
const httpsAgent = httpAgent;
const client = axios.create({ httpAgent, httpsAgent });

(async () => {
  // Start Anon client
  await anon.start();

  // Make a HTTP request to API
  const resp = await axios.get('https://api.ipify.org?format=json');

  // Make a HTTP request to API using Anon
  const anonResp = await client.get('https://api.ipify.org?format=json');

  // Log responses
  console.log(`Real IP: ${resp.data.ip}`);
  console.log(`Anon IP: ${anonResp.data.ip}`);

  // Stop Anon client
  await anon.stop();
})();

function shutdown() {
  anon.stop();
  process.exit(0);
}

// Graceful shutdown
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

Response should look like:

```
Real IP: 94.16.115.212
Anon IP: 89.58.10.128
```

## Docs

To generate API docs:

```sh
npm run typedoc
```

Docs will be generated to `docs/` directory, open `index.html` to view it