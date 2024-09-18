import { AnonControlClient } from '../anon-control-client';

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get circuit status before
        const availableCircuitsBefore = await anonControlClient.circuitStatus();
        console.log(JSON.stringify(availableCircuitsBefore, null, 2));

        // close circuit by id
        await anonControlClient.closeCircuit(availableCircuitsBefore[0].circuitId);
        console.log('Closed circuit id:', availableCircuitsBefore[0].circuitId);

        // create new circuit with random servers
        const randomlyCreatedCircuitId = await anonControlClient.extendCircuit();
        console.log('Randomly created circuit id:', randomlyCreatedCircuitId);

        // create new circuit with specific servers
        const manuallyCreatedCircuitId = await anonControlClient.extendCircuit({ serverSpecs: ['A8315F95342E9B0F2B2DD7E929D45FA6383C84DA', 'E7B1769DA63DA3833A08EB6ACF2E910521EA3A9D', 'EF1345BA4D40D877C1F20C6A9C9ACB96E3911B65']});
        console.log('Manually created circuit id:', manuallyCreatedCircuitId);

        //extend circuit with specific server
        const extendedCircuitId = await anonControlClient.extendCircuit({ circuitId: availableCircuitsBefore[1].circuitId, serverSpecs: ['8A6583799233F4344B2829F89655912911259806']});
        console.log('Extended circuit id:', extendedCircuitId);

        // get circuit status after
        const availableCircuitsAfter = await anonControlClient.circuitStatus();
        console.log(JSON.stringify(availableCircuitsAfter, null, 2));

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();