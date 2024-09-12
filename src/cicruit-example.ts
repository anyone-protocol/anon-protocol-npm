import * as net from 'net';

// Function to connect to the control port and send commands
function connectToControlPort(password: string, host = '127.0.0.1', port = 9051): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port }, () => {
            console.log('Connected to Tor Control Port');
            // Send the AUTHENTICATE command with the control port password
            client.write(`AUTHENTICATE "${password}"\r\n`);
        });

        client.on('data', (data: Buffer) => {
            const response = data.toString();
            console.log('Control port response:', response);

            if (response.startsWith('250 OK')) {
                console.log('Authenticated successfully');
                resolve(client);
            } else if (response.startsWith('515')) {
                console.error('Authentication failed');
                client.end();
                reject('Authentication failed');
            }
        });

        client.on('error', (err: Error) => {
            console.error('Control port error:', err);
            reject(err);
        });

        client.on('end', () => {
            console.log('Disconnected from control port');
        });
    });
}

// Function to send a command to the control port
function sendCommand(client: net.Socket, command: string) {
    return new Promise<void>((resolve, reject) => {
        client.write(`${command}\r\n`);

        client.on('data', (data: Buffer) => {
            const response = data.toString();
            console.log(`Response for "${command}":`, response);
            if (response.startsWith('250')) {
                const circuits = parseCircuitStatus(response);
                console.log(circuits);
                resolve();
            } else {
                reject(`Error response: ${response}`);
            }
        });
    });
}

// Example usage: connect and fetch circuit status
async function main() {
    const controlPortPassword = 'password'; // Change to your control port password

    try {
        const client = await connectToControlPort(controlPortPassword);

        // Send GETINFO circuit-status command to the control port
        await sendCommand(client, 'GETINFO circuit-status');

        // You can add more commands or close the connection
        client.end(); // Close the connection when you're done
    } catch (error) {
        console.error('Error:', error);
    }
}

interface Circuit {
    parts: string[];
}

function parseCircuitStatus(circuitStatusResponse: string): Circuit[] {
    const circuits: Circuit[] = [];
    const lines = circuitStatusResponse.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine === '') {
            // Skip empty lines
            continue;
        }

        // Match lines starting with a number followed by "BUILT"
        const match = /^(\d+) BUILT\s+(.+)$/.exec(trimmedLine);
        if (match) {
            const parts = line.split(' ');

            // Create the Circuit object with the number included
            const circuit: Circuit = {
                parts
            };

            // Add to the circuits array
            circuits.push(circuit);
        }
    }

    return circuits;
}

main();