import {CircEvent, CircHop, Control, EventType, Flag, Process, RelayInfo, StreamEvent} from '../src';
import {randomInt} from "node:crypto";

type StreamEntry = {
    id: number;
    target?: string;
    status?: string;
    circId?: number;
};

type CircuitEntry = {
    id: number;
    path?: CircHop[];
    status?: string;
    country?: string;
    target?: string;  // Which target this circuit serves
    createdAt: Date;
    streamCount: number;
};

type VPNTarget = {
    address: string;
    exitCountries: string[];
    minCircuits: number;
    maxCircuits: number;
};

class StateManager {
    private control!: Control;
    private anon: Process;
    private shuttingDown = false;
    private streams: Map<number, StreamEntry> = new Map();
    private circuits: Map<number, CircuitEntry> = new Map();
    private healthMonitorInterval?: NodeJS.Timeout;

    // VPN Configuration
    private targets: VPNTarget[] = [
        { address: 'ip-api.com', exitCountries: ['de'], minCircuits: 1, maxCircuits: 3 },
        { address: 'api.ipify.org', exitCountries: ['us'], minCircuits: 1, maxCircuits: 3 },
        { address: 'ipinfo.io', exitCountries: ['nl'], minCircuits: 1, maxCircuits: 3 },
    ];

    private sites: string[] = [
        'ip-api.com',
        'api.ipify.org',
        'ipinfo.io'
    ];

    // Relay cache
    private availableRelays: RelayInfo[] = [];
    private exitsByCountry: Map<string, RelayInfo[]> = new Map();
    private guards: RelayInfo[] = [];

    constructor() {
        this.anon = new Process({displayLog: true, socksPort: 9050, controlPort: 9051});
        process.on('SIGINT', this.shutdown.bind(this));
        process.on('SIGTERM', this.shutdown.bind(this));
    }

    async run() {
        try {
            await this.anon.start();
            this.control = new Control();
            console.log('Anon started');

            await this.control.authenticate();
            // await this.control.disablePredictedCircuits();
            console.log('Predicted circuits disabled - we control all circuits');
            await this.control.disableStreamAttachment();
            console.log("Stream auto-attachment disabled - we will attach streams manually");
            await this.control.enableCircuitEventListener();

            // Initialize relay information (now safe - correlation-based request handling)
            // await this.initializeRelays();

            // Build initial circuits for all targets
            // await this.buildInitialCircuits();

            // Set up event listeners
            await this.setupEventListeners();

            // Start circuit health monitor
            // this.startCircuitHealthMonitor();

            console.log('Anon state manager is active. Press Ctrl+C to quit.');
            console.log(`Managing ${this.targets.length} targets with ${this.circuits.size} circuits`);

            await new Promise<void>((resolve) => {
                this._exitPromiseResolver = resolve;
            });
        } catch (error) {
            console.error('Error:', error);
            await this.shutdown();
        }
    }

    private async initializeRelays() {
        console.log('Fetching relay information...');
        const relays = await this.control.getRelays();
        console.log(`Total relays: ${relays.length}`);

        // Filter for quality exits
        let exits = this.control.filterRelaysByFlags(relays, Flag.Exit, Flag.Running);
        exits = exits.filter((exit) => !exit.flags.includes(Flag.BadExit));
        console.log(`Quality exits: ${exits.length}`);

        // Populate country information for exits
        console.log('Populating country information for exits...');
        await this.control.populateCountries(exits);

        // Group exits by country
        for (const exit of exits) {
            if (!exit.country) continue;
            const country = exit.country.toLowerCase();
            if (!this.exitsByCountry.has(country)) {
                this.exitsByCountry.set(country, []);
            }
            this.exitsByCountry.get(country)!.push(exit);
        }

        console.log(`Exits grouped by ${this.exitsByCountry.size} countries`);

        // Get guards
        this.guards = this.control.filterRelaysByFlags(relays, Flag.Guard, Flag.Stable, Flag.Running, Flag.Fast);
        console.log(`Quality guards: ${this.guards.length}`);

        this.availableRelays = relays;
    }

    private async buildInitialCircuits() {
        console.log('\n=== Building Initial Circuits ===');

        for (const target of this.targets) {
            console.log(`\nBuilding circuits for ${target.address}:`);
            console.log(`  Target countries: ${target.exitCountries.join(', ')}`);
            console.log(`  Min circuits: ${target.minCircuits}`);

            for (let i = 0; i < target.minCircuits; i++) {
                try {
                    this.buildCircuitForTarget(target);
                } catch (error) {
                    console.error(`  Failed to build circuit ${i + 1}:`, error);
                }
            }
        }

        console.log('\n=== Circuit Build Complete ===');
    }

