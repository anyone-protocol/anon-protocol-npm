import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit status before
        const circuits = await anonControlClient.circuitStatus();

        const addresses = await anonControlClient.getRelayInfo(circuits[0].relays[0].fingerprint);
        console.log('Relay info:', addresses);

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