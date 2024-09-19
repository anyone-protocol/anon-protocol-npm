import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit status before
        const circuits = await anonControlClient.circuitStatus();

        // close circuit by id
        await anonControlClient.closeCircuit(circuits[0].circuitId);
        console.log('Closed circuit id:', circuits[0].circuitId);

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