    private async buildCircuitForTarget(target: VPNTarget): Promise<number | null> {
        // Select relays for this target
        const relays = this.selectRelaysForTarget(target);
        if (!relays) {
            console.warn(`  No suitable relays found for ${target.address}`);
            return null;
        }

        const [guard, middle, exit] = relays;
        console.log(`  Building 3-hop circuit:`);
        console.log(`    Guard:  ${guard.nickname} (${guard.country || '??'})`);
        console.log(`    Middle: ${middle.nickname} (${middle.country || '??'})`);
        console.log(`    Exit:   ${exit.nickname} (${exit.country})`);

        try {
            const circuitId = await this.control.extendCircuit({
                circuitId: 0,
                serverSpecs: [guard.fingerprint, middle.fingerprint, exit.fingerprint],
                purpose: "general",
                awaitBuild: true
            });

            console.log(`  ✓ Circuit ${circuitId} built successfully`);
            return circuitId;
        } catch (error) {
            console.error(`  ✗ Circuit build failed:`, error);
            return null;
        }
    }

    private selectRelaysForTarget(target: VPNTarget): [RelayInfo, RelayInfo, RelayInfo] | null {
        // Collect all possible exits for target countries
        const possibleExits: RelayInfo[] = [];
        for (const country of target.exitCountries) {
            const exits = this.exitsByCountry.get(country.toLowerCase()) || [];
            possibleExits.push(...exits);
        }

        // Get middle relays (relays that are not guards or exits)
        const middleRelays = this.availableRelays.filter(relay =>
            relay.flags.includes(Flag.Running) &&
            relay.flags.includes(Flag.Stable) &&
            !relay.flags.includes(Flag.BadExit)
        );

        if (possibleExits.length === 0 || this.guards.length === 0 || middleRelays.length === 0) {
            return null;
        }

        // Randomly select guard, middle, and exit (ensure they're different)
        const guard = this.guards[randomInt(this.guards.length)];
        const middle = middleRelays[randomInt(middleRelays.length)];
        const exit = possibleExits[randomInt(possibleExits.length)];

        // Make sure they're all different relays
        if (guard.fingerprint === middle.fingerprint ||
            guard.fingerprint === exit.fingerprint ||
            middle.fingerprint === exit.fingerprint) {
            // Retry with different selection (simple approach)
            return this.selectRelaysForTarget(target);
        }

        return [guard, middle, exit];
    }

    private async setupEventListeners() {
        // Stream event listener
        const streamEventListener = async (event: StreamEvent) => {
            const streamId = event.streamId;
            let se = this.streams.get(streamId);

            const circId = event.circId;

            if (circId !== 0 && this.circuits.has(circId) && event.status === 'SUCCEEDED') {
                let country = this.circuits.get(circId)!.country;
                console.log(`Stream Event: ID=${streamId} Target=${event.target} Circ=${circId} ( ${flagEmoji(country)} )`);
            }

            if (!se) {
                se = {
                    id: streamId,
                    target: event.target,
                    status: event.status,
                    circId: circId
                };
                this.streams.set(streamId, se);
            } else {
                se.status = event.status;
                se.circId = circId;
                se.target = event.target;
            }

            if (se.status === 'CLOSED') {
                // Decrement stream count on circuit
                if (se.circId && se.circId !== 0) {
                    const circ = this.circuits.get(se.circId);
                    if (circ) {
                        circ.streamCount = Math.max(0, circ.streamCount - 1);
                    }
                }
                this.streams.delete(streamId);
            }

            // Attach stream if needed
            await this.attachStreamIfNeeded(event);
        };

        // Circuit event listener
        const circEventListener = async (event: CircEvent) => {
            const circId = event.circId;
            let ce = this.circuits.get(circId);

            if (!ce) {
                ce = {
                    id: circId,
                    status: event.status,
                    path: event.path,
                    createdAt: new Date(),
                    streamCount: 0
                };
                this.circuits.set(circId, ce);
            } else {
                const oldStatus = ce.status;
                ce.status = event.status;
                ce.path = event.path;

                // When circuit becomes BUILT, get country info and assign target
                if (ce.status === 'BUILT' && oldStatus !== 'BUILT') {
                    if (ce.path && ce.path.length > 0) {
                        try {
                            const exitRelay = await this.control.getRelayInfo(ce.path[ce.path.length - 1].fingerprint);
                            ce.country = await this.control.getCountry(exitRelay.ip);

                            // Assign target based on country
                            // ce.target = this.assignTargetToCircuit(ce);

                            // if (ce.target) {
                            //     console.log(`Circuit ${circId} BUILT: [${exitRelay.nickname} - ${exitRelay.ip} - ${ce.country}] -> assigned to ${ce.target}`);
                            // }
                        } catch (error) {
                            console.warn(`Could not get country for circuit ${circId}:`, error instanceof Error ? error.message : error);
                            // Circuit is still usable, just without country assignment
                        }
                    }
                }
            }

            // Handle circuit closure/failure
            if (ce.status === 'CLOSED' || ce.status === 'FAILED') {
                const wasAssigned = ce.target;
                this.circuits.delete(circId);

                if (ce.status === 'FAILED') {
                    console.log(`Circuit ${circId} FAILED: ${event.reason} / ${event.remoteReason}`);
                }

                // Rebuild circuit for target if needed
                if (wasAssigned) {
                    this.ensureCircuitsForTarget(wasAssigned);
                }
            }
        };

        await this.control.addEventListener(streamEventListener, EventType.STREAM);
        await this.control.addEventListener(circEventListener, EventType.CIRC);
    }

