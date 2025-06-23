import { Process, BootstrapProgressEvent } from '../src/process';

async function main() {
    console.log('Starting Anon with event listeners...');
    
    // Create Anon instance
    const anon = new Process({ displayLog: false, socksPort: 9050, controlPort: 9051 });
    
    // Listen to start event
    anon.on('start', (event) => {
        console.log('Anon process started at:', event.timestamp);
    });
    
    // Listen to bootstrap progress events
    anon.on('bootstrap-progress', (event: BootstrapProgressEvent) => {
        console.log(`Bootstrap progress: ${event.percentage}% - ${event.status}`);
    });
    
    // Listen to bootstrap complete event
    anon.on('bootstrap-complete', (event) => {
        console.log('Bootstrap complete');
    });
    
    // Listen to stop event
    anon.on('stop', (event) => {
        console.log('Anon process stopped');
    });
    
    try {
        // Start Anon
        await anon.start();
        await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (error) {
        console.error('Error:', error);
    } finally {
        // Stop Anon
        await anon.stop();
        console.log('Example completed.');
    }
}

main(); 