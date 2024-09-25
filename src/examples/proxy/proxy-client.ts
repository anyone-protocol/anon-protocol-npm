import { Anon } from "../../anon";
import { AnonSocksClient } from "../../anon-socks-client";

async function main() {
    try {
        // connect to AnonControl
        const anon = new Anon({ displayLog: true, socksPort: 9050, controlPort: 9051 });
        const anonSocksClient = new AnonSocksClient(anon);
        await anon.start();

        // wait for Anon to start
        await new Promise(resolve => setTimeout(resolve, 15000));
        console.log('Anon started');
        
        // make a request
        const response = await anonSocksClient.get('https://api.ipify.org?format=json');
        console.log('Response:', response.data);

        // stop Anon
        await anon.stop();

    } catch (error) {
        console.error('Error:', error);
    }
}

main();