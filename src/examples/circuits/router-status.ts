import { AnonControlClient } from "../../anon-control-client";

async function main() {
    try {
        // connect to AnonControl
        const anonControlClient = new AnonControlClient();

        // authenticate
        await anonControlClient.authenticate();

        // get router status (all relays in consensus)
        const routerStatus = await anonControlClient.routerStatus();

        // pretty print available relays
        console.log(JSON.stringify(routerStatus, null, 2));

        // close connection
        anonControlClient.end();
    } catch (error) {
        console.error('Error:', error);
    }
}

main();