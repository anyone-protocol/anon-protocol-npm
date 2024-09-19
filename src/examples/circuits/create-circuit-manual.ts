import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit status before
        const circuits = await anonControlClient.circuitStatus();

        // create new circuit with random servers
        const randomlyCreatedCircuitId = await anonControlClient.extendCircuit(
            {
                serverSpecs: [
                    circuits[0].relays[0].fingerprint, 
                    circuits[1].relays[1].fingerprint, 
                    circuits[2].relays[2].fingerprint
                ]
            }
        );
        console.log('Randomly created circuit id:', randomlyCreatedCircuitId);

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();