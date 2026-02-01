/**
 * VPN 2-Hop Example - Demonstrates 2-hop circuit building
 *
 * This example shows how to:
 * - Configure targets with hopCount: 2 for faster, 2-hop circuits (guard + exit)
 * - Mix 2-hop and 3-hop targets in the same VPNManager
 */

import chalk from 'chalk';
import {
    Control,
    Process,
    StateManager,
    VPNManager,
    VPNManagerEvent,
} from '../src';

// VPN target configuration with 2-hop circuits
const VPN_TARGETS = [
    { address: 'ip-api.com', exitCountries: ['de'], minCircuits: 1, maxCircuits: 3, hopCount: 2 as const },
    { address: 'api.ipify.org', exitCountries: ['fr'], minCircuits: 1, maxCircuits: 3, hopCount: 2 as const },
    { address: 'ipinfo.io', exitCountries: ['nl'], minCircuits: 1, maxCircuits: 3, hopCount: 2 as const },
];

class VPN2HopExample {
    private anon: Process;
    private control!: Control;
    private stateManager!: StateManager;
    private vpnManager!: VPNManager;
    private shuttingDown = false;
    private _exitResolver?: () => void;

    constructor() {
        this.anon = new Process({ displayLog: false, socksPort: 9050, controlPort: 9051 });
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
                autoSubscribeEvents: false,
                cacheRelays: true,
                populateCountries: true,
            });
            await this.stateManager.initialize();
            console.log(chalk.gray(`  ${this.stateManager.getRelays().length} relays loaded`));
            console.log(chalk.gray(`  ${this.stateManager.getGuards().length} guards available`));
            console.log(chalk.gray(`  Countries: ${this.stateManager.getAvailableCountries().slice(0, 10).join(', ')}...`));

            // Initialize VPNManager with 2-hop targets
            console.log('\n=== Initializing VPNManager (2-hop) ===');

            this.vpnManager = new VPNManager(this.stateManager, {
                targets: VPN_TARGETS,
                healthMonitorInterval: 30000,
                disablePredictedCircuits: true,
                disableConflux: true,
            });

            await this.vpnManager.initialize();

            // Resume background resolution
            this.stateManager.resumeBackgroundResolution();

            // Wait a moment for circuits to start building
            console.log('\nWaiting for 2-hop circuits to build...');
            await this.delay(5000);

            console.log('\n=== VPN 2-Hop Example Running ===');
            console.log('Press Ctrl+C to quit.');
            console.log('Targets (2-hop circuits):');
            for (const target of VPN_TARGETS) {
                console.log(`  - ${target.address} (via ${target.exitCountries.join(', ')}, ${target.hopCount}-hop)`);
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

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        console.log('\n=== Shutting down ===');

        if (this.stateManager) {
            this.stateManager.stopBackgroundResolution();
        }

        if (this.control) {
            try {
                this.control.end();
            } catch (e) {
                // Ignore errors during shutdown
            }
        }

        try {
            await this.anon.stop();
        } catch (e) {
            // Ignore errors during shutdown
        }

        console.log('Shutdown complete');

        if (this._exitResolver) {
            this._exitResolver();
        }

        setTimeout(() => process.exit(0), 100);
    }
}

// Main entry point
async function main() {
    const example = new VPN2HopExample();
    await example.run();
}

main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
