import { EventEmitter } from 'events';
import { Control } from './control';
import {
    AddrMapEvent,
    CircEvent,
    CircHop,
    CircuitEntry,
    EventType,
    Flag,
    RelayInfo,
    StateManagerConfig,
    StateManagerEvent,
    StreamEntry,
    StreamEvent,
} from './models';

/**
 * StateManager provides generic state tracking for circuits, streams, and relays.
 *
 * This class follows the SDK's composition pattern - it takes a Control instance
 * and provides state management on top of it. Other features (like VPNManager)
 * can build on top of StateManager.
 *
 * Features:
 * - Circuit state tracking with extensible metadata
 * - Stream state tracking with extensible metadata
 * - Relay caching (all relays, guards, exits by country)
 * - IP-to-hostname mapping (from ADDRMAP events)
 * - Event emission for state changes
 *
 * @example
 * ```typescript
 * const control = new Control();
 * await control.authenticate();
 *
 * const state = new StateManager(control);
 * await state.initialize();
 *
 * state.on(StateManagerEvent.CIRCUIT_BUILT, (circuit) => {
 *     console.log(`Circuit ${circuit.id} built in ${circuit.country}`);
 * });
 *
 * // Query state
 * const builtCircuits = state.getCircuitsByStatus('BUILT');
 * const germanExits = state.getExitsByCountry('de');
 * ```
 */
export class StateManager extends EventEmitter {
    private control: Control;
    private config: Required<StateManagerConfig>;

    // Circuit state
    private circuits: Map<number, CircuitEntry> = new Map();

    // Stream state
    private streams: Map<number, StreamEntry> = new Map();

    // IP to hostname mapping (from ADDRMAP events)
    private ipToHostname: Map<string, string> = new Map();

    // Relay cache
    private allRelays: RelayInfo[] = [];
    private guards: RelayInfo[] = [];
    private exitsByCountry: Map<string, RelayInfo[]> = new Map();

    // Lifecycle
    private isInitialized: boolean = false;
    private isShuttingDown: boolean = false;

    // Event handlers (stored for removal on shutdown)
    private circEventHandler: ((event: CircEvent) => void) | null = null;
    private streamEventHandler: ((event: StreamEvent) => void) | null = null;
    private addrMapEventHandler: ((event: AddrMapEvent) => void) | null = null;

    constructor(control: Control, config: StateManagerConfig = {}) {
        super();
        this.control = control;
        this.config = {
            autoSubscribeEvents: config.autoSubscribeEvents ?? true,
            cacheRelays: config.cacheRelays ?? true,
            populateCountries: config.populateCountries ?? true,
        };
    }

    // ==================== Lifecycle ====================

    /**
     * Initialize the state manager
     * - Enables circuit event listener on Control
     * - Subscribes to CIRC, STREAM, ADDRMAP events
     * - Caches relay information (if enabled)
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            throw new Error('StateManager is already initialized');
        }

        // Enable circuit event listener on Control
        await this.control.enableCircuitEventListener();

        // Set up event handlers
        if (this.config.autoSubscribeEvents) {
            await this.setupEventListeners();
        }

        // Cache relay information
        if (this.config.cacheRelays) {
            await this.refreshRelays();
        }

        this.isInitialized = true;
    }

    /**
     * Shutdown the state manager
     * - Removes event listeners
     * - Clears state
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        // Remove event listeners
        if (this.circEventHandler) {
            await this.control.removeEventListener(this.circEventHandler);
        }
        if (this.streamEventHandler) {
            await this.control.removeEventListener(this.streamEventHandler);
        }
        if (this.addrMapEventHandler) {
            await this.control.removeEventListener(this.addrMapEventHandler);
        }

        // Clear state
        this.circuits.clear();
        this.streams.clear();
        this.ipToHostname.clear();
        this.allRelays = [];
        this.guards = [];
        this.exitsByCountry.clear();

        this.isInitialized = false;
    }

    /**
     * Check if the state manager is initialized
     */
    isReady(): boolean {
        return this.isInitialized && !this.isShuttingDown;
    }

    // ==================== Circuit State ====================

    /**
     * Get a circuit by ID
     */
    getCircuit(id: number): CircuitEntry | undefined {
        return this.circuits.get(id);
    }

    /**
     * Get all circuits
     */
    getAllCircuits(): CircuitEntry[] {
        return [...this.circuits.values()];
    }

