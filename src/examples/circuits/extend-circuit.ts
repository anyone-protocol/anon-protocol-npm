import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit
        const circuits = await anonControlClient.circuitStatus();

        // extend circuit with specific server
        const extendedCircuitId = await anonControlClient.extendCircuit(
            { 
                circuitId: circuits[0].circuitId, 
                serverSpecs: [circuits[1].relays[0].fingerprint]
            }
        );
        console.log('Extended circuit id:', extendedCircuitId);

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