    private assignTargetToCircuit(circuit: CircuitEntry): string | undefined {
        if (!circuit.country) return undefined;

        // Find which target this circuit should serve based on exit country
        for (const target of this.targets) {
            if (target.exitCountries.includes(circuit.country.toLowerCase())) {
                return target.address;
            }
        }

        return undefined;
    }

    private async attachStreamIfNeeded(streamEvent: StreamEvent) {
        const streamId = streamEvent.streamId;
        const se = this.streams.get(streamId);

        if (!se || (se.status !== 'NEW' && se.status !== 'DETACHED')) return;

        const target = streamEvent.target.split(":")[0];

        // Check if this is one of our managed targets
        const isManaged = this.sites.some(s => target === s);

        if (isManaged) {
            // Find circuits for this target
            // const circuits = this.getCircuitsForTarget(target);
            //
            // if (circuits.length === 0) {
            //     console.warn(`No circuits available for ${target}, using default`);
            //     await this.control.attachStream(streamId, 0);
            //     return;
            // }

            // Select circuit with least streams (load balancing)
            // const circuit = circuits.reduce((min, c) =>
            //     c.streamCount < min.streamCount ? c : min
            // );

            // get random circuit for target
            const circuit = [...this.circuits.values()][randomInt(this.circuits.size - 1)];

            const attached = await this.control.attachStream(streamId, circuit.id);

            if (attached) {
                circuit.streamCount++;
                console.log(`Stream ${streamId} -> Circuit ${circuit.id} - ${target} -> ( ${flagEmoji(circuit.country)} ) [${circuit.streamCount} streams]`);
            } else {
                console.warn(`Failed to attach stream ${streamId} to circuit ${circuit.id}`);
            }
        } else {
            // Not a managed target, use default attachment
            // console.log("Attaching stream to default circuit for unmanaged target:", target);
            await this.control.attachStream(streamId, 0);
        }
    }

    private getCircuitsForTarget(target: string): CircuitEntry[] {
        return [...this.circuits.values()].filter(
            c => c.status === 'BUILT' && c.target === target
        );
    }

    private startCircuitHealthMonitor() {
        // Check circuit health every 30 seconds
        this.healthMonitorInterval = setInterval(() => {
            this.checkCircuitHealth();
        }, 10000);
    }

    private async checkCircuitHealth() {
        for (const target of this.targets) {
            await this.ensureCircuitsForTarget(target.address);
        }
    }

    private async ensureCircuitsForTarget(targetAddress: string) {
        const target = this.targets.find(t => t.address === targetAddress);
        if (!target) return;

        const circuits = this.getCircuitsForTarget(targetAddress);
        const needed = target.minCircuits - circuits.length;

        if (needed > 0) {
            console.log(`\n⚠ Target ${targetAddress} needs ${needed} more circuit(s)`);
            for (let i = 0; i < needed; i++) {
                try {
                    await this.buildCircuitForTarget(target);
                } catch (error) {
                    console.error(`Failed to rebuild circuit:`, error);
                }
            }
        }
    }

    private printCircuitSummary() {
        console.log('\n=== Circuit Summary ===');
        for (const target of this.targets) {
            const circuits = this.getCircuitsForTarget(target.address);
            console.log(`${target.address}: ${circuits.length} circuits`);
            for (const circuit of circuits) {
                console.log(`  - Circuit ${circuit.id} (${circuit.country})`);
            }
        }
        console.log('');
    }

    getMetrics() {
        const metrics = {
            totalCircuits: this.circuits.size,
            totalStreams: this.streams.size,
            circuitsByTarget: {} as Record<string, number>,
            circuitsByStatus: {} as Record<string, number>,
        };

        // Circuits by target
        for (const target of this.targets) {
            metrics.circuitsByTarget[target.address] = this.getCircuitsForTarget(target.address).length;
        }

        // Circuits by status
        for (const circuit of this.circuits.values()) {
            const status = circuit.status || 'unknown';
            metrics.circuitsByStatus[status] = (metrics.circuitsByStatus[status] || 0) + 1;
        }

        return metrics;
    }

    private _exitPromiseResolver?: () => void;

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        console.log('\n=== Shutting down Anon SDK ===');

        // Clear health monitor interval
        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            console.log('Health monitor stopped');
        }

        // Print final metrics
        const metrics = this.getMetrics();
        console.log('Final metrics:', metrics);

        try {
            if (this.control) await this.control.end();
            console.log('Control connection closed');
        } catch (e) {
            console.warn('Control shutdown error:', e);
        }

        try {
            await this.anon.stop();
            console.log('Anon process stopped');
        } catch (e) {
            console.warn('Anon shutdown error:', e);
        }

        if (this._exitPromiseResolver) this._exitPromiseResolver();
    }
}

function flagEmoji(code?: string): string {
    if (!code || code.length !== 2) return '🏳️';
    const cc = code.toUpperCase();
    return String.fromCodePoint(
        ...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
    );
}

async function main() {
    const manager = new StateManager();
    await manager.run();

    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled Rejection:', reason);
        process.exit(1);
    });
}

main();