    /**
     * Get circuits by status
     */
    getCircuitsByStatus(status: string): CircuitEntry[] {
        return [...this.circuits.values()].filter(c => c.status === status);
    }

    /**
     * Set metadata on a circuit
     */
    setCircuitMetadata(id: number, key: string, value: unknown): void {
        const circuit = this.circuits.get(id);
        if (circuit) {
            circuit.metadata[key] = value;
        }
    }

    /**
     * Get metadata from a circuit
     */
    getCircuitMetadata<T = unknown>(id: number, key: string): T | undefined {
        const circuit = this.circuits.get(id);
        return circuit?.metadata[key] as T | undefined;
    }

    // ==================== Stream State ====================

    /**
     * Get a stream by ID
     */
    getStream(id: number): StreamEntry | undefined {
        return this.streams.get(id);
    }

    /**
     * Get all streams
     */
    getAllStreams(): StreamEntry[] {
        return [...this.streams.values()];
    }

    /**
     * Get streams by circuit ID
     */
    getStreamsByCircuit(circuitId: number): StreamEntry[] {
        return [...this.streams.values()].filter(s => s.circId === circuitId);
    }

    /**
     * Set metadata on a stream
     */
    setStreamMetadata(id: number, key: string, value: unknown): void {
        const stream = this.streams.get(id);
        if (stream) {
            stream.metadata[key] = value;
        }
    }

    /**
     * Get metadata from a stream
     */
    getStreamMetadata<T = unknown>(id: number, key: string): T | undefined {
        const stream = this.streams.get(id);
        return stream?.metadata[key] as T | undefined;
    }

    // ==================== Relay Cache ====================

    /**
     * Get all cached relays
     */
    getRelays(): RelayInfo[] {
        return this.allRelays;
    }

    /**
     * Get cached guard relays
     */
    getGuards(): RelayInfo[] {
        return this.guards;
    }

    /**
     * Get cached exit relays for a country
     */
    getExitsByCountry(country: string): RelayInfo[] {
        return this.exitsByCountry.get(country.toLowerCase()) || [];
    }

    /**
     * Get all countries with cached exits
     */
    getAvailableCountries(): string[] {
        return [...this.exitsByCountry.keys()];
    }

    /**
     * Refresh the relay cache from Control
     */
    async refreshRelays(): Promise<void> {
        const relays = await this.control.getRelays();
        this.allRelays = relays;

        // Cache guards
        this.guards = this.control.filterRelaysByFlags(
            relays,
            Flag.Guard,
            Flag.Stable,
            Flag.Running,
            Flag.Fast
        );

        // Cache quality exits
        let exits = this.control.filterRelaysByFlags(relays, Flag.Exit, Flag.Running);
        exits = exits.filter(exit => !exit.flags.includes(Flag.BadExit));

        // Populate country info if enabled
        if (this.config.populateCountries) {
            await this.control.populateCountries(exits);
        }

        // Group exits by country
        this.exitsByCountry.clear();
        for (const exit of exits) {
            if (!exit.country) continue;
            const country = exit.country.toLowerCase();
            if (!this.exitsByCountry.has(country)) {
                this.exitsByCountry.set(country, []);
            }
            this.exitsByCountry.get(country)!.push(exit);
        }

        this.emit(StateManagerEvent.RELAYS_UPDATED, {
            totalRelays: relays.length,
            guards: this.guards.length,
            exits: exits.length,
            countries: this.exitsByCountry.size,
        });
    }

    /**
     * Filter relays by flags (delegates to Control)
     */
    filterRelaysByFlags(relays: RelayInfo[], ...flags: Flag[]): RelayInfo[] {
        return this.control.filterRelaysByFlags(relays, ...flags);
    }

    // ==================== IP Mapping ====================

    /**
     * Resolve an IP to hostname (from ADDRMAP cache)
     */
    resolveHostname(ip: string): string | undefined {
        return this.ipToHostname.get(ip);
    }

    /**
     * Get all IP to hostname mappings
     */
    getIpMappings(): Map<string, string> {
        return new Map(this.ipToHostname);
    }

    // ==================== Control Access ====================

    /**
     * Get the underlying Control instance
     * (for features that need direct control access)
     */
    getControl(): Control {
        return this.control;
    }

    // ==================== Internal Event Handling ====================

