import { AnonControlClient } from '../../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit status before
        const circuits = await anonControlClient.circuitStatus();

        console.log('Get info about relays from circuit:', circuits[0]);

        const relayInfo0 = await anonControlClient.getRelayInfo(circuits[0].relays[0].fingerprint);
        console.log('Relay [0] info:', relayInfo0);

        const relayInfo1 = await anonControlClient.getRelayInfo(circuits[0].relays[1].fingerprint);
        console.log('Relay [1] info:', relayInfo1);

        const relayInfo2 = await anonControlClient.getRelayInfo(circuits[0].relays[2].fingerprint);
        console.log('Relay [2] info:', relayInfo2);


        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
