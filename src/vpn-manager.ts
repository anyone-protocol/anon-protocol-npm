import { EventEmitter } from 'events';
import { randomInt } from 'node:crypto';
import chalk from 'chalk';
import { StateManager } from './state-manager';
import {
    AddrMapEvent,
    CircEvent,
    CircuitEntry,
    EventType,
    Flag,
    RelayInfo,
    StreamEvent,
    VPNManagerConfig,
    VPNManagerEvent,
    VPNMetrics,
    VPNTarget,
} from './models';

// Convert country code to flag emoji
function countryFlag(code?: string): string {
    if (!code || code.length !== 2) return '🌐';
    const cc = code.toUpperCase();
    return String.fromCodePoint(
        ...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
    );
}

/**
 * VPNManager provides VPN-style routing with per-target circuit pools.
 *
 * This class builds on top of StateManager and listens directly to Control events
 * for reliable stream/circuit handling.
 */
export class VPNManager extends EventEmitter {
    private stateManager: StateManager;
    private config: Required<VPNManagerConfig>;
    private targets: VPNTarget[];

    // Circuit tracking
    private circuits: Map<number, CircuitEntry & { target?: string; streamCount: number }> = new Map();
    private pendingCircuitTargets: Map<number, string> = new Map();

    // Stream tracking
    private streams: Map<number, { id: number; target?: string; status?: string; circId?: number }> = new Map();
    private loggedStreams: Set<number> = new Set(); // Track host+circuit combos we've already logged

    // IP to hostname mapping
    private ipToHostname: Map<string, string> = new Map();

    // Health monitoring
    private healthMonitorInterval?: NodeJS.Timeout;

    // Lifecycle
    private isInitialized: boolean = false;
    private isShuttingDown: boolean = false;

    // Event handlers (for cleanup)
    private circEventHandler: ((event: CircEvent) => void) | null = null;
    private streamEventHandler: ((event: StreamEvent) => void) | null = null;
    private addrMapEventHandler: ((event: AddrMapEvent) => void) | null = null;

    constructor(stateManager: StateManager, config: VPNManagerConfig) {
        super();
        this.stateManager = stateManager;
        this.config = {
            targets: config.targets,
            healthMonitorInterval: config.healthMonitorInterval ?? 10000,
            disablePredictedCircuits: config.disablePredictedCircuits ?? false,
            disableConflux: config.disableConflux ?? false,
        };
        this.targets = [...config.targets];
    }

