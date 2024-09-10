# Anyone Protocol NPM Package

![npm](https://img.shields.io/npm/v/@anyone-protocol/anyone-client.svg)

The official NPM package for the Anyone Protocol. It is a client that can be used to interact with the Anyone Protocol and the ecosystem. Circuits are created through the network that are used to tunnel application or personal traffic to an end destination anonymously.

## Install

```sh
npm install @anyone-protocol/anyone-client
```

## Run Anon Client

```sh
npx anyone-client
```

## Build

```sh
npm run build
```
## CLI Options

Running `npx anyone-client`, will start the client with the following default ports:

- SocksPort: 9050
- ControlPort: 9051
- OrPort: 9001

You can customize the port settings using command-line options:

- -s: Set the SocksPort (default: 9050)
- -c: Set the ControlPort (default: 9051, use 0 to disable)
- -o: Set the OrPort (default: 9001)
- -v: Enable verbose mode for full client logs

### Example:

```sh
npx anyone-client -s 9150 -c 0 -o 9101 -v
```

This command will run the client with the SocksPort set to 9150, ControlPort disabled, OrPort set to 9101 and verbose mode enabled.

When changing ports, ensure they don't conflict with other services on your system.


## Docs

To generate API docs:

```sh
npm run typedoc
```

Docs will be generated to `docs/` directory, open `index.html` to view it