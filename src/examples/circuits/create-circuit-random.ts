import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // create new circuit with random servers
        const randomlyCreatedCircuitId = await anonControlClient.extendCircuit();
        console.log('Randomly created circuit id:', randomlyCreatedCircuitId);

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