    // ==================== Lifecycle ====================

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            throw new Error('VPNManager is already initialized');
        }

        if (!this.stateManager.isReady()) {
            throw new Error('StateManager must be initialized before VPNManager');
        }

        const control = this.stateManager.getControl();

        // Disable automatic stream attachment - we handle it
        console.log(chalk.gray('  Disabling stream auto-attachment...'));
        await control.disableStreamAttachment();
        console.log(chalk.gray('  ✓ Stream auto-attachment disabled'));

        // Optionally disable Anon's own circuit building
        if (this.config.disablePredictedCircuits) {
            console.log(chalk.gray('  Disabling predicted circuits...'));
            await control.disablePredictedCircuits();
            console.log(chalk.gray('  ✓ Predicted circuits disabled'));
        }

        if (this.config.disableConflux) {
            try {
                await control.setConf('ConfluxEnabled', '0');
                console.log(chalk.gray('  ✓ Conflux disabled'));
            } catch {
                // ConfluxEnabled may not be supported in this version
            }
        }

        // Set up event listeners DIRECTLY on Control (like working example)
        await this.setupEventListeners();
        console.log(chalk.gray('  ✓ Event listeners registered'));

        // Build initial circuits for all targets
        await this.buildInitialCircuits();

        // Start health monitoring
        if (this.config.healthMonitorInterval > 0) {
            this.startHealthMonitor();
            console.log(chalk.gray(`  ✓ Health monitor started (${this.config.healthMonitorInterval / 1000}s interval)`));
        }

        this.isInitialized = true;
        console.log(chalk.green('✓ VPNManager initialized'));
    }

    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        this.stopHealthMonitor();

        const control = this.stateManager.getControl();

        // Restore settings changed during init
        try {
            if (this.config.disablePredictedCircuits) {
                await control.enablePredictedCircuits();
            }
            if (this.config.disableConflux) {
                await control.setConf('ConfluxEnabled', '1');
            }
            await control.enableStreamAttachment();
        } catch {
            // Ignore errors during shutdown
        }

        // Remove event listeners
        if (this.circEventHandler) {
            await control.removeEventListener(this.circEventHandler);
        }
        if (this.streamEventHandler) {
            await control.removeEventListener(this.streamEventHandler);
        }
        if (this.addrMapEventHandler) {
            await control.removeEventListener(this.addrMapEventHandler);
        }

        this.circuits.clear();
        this.streams.clear();
        this.pendingCircuitTargets.clear();
        this.ipToHostname.clear();

        this.isInitialized = false;
    }

    isReady(): boolean {
        return this.isInitialized && !this.isShuttingDown;
    }

    // ==================== Event Listeners (Direct to Control) ====================

    private async setupEventListeners(): Promise<void> {
        const control = this.stateManager.getControl();

        // ADDRMAP event listener - maps IP addresses to hostnames
        this.addrMapEventHandler = (event: AddrMapEvent) => {
            if (event.address && event.mappedAddress) {
                this.ipToHostname.set(event.mappedAddress, event.address);
            }
        };

        // Stream event listener
        this.streamEventHandler = async (event: StreamEvent) => {
            await this.handleStreamEvent(event);
        };

        // Circuit event listener
        this.circEventHandler = async (event: CircEvent) => {
            await this.handleCircuitEvent(event);
        };

        await control.addEventListener(this.addrMapEventHandler, EventType.ADDRMAP);
        await control.addEventListener(this.streamEventHandler, EventType.STREAM);
        await control.addEventListener(this.circEventHandler, EventType.CIRC);
    }

    // ==================== Circuit Event Handling ====================

    private async handleCircuitEvent(event: CircEvent): Promise<void> {
        const circId = event.circId;
        let circuit = this.circuits.get(circId);

        if (!circuit) {
            circuit = {
                id: circId,
                status: event.status,
                path: event.path,
                createdAt: new Date(),
                metadata: {},
                streamCount: 0,
            };
            this.circuits.set(circId, circuit);
        } else {
            const oldStatus = circuit.status;
            circuit.status = event.status;
            circuit.path = event.path;

            // When circuit becomes BUILT, get country and assign target
            if (circuit.status === 'BUILT' && oldStatus !== 'BUILT') {
                await this.onCircuitBuilt(circuit);
            }
        }

        // Handle circuit closure/failure
        if (event.status === 'CLOSED' || event.status === 'FAILED') {
            const closedCircuit = this.circuits.get(circId);
            this.circuits.delete(circId);
            this.pendingCircuitTargets.delete(circId);

            if (closedCircuit?.target) {
                // Rebuild if needed
                this.ensureCircuitsForTarget(closedCircuit.target);
            }

        }
    }

    private async onCircuitBuilt(circuit: CircuitEntry & { target?: string; streamCount: number }): Promise<void> {
        const control = this.stateManager.getControl();

        // Get country info
        if (circuit.path && circuit.path.length > 0) {
            try {
                const exitHop = circuit.path[circuit.path.length - 1];
                const exitRelay = await control.getRelayInfo(exitHop.fingerprint);
                if (exitRelay?.ip) {
                    circuit.country = await control.getCountry(exitRelay.ip);
                }
            } catch (error) {
                // Country resolution is best-effort
            }
        }

        const flag = countryFlag(circuit.country);

        // Only use circuits explicitly built by VPNManager (via pendingCircuitTargets)
        // Ignore Anon's own circuits (Conflux_linked, preemptive, etc.) to ensure correct hop count
        const trackedTarget = this.pendingCircuitTargets.get(circuit.id);
        if (trackedTarget) {
            circuit.target = trackedTarget;
            this.pendingCircuitTargets.delete(circuit.id);
            const hopCount = circuit.path?.length ?? '?';
            console.log(chalk.green(`✓ Circuit ${chalk.bold(circuit.id)} ready (${hopCount}-hop)`) + ` ${flag} → ${chalk.cyan(trackedTarget)}`);

            this.emit(VPNManagerEvent.TARGET_READY, {
                target: trackedTarget,
                circuitId: circuit.id,
                country: circuit.country,
            });
        }
    }

    // ==================== Stream Event Handling ====================

    private async handleStreamEvent(event: StreamEvent): Promise<void> {
        const streamId = event.streamId;
        let stream = this.streams.get(streamId);
        const circId = event.circId;

        // Log successful connections (only once per stream)
        if (circId !== 0 && this.circuits.has(circId) && event.status === 'SUCCEEDED' && !this.loggedStreams.has(streamId)) {
            this.loggedStreams.add(streamId);
            const circ = this.circuits.get(circId)!;
            const targetParts = event.target.split(':');
            const targetHost = targetParts[0];
            let displayName = this.ipToHostname.get(targetHost) || stream?.target?.split(':')[0] || targetHost;
            const flag = countryFlag(circ.country);

            // Check if this is a VPN config target (highlight in green) or other traffic (gray)
            const isVpnTarget = this.targets.some(t => t.address === displayName);
            if (isVpnTarget) {
                console.log(chalk.green(`↔ ${chalk.bold(displayName)}`) + chalk.white(` → circuit ${circId} ${flag}`));
            } else {
                console.log(chalk.gray(`  ${displayName} → circuit ${circId} ${flag}`));
            }
        }

        if (!stream) {
            stream = {
                id: streamId,
                target: event.target,
                status: event.status,
                circId: circId,
            };
            this.streams.set(streamId, stream);
        } else {
            stream.status = event.status;
            stream.circId = circId;
        }

        if (stream.status === 'CLOSED') {
            // Decrement stream count
            if (stream.circId && stream.circId !== 0) {
                const circ = this.circuits.get(stream.circId);
                if (circ) {
                    circ.streamCount = Math.max(0, circ.streamCount - 1);
                }
            }
            this.streams.delete(streamId);
            this.loggedStreams.delete(streamId);
        }

        // Attach stream if needed
        await this.attachStreamIfNeeded(event);
    }

    private async attachStreamIfNeeded(event: StreamEvent): Promise<void> {
        const streamId = event.streamId;
        const stream = this.streams.get(streamId);

        if (!stream || (stream.status !== 'NEW' && stream.status !== 'DETACHED')) {
            return;
        }

        const target = event.target.split(':')[0];
        const control = this.stateManager.getControl();

        // Check if this is one of our managed targets
        const vpnTarget = this.targets.find(t => t.address === target);

        if (vpnTarget) {
            // Find circuits for this target
            let circuits = this.getCircuitsForTarget(target);

            if (circuits.length === 0) {
                // Fallback: try any BUILT circuit with matching exit country
                const matchingCircuits = [...this.circuits.values()].filter(c =>
                    c.status === 'BUILT' &&
                    c.country &&
                    vpnTarget.exitCountries.includes(c.country.toLowerCase())
                );

                if (matchingCircuits.length === 0) {
                    console.warn(chalk.yellow(`⚠ No circuits for ${target} (need ${vpnTarget.exitCountries.join('/')}), using default routing`));
                    await control.attachStream(streamId, 0);
                    return;
                }

                circuits = matchingCircuits;
            }

            // Load balancing: select circuit with fewest streams
            const circuit = circuits.reduce((min, c) =>
                c.streamCount < min.streamCount ? c : min
            );

            const attached = await control.attachStream(streamId, circuit.id);
            if (attached) {
                circuit.streamCount++;
                this.emit(VPNManagerEvent.STREAM_ROUTED, {
                    streamId,
                    circuitId: circuit.id,
                    target: vpnTarget.address,
                });
            } else {
                console.warn(chalk.yellow(`⚠ Failed to attach stream ${streamId} to circuit ${circuit.id} for ${vpnTarget.address}`));
            }
        } else {
            // Not a managed target, use default attachment (555 errors are expected for internal streams)
            await control.attachStream(streamId, 0);
        }
    }

    // ==================== Circuit Building ====================

    private async buildInitialCircuits(): Promise<void> {
        console.log(chalk.cyan('\n📡 Building initial circuits...'));

        for (const target of this.targets) {
            const flags = target.exitCountries.map(c => countryFlag(c)).join(' ');
            const hops = target.hopCount ?? 3;
            console.log(chalk.gray(`  ${target.address} → ${flags} (${target.minCircuits} circuit${target.minCircuits > 1 ? 's' : ''}, ${hops}-hop)`));
            for (let i = 0; i < target.minCircuits; i++) {
                try {
                    await this.buildCircuitForTarget(target);
                } catch (error) {
                    console.error(chalk.red(`  ✗ Failed to build circuit for ${target.address}`));
                }
            }
        }
        console.log('');
    }

    private async buildCircuitForTarget(target: VPNTarget): Promise<number | null> {
        const relays = this.selectRelaysForTarget(target);
        if (!relays) {
            console.warn(chalk.yellow(`⚠ No suitable relays for ${target.address}`));
            return null;
        }

        const hopCount = target.hopCount ?? 3;
        const serverSpecs = relays.map(r => `$${r.fingerprint}`);
        const control = this.stateManager.getControl();

        try {
            const circuitId = await control.extendCircuit({
                circuitId: 0,
                serverSpecs,
                purpose: 'general',
                awaitBuild: false,
            });

            // Track which target this circuit is for
            this.pendingCircuitTargets.set(circuitId, target.address);
            console.log(chalk.gray(`  ⏳ Circuit ${circuitId} (${hopCount}-hop) building for ${target.address}...`));

            return circuitId;
        } catch (error) {
            console.error(chalk.red(`  ✗ Circuit build failed`));
            return null;
        }
    }

    private selectRelaysForTarget(target: VPNTarget): RelayInfo[] | null {
        const hopCount = target.hopCount ?? 3;

        const possibleExits: RelayInfo[] = [];
        for (const country of target.exitCountries) {
            const exits = this.stateManager.getExitsByCountry(country);
            possibleExits.push(...exits);
        }

        const guards = this.stateManager.getGuards();

        if (possibleExits.length === 0 || guards.length === 0) {
            return null;
        }

        if (hopCount === 2) {
            const maxAttempts = 10;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const guard = guards[randomInt(guards.length)];
                const exit = possibleExits[randomInt(possibleExits.length)];

                if (guard.fingerprint !== exit.fingerprint) {
                    return [guard, exit];
                }
            }
            return null;
        }

        // 3-hop: guard + middle + exit
        const allRelays = this.stateManager.getRelays();
        const middleRelays = allRelays.filter(relay =>
            relay.flags.includes(Flag.Running) &&
            relay.flags.includes(Flag.Stable) &&
            !relay.flags.includes(Flag.BadExit)
        );

        if (middleRelays.length === 0) {
            return null;
        }

        const maxAttempts = 10;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const guard = guards[randomInt(guards.length)];
            const middle = middleRelays[randomInt(middleRelays.length)];
            const exit = possibleExits[randomInt(possibleExits.length)];

            if (guard.fingerprint !== middle.fingerprint &&
                guard.fingerprint !== exit.fingerprint &&
                middle.fingerprint !== exit.fingerprint) {
                return [guard, middle, exit];
            }
        }

        return null;
    }

    // ==================== Queries ====================

    getCircuitsForTarget(targetAddress: string): Array<CircuitEntry & { target?: string; streamCount: number }> {
        return [...this.circuits.values()].filter(
            c => c.status === 'BUILT' && c.target === targetAddress
        );
    }

    getTargets(): VPNTarget[] {
        return [...this.targets];
    }

    getMetrics(): VPNMetrics {
        const metrics: VPNMetrics = {
            totalCircuits: this.circuits.size,
            totalStreams: this.streams.size,
            circuitsByTarget: {},
            circuitsByStatus: {},
        };

        for (const target of this.targets) {
            metrics.circuitsByTarget[target.address] = this.getCircuitsForTarget(target.address).length;
        }

        for (const circuit of this.circuits.values()) {
            const status = circuit.status || 'unknown';
            metrics.circuitsByStatus[status] = (metrics.circuitsByStatus[status] || 0) + 1;
        }

        return metrics;
    }

    // ==================== Health Monitoring ====================

    private startHealthMonitor(): void {
        this.healthMonitorInterval = setInterval(() => {
            for (const target of this.targets) {
                this.ensureCircuitsForTarget(target.address);
            }
        }, this.config.healthMonitorInterval);
    }

    private stopHealthMonitor(): void {
        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = undefined;
        }
    }

    private async ensureCircuitsForTarget(targetAddress: string): Promise<void> {
        const target = this.targets.find(t => t.address === targetAddress);
        if (!target) return;

        const circuits = this.getCircuitsForTarget(targetAddress);
        const needed = target.minCircuits - circuits.length;

        if (needed > 0) {
            for (let i = 0; i < needed; i++) {
                try {
                    await this.buildCircuitForTarget(target);
                } catch (error) {
                    console.error(chalk.red(`  ✗ Failed to rebuild circuit`));
                }
            }
        }
    }
}
