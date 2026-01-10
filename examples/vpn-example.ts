/**
 * VPN Example - Demonstrates using StateManager and VPNManager from the SDK
 *
 * This example shows how to:
 * - Initialize StateManager for generic state tracking
 * - Initialize VPNManager for target-based VPN routing
 * - Configure multiple targets with different exit countries
 * - Monitor events for circuit and stream activity
 */

import chalk from 'chalk';
import {
    Control,
    Process,
    StateManager,
    VPNManager,
    VPNManagerEvent,
} from '../src';

// Convert country code to flag emoji
function countryFlag(code?: string): string {
    if (!code || code.length !== 2) return '🌐';
    const cc = code.toUpperCase();
    return String.fromCodePoint(
        ...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
    );
}

// VPN target configuration
const VPN_TARGETS = [
    { address: 'ip-api.com', exitCountries: ['de'], minCircuits: 1, maxCircuits: 3 },
    { address: 'api.ipify.org', exitCountries: ['fr'], minCircuits: 1, maxCircuits: 3 },
    { address: 'ipinfo.io', exitCountries: ['nl'], minCircuits: 1, maxCircuits: 3 },
];

class VPNExample {
    private anon: Process;
    private control!: Control;
    private stateManager!: StateManager;
    private vpnManager!: VPNManager;
    private shuttingDown = false;
    private _exitResolver?: () => void;

    constructor() {
        this.anon = new Process({ displayLog: true, socksPort: 9050, controlPort: 9051 });
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    async run() {
        try {
            // Start Anon process
            console.log(chalk.cyan('\n🚀 Starting Anon process...'));
            await this.anon.start();

            // Connect to control port
            this.control = new Control();
            await this.control.authenticate();
            console.log(chalk.green('✓ Connected to control port'));

            // Initialize StateManager (only for relay caching, VPNManager handles events)
            console.log(chalk.cyan('\n📦 Loading relay cache...'));
            this.stateManager = new StateManager(this.control, {
                autoSubscribeEvents: false,  // VPNManager will handle events
                cacheRelays: true,
                populateCountries: true,
            });
            await this.stateManager.initialize();
            console.log(chalk.gray(`  ${this.stateManager.getRelays().length} relays loaded`));
            console.log(chalk.gray(`  ${this.stateManager.getGuards().length} guards available`));
            console.log(chalk.gray(`  Countries: ${this.stateManager.getAvailableCountries().slice(0, 10).join(', ')}...`));

            // Initialize VPNManager
            console.log('\n=== Initializing VPNManager ===');
            this.vpnManager = new VPNManager(this.stateManager, {
                targets: VPN_TARGETS,
                healthMonitorInterval: 30000, // 30 seconds
            });

            // Set up VPNManager event listeners
            this.setupVPNManagerListeners();

            await this.vpnManager.initialize();

            // Wait a moment for circuits to start building, then print metrics
            console.log('\nWaiting for circuits to build...');
            await this.delay(5000);
            this.printMetrics();

            console.log('\n=== VPN Example Running ===');
            console.log('Press Ctrl+C to quit.');
            console.log('Try making requests to the configured targets:');
            for (const target of VPN_TARGETS) {
                console.log(`  - ${target.address} (via ${target.exitCountries.join(', ')})`);
            }

            // Wait for exit signal
            await new Promise<void>((resolve) => {
                this._exitResolver = resolve;
            });
        } catch (error) {
            console.error('Error:', error);
            await this.shutdown();
        }
    }


    private setupVPNManagerListeners() {
        this.vpnManager.on(VPNManagerEvent.TARGET_READY, (info) => {
            console.log(`[VPN] Target ${info.target} ready: circuit ${info.circuitId} (${info.country})`);
        });

        this.vpnManager.on(VPNManagerEvent.TARGET_DEGRADED, (info) => {
            console.log(`[VPN] Target ${info.target} DEGRADED: ${info.currentCircuits}/${info.minCircuits} circuits`);
        });

        this.vpnManager.on(VPNManagerEvent.STREAM_ROUTED, (info) => {
            console.log(`[VPN] Routed ${info.target} -> circuit ${info.circuitId}`);
        });
    }

    private printMetrics() {
        const metrics = this.vpnManager.getMetrics();
        console.log('\n=== VPN Metrics ===');
        console.log(`Total circuits: ${metrics.totalCircuits}`);
        console.log(`Total streams: ${metrics.totalStreams}`);
        console.log('Circuits by target:');
        for (const [target, count] of Object.entries(metrics.circuitsByTarget)) {
            console.log(`  ${target}: ${count}`);
        }
        console.log('Circuits by status:');
        for (const [status, count] of Object.entries(metrics.circuitsByStatus)) {
            console.log(`  ${status}: ${count}`);
        }
        console.log('');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        console.log('\n=== Shutting down ===');

        // Print final metrics
        if (this.vpnManager) {
            this.printMetrics();
        }

        // Shutdown VPNManager
        if (this.vpnManager) {
            await this.vpnManager.shutdown();
            console.log('VPNManager shutdown');
        }

        // Shutdown StateManager
        if (this.stateManager) {
            await this.stateManager.shutdown();
            console.log('StateManager shutdown');
        }

        // Close control connection
        if (this.control) {
            this.control.end();
            console.log('Control connection closed');
        }

        // Stop Anon process
        try {
            await this.anon.stop();
            console.log('Anon process stopped');
        } catch (e) {
            console.warn('Error stopping Anon:', e);
        }

        if (this._exitResolver) {
            this._exitResolver();
        }
    }
}

// Main entry point
async function main() {
    const example = new VPNExample();
    await example.run();
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
