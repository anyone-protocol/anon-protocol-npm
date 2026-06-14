export interface VPNConfig {
    routings: VPNRouting[];
}

export interface VPNRouting {
    targetAddress: string;
    exitCountries: string[];
}

export interface CircuitStatus {
    circuitId: number;
    state: string;
    relays: Relay[];
    buildFlags: string[];
    purpose: string;
    timeCreated: Date;
}

export interface Relay {
    fingerprint: string;
    nickname: string;
}

export type Purpose = 'general' | 'controller';

export enum EventType {
    ADDRMAP = 'ADDRMAP',
    BUILDTIMEOUT_SET = 'BUILDTIMEOUT_SET',
    BW = 'BW',
    CELL_STATS = 'CELL_STATS',
    CIRC = 'CIRC',
    CIRC_BW = 'CIRC_BW',
    CIRC_MINOR = 'CIRC_MINOR',
    CONF_CHANGED = 'CONF_CHANGED',
    CONN_BW = 'CONN_BW',
    CLIENTS_SEEN = 'CLIENTS_SEEN',
    DEBUG = 'DEBUG',
    DESCCHANGED = 'DESCCHANGED',
    ERR = 'ERR',
    GUARD = 'GUARD',
    HS_DESC = 'HS_DESC',
    HS_DESC_CONTENT = 'HS_DESC_CONTENT',
    INFO = 'INFO',
    NETWORK_LIVENESS = 'NETWORK_LIVENESS',
    NEWCONSENSUS = 'NEWCONSENSUS',
    NEWDESC = 'NEWDESC',
    NOTICE = 'NOTICE',
    NS = 'NS',
    ORCONN = 'ORCONN',
    SIGNAL = 'SIGNAL',
    STATUS_CLIENT = 'STATUS_CLIENT',
    STATUS_GENERAL = 'STATUS_GENERAL',
    STATUS_SERVER = 'STATUS_SERVER',
    STREAM = 'STREAM',
    STREAM_BW = 'STREAM_BW',
    TRANSPORT_LAUNCHED = 'TRANSPORT_LAUNCHED',
    WARN = 'WARN'
}

export interface ExtendCircuitOptions {
    circuitId?: number;
    serverSpecs?: string[];
    purpose?: Purpose;
    awaitBuild?: boolean;
    buildTimeout?: number;
}

export enum Flag {
    Authority = 'Authority',
    BadExit = 'BadExit',
    BadDirectory = 'BadDirectory',
    Exit = 'Exit',
    Fast = 'Fast',
    Guard = 'Guard',
    HSDir = 'HSDir',
    Named = 'Named',
    NoEdConsensus = 'NoEdConsensus',
    Running = 'Running',
    Stable = 'Stable',
    StaleDesc = 'StaleDesc',
    Unnamed = 'Unnamed',
    Valid = 'Valid',
    V2Dir = 'V2Dir',
    V3Dir = 'V3Dir'
}

export interface RelayInfo {
    fingerprint: string;
    nickname: string;
    ip: string;
    orPort: number;
    flags: Flag[];
    bandwidth: number;
    published?: Date;
    dirPort?: number;
    country?: string;
}

export interface ControlMessage {
    code: string;
    divider: string;
    content: string;
    raw: string;
    arrivedAt?: number;
}

export interface Event {
    type: EventType;
    data?: string;
}

export interface StreamEvent extends Event {
    type: EventType.STREAM;
    streamId: number;
    status: string;
    circId: number;
    target: string;
    sourceAddr: string | null;
    purpose: string | null;
    reason: string | null;
    remoteReason: string | null;
    source: string | null;
}

export interface AddrMapEvent {
    type: EventType.ADDRMAP;
    address: string;
    mappedAddress: string;
    expires?: Date;
    streamId?: number;
    cached?: boolean;
}

export enum CircStatus {
    LAUNCHED = 'LAUNCHED',
    BUILT = 'BUILT',
    GUARD_WAIT = 'GUARD_WAIT',
    EXTENDED = 'EXTENDED',
    FAILED = 'FAILED',
    CLOSED = 'CLOSED'
}

export interface CircHop {
    fingerprint: string;
    nickname?: string;
}

export interface CircEvent extends Event {
    type: EventType.CIRC;
    circId: number;
    status: CircStatus;
    path: CircHop[];
    buildFlags?: string[];
    purpose?: string;
    reason?: string;
    remoteReason?: string;
    timeCreated?: Date;
}

// ============================================
// StateManager Types
// ============================================

/**
 * Internal circuit state tracking with extensible metadata
 */
export interface CircuitEntry {
    id: number;
    path?: CircHop[];
    status?: string;
    country?: string;
    createdAt: Date;
    metadata: Record<string, unknown>;
}

/**
 * Internal stream state tracking with extensible metadata
 */
export interface StreamEntry {
    id: number;
    target?: string;
    status?: string;
    circId?: number;
    metadata: Record<string, unknown>;
}

/**
 * Configuration options for StateManager
 */
export interface StateManagerConfig {
    /** Automatically subscribe to CIRC, STREAM, ADDRMAP events (default: true) */
    autoSubscribeEvents?: boolean;
    /** Cache relay information on initialize (default: true) */
    cacheRelays?: boolean;
    /** Populate country information for exit relays (default: true) */
    populateCountries?: boolean;
}

/**
 * Events emitted by StateManager
 */
export enum StateManagerEvent {
    CIRCUIT_NEW = 'circuit:new',
    CIRCUIT_BUILT = 'circuit:built',
    CIRCUIT_CLOSED = 'circuit:closed',
    CIRCUIT_FAILED = 'circuit:failed',
    STREAM_NEW = 'stream:new',
    STREAM_ATTACHED = 'stream:attached',
    STREAM_CLOSED = 'stream:closed',
    RELAYS_UPDATED = 'relays:updated',
}

// ============================================
// VPNManager Types
// ============================================

/**
 * Configuration for a VPN target - defines routing rules for a specific address
 */
export interface VPNTarget {
    /** The address to route (hostname, e.g., 'api.example.com') */
    address: string;
    /** Preferred exit countries for this target (ISO 2-letter codes, lowercase) */
    exitCountries: string[];
    /** Minimum number of circuits to maintain for this target */
    minCircuits: number;
    /** Maximum number of circuits to build for this target */
    maxCircuits: number;
    /** Number of hops in the circuit (2 = guard+exit, 3 = guard+middle+exit). Defaults to 3. */
    hopCount?: 2 | 3;
}

/**
 * Configuration options for VPNManager
 */
export interface VPNManagerConfig {
    /** VPN targets to manage */
    targets: VPNTarget[];
    /** Health monitor interval in milliseconds (default: 10000, 0 to disable) */
    healthMonitorInterval?: number;
    /** Disable Anon's predicted (preemptive) circuit building (default: false) */
    disablePredictedCircuits?: boolean;
    /** Disable conflux (multi-path) circuits (default: false) */
    disableConflux?: boolean;
}

/**
 * Events emitted by VPNManager
 */
export enum VPNManagerEvent {
    TARGET_READY = 'target:ready',
    TARGET_DEGRADED = 'target:degraded',
    STREAM_ROUTED = 'stream:routed',
}

/**
 * Metrics returned by VPNManager
 */
export interface VPNMetrics {
    totalCircuits: number;
    totalStreams: number;
    circuitsByTarget: Record<string, number>;
    circuitsByStatus: Record<string, number>;
}
