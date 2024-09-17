import * as net from 'net';

export class AnonControlClient {
    private client: net.Socket;

    constructor(host = '127.0.0.1', port = 9051) {
        console.log('Connecting to Anon Control Port at', host, port);
        
        this.client = net.createConnection({ host, port }, () => {
            console.log('Connected to Anon Control Port');
        });
    }

    authenticate(password: string = 'password'): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.client.write(`AUTHENTICATE "${password}"\r\n`);

            this.client.once('data', (data: Buffer) => {
                const response = data.toString();
                console.log('Control port response:', response);

                if (response.startsWith('250 OK')) {
                    console.log('Authenticated successfully');
                    resolve();
                } else if (response.startsWith('515')) {
                    console.error('Authentication failed');
                    this.client.end();
                    reject('Authentication failed');
                }
            });

            this.client.on('error', (err: Error) => {
                console.error('Control port error:', err);
                reject(err);
            });
        });
    }

    async sendCommand(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.client.write(`${command}\r\n`);

            this.client.once('data', (data: Buffer) => {
                const response = data.toString();
                resolve(response);
            });

            this.client.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    async circuitStatus(): Promise<string> {
        return this.sendCommand('GETINFO circuit-status');
    }

    async extendCircuit(options: ExtendCircuitOptions = {}): Promise<string> {
        // Set default values
        const circuitId = options.circuitId ?? 0;
        const serverSpecs = options.serverSpecs ?? [];
        const purpose = options.purpose ?? 'general';

        // Construct the command
        let command = `EXTENDCIRCUIT ${circuitId}`;

        if (serverSpecs.length > 0) {
            command += ` ${serverSpecs.join(',')}`;
        }

        if (purpose) {
            command += ` purpose=${purpose}`;
        }

        return this.sendCommand(`${command} CRLF`);
    }

    end() {
        this.client.end();
    }
}

interface CircuitStatus {
    circuitId: number;
    state: string;
    relays: Relay[];
    buildFlags: string[];
    purpose: string;
    timeCreated: Date;
}

interface Relay {
    fingerprint: string;
    nickname: string;
}

type Purpose = 'general' | 'controller';

interface ExtendCircuitOptions {
  circuitId?: number;
  serverSpecs?: string[];
  purpose?: Purpose;
}

function parseCircuitStatus(circuitStatusResponse: string): CircuitStatus[] {
    if (!circuitStatusResponse.startsWith('250+circuit-status=')) {
        throw new Error('Invalid response format');
    }

    const cleanedResponse = circuitStatusResponse
        .replace(/^250\+circuit-status=/, '')
        .replace(/250 OK$/, '')

    const circuits: CircuitStatus[] = [];
    const lines = cleanedResponse.split('\n').filter(line => line.trim() !== '');

    for (const line of lines) {
        const trimmedLine = line.trim();
        const parts = trimmedLine.split(' ');

        if (parts.length < 4 || isNaN(parseInt(parts[0], 10))) {
            continue;
        }

        const state = parts[1];
        const circuitId = parseInt(parts[0], 10);
        const relaysPart = parts[2].split(',');
        const relays: Relay[] = relaysPart.map(relay => {
            const [fingerprint, nickname] = relay.split('~');
            return {
                fingerprint: fingerprint.replace(/^\$/, ''),
                nickname: nickname
            };
        });

        const buildFlags = parts.find(part => part.startsWith('BUILD_FLAGS='))
            ?.split('=')[1]?.split(',') || [];
        const purpose = parts.find(part => part.startsWith('PURPOSE='))
            ?.split('=')[1] || '';
        const timeCreated = new Date(parts.find(part => part.startsWith('TIME_CREATED='))
            ?.split('=')[1]+'Z' || ''); // Add Z to make it ISO 8601 compliant

        const circuit: CircuitStatus = {
            circuitId,
            state,
            relays,
            buildFlags,
            purpose,
            timeCreated
        };

        circuits.push(circuit);
    }

    return circuits;
}

async function main() {
    try {
        // connect and authenticate
        const anonControlClient = new AnonControlClient();
        await anonControlClient.authenticate();

        // get circuit status
        const response = await anonControlClient.circuitStatus();
        const circuits = parseCircuitStatus(response);
        console.log(JSON.stringify(circuits, null, 2));

        // create new circuit with random servers
        const resp2 = await anonControlClient.extendCircuit();
        console.log('Extended circuit:', resp2);

        // create new circuit with specific servers
        const response3 = await anonControlClient.extendCircuit({ serverSpecs: ['A8315F95342E9B0F2B2DD7E929D45FA6383C84DA', 'E7B1769DA63DA3833A08EB6ACF2E910521EA3A9D', 'EF1345BA4D40D877C1F20C6A9C9ACB96E3911B65']});
        console.log(response3);

        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
