# Anon Protocol NPM Package

## Install

```sh
npm install anon-protocol
```

## Run Anon Client

```sh
npx anon-protocol
```

## Build

```sh
npm run build
```

## Usage Example (Typescript)

```typescript
import { Anon } from 'anon-protocol';
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';

const socksPort = 9050;

// Create Anon client
const anon = new Anon({ socksPort });

// Set up axios to use Anon
const proxyOptions = `socks5://127.0.0.1:${socksPort}`;
const httpsAgent = new SocksProxyAgent(proxyOptions);
const client = axios.create({ httpsAgent });

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