    private async setupEventListeners(): Promise<void> {
        // Circuit event handler
        this.circEventHandler = (event: CircEvent) => {
            this.handleCircEvent(event);
        };

        // Stream event handler
        this.streamEventHandler = (event: StreamEvent) => {
            this.handleStreamEvent(event);
        };

        // ADDRMAP event handler
        this.addrMapEventHandler = (event: AddrMapEvent) => {
            this.handleAddrMapEvent(event);
        };

        await this.control.addEventListener(this.circEventHandler, EventType.CIRC);
        await this.control.addEventListener(this.streamEventHandler, EventType.STREAM);
        await this.control.addEventListener(this.addrMapEventHandler, EventType.ADDRMAP);
    }

    private handleCircEvent(event: CircEvent): void {
        const circId = event.circId;
        let circuit = this.circuits.get(circId);

        if (!circuit) {
            // New circuit
            circuit = {
                id: circId,
                status: event.status,
                path: event.path,
                createdAt: new Date(),
                metadata: {},
            };
            this.circuits.set(circId, circuit);
            this.emit(StateManagerEvent.CIRCUIT_NEW, circuit);
        } else {
            // Update existing circuit
            const oldStatus = circuit.status;
            circuit.status = event.status;
            circuit.path = event.path;

            // When circuit becomes BUILT, try to get country then emit
            if (circuit.status === 'BUILT' && oldStatus !== 'BUILT') {
                // Resolve country first, then emit (don't block event loop)
                this.resolveCircuitCountry(circuit).finally(() => {
                    this.emit(StateManagerEvent.CIRCUIT_BUILT, circuit);
                });
            }
        }

        // Handle circuit closure/failure
        if (event.status === 'CLOSED' || event.status === 'FAILED') {
            const closedCircuit = this.circuits.get(circId);
            this.circuits.delete(circId);

            if (event.status === 'FAILED') {
                this.emit(StateManagerEvent.CIRCUIT_FAILED, {
                    ...closedCircuit,
                    reason: event.reason,
                    remoteReason: event.remoteReason,
                });
            } else {
                this.emit(StateManagerEvent.CIRCUIT_CLOSED, closedCircuit);
            }
        }
    }

    private async resolveCircuitCountry(circuit: CircuitEntry): Promise<void> {
        if (!circuit.path || circuit.path.length === 0) return;

        try {
            const exitHop = circuit.path[circuit.path.length - 1];
            const exitRelay = await this.control.getRelayInfo(exitHop.fingerprint);
            if (exitRelay && exitRelay.ip) {
                circuit.country = await this.control.getCountry(exitRelay.ip);
            }
        } catch (error) {
            // Country resolution is best-effort, log but don't fail
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[StateManager] Could not resolve country for circuit ${circuit.id}: ${msg}`);
        }
    }

    private handleStreamEvent(event: StreamEvent): void {
        const streamId = event.streamId;
        let stream = this.streams.get(streamId);

        if (!stream) {
            // New stream
            stream = {
                id: streamId,
                target: event.target,
                status: event.status,
                circId: event.circId !== 0 ? event.circId : undefined,
                metadata: {},
            };
            this.streams.set(streamId, stream);
        } else {
            // Update existing stream
            stream.status = event.status;

            if (event.circId !== 0) {
                stream.circId = event.circId;
            }
        }

        // Emit STREAM_NEW whenever stream needs attachment (NEW or DETACHED status)
        // This allows VPNManager to attach/re-attach streams
        if (event.status === 'NEW' || event.status === 'DETACHED') {
            this.emit(StateManagerEvent.STREAM_NEW, stream);
        }

        // Emit attached event when stream gets assigned to circuit
        if (stream.circId && event.status === 'SUCCEEDED') {
            this.emit(StateManagerEvent.STREAM_ATTACHED, stream);
        }

        // Handle stream closure
        if (event.status === 'CLOSED' || event.status === 'FAILED') {
            const closedStream = this.streams.get(streamId);
            this.streams.delete(streamId);
            this.emit(StateManagerEvent.STREAM_CLOSED, closedStream);
        }
    }

    private handleAddrMapEvent(event: AddrMapEvent): void {
        if (event.address && event.mappedAddress) {
            // Store IP -> hostname mapping
            this.ipToHostname.set(event.mappedAddress, event.address);
        }
    }
}
