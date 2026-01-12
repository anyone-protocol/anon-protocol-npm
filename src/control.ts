import { CircEvent, CircStatus, CircuitStatus, Event, EventType, ExtendCircuitOptions, Flag, Purpose, Relay, RelayInfo } from './models';
import * as net from 'net';
import { AsyncEvent, AsyncQueue } from './queue';
import { ProtocolParser, CRLF, parseFirstStatusCode, isOkCode } from './protocol-parser';
import { EventDispatcher } from './event-dispatcher';
import { RelayManager } from './relay-manager';

/**
 * Control class for managing Anon control port connections.
 * Refactored to use composition with ProtocolParser, EventDispatcher, and RelayManager.
 */
export class Control {
    private readonly client: net.Socket;
    private isAuthenticated: boolean = false;

    // Queues for message routing
    private replyQueue = new AsyncQueue<string>();
    private eventQueue = new AsyncQueue<string>();
    private defaultQueue = new AsyncQueue<string>();
    private extendQueue = new AsyncQueue<string>();
    private eventNotice = new AsyncEvent();

    // Composed components
    private parser: ProtocolParser;
    private eventDispatcher: EventDispatcher;
    private relayManager: RelayManager;

    // Loop tasks
    private readerLoopTask: Promise<void> | null = null;
    private msgLoopTask: Promise<void> | null = null;
    private isShuttingDown: boolean = false;

    // Circuit event handling
    private circuitEventListenerEnabled: boolean = false;
    private circuitEventQueue = new AsyncQueue<CircEvent>();
    private circuitEventListener = (event: Event) => {
        if (event.type === EventType.CIRC) {
            this.circuitEventQueue.push(event as CircEvent);
        }
    };

    constructor(host = '127.0.0.1', port = 9051) {
        console.log('Connecting to Anon Control Port at', host, port);

        this.client = net.createConnection({ host, port }, () => {
            console.log('Successfully connected to Anon Control Port');
        });

        // Initialize composed components
        this.parser = new ProtocolParser(this.eventQueue, this.eventNotice);
        this.eventDispatcher = new EventDispatcher(
            this.client,
            this.eventQueue,
            this.eventNotice,
            this.parser,
            () => this.isAuthenticated,
            (events) => this.setEvents(events)
        );
        this.relayManager = new RelayManager(
            this.defaultQueue,
            (msg) => this.msgAsync(msg)
        );

        this.createLoopTasks();
    }

    // ==================== Authentication ====================

    async authenticate(password: string = 'password'): Promise<void> {
        await this.msgAsync(`AUTHENTICATE "${password}"`);
        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for authentication response')), 10000)
            )
        ]);

        if (response.startsWith('250 OK')) {
            this.isAuthenticated = true;
            console.log('Authenticated to Anon Control Port');
        } else if (response.startsWith('515')) {
            throw new Error('Authentication failed');
        } else {
            throw new Error(`Unexpected response: ${response}`);
        }
    }

    // ==================== Event Management (delegated) ====================

    async enableCircuitEventListener(): Promise<void> {
        await this.eventDispatcher.addEventListener(this.circuitEventListener, EventType.CIRC);
        this.circuitEventListenerEnabled = true;
    }

    async disableCircuitEventListener(): Promise<void> {
        await this.eventDispatcher.removeEventListener(this.circuitEventListener);
        this.circuitEventListenerEnabled = false;
    }

    async addEventListener(callback: Function, ...eventTypes: EventType[]): Promise<void> {
        await this.eventDispatcher.addEventListener(callback, ...eventTypes);
    }

    async removeEventListener(callback: Function): Promise<void> {
        await this.eventDispatcher.removeEventListener(callback);
    }

    async setEvents(events: EventType[]): Promise<boolean> {
        const command = `SETEVENTS ${events.join(' ')}`;
        await this.msgAsync(command);
        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout waiting for SETEVENTS response`)), 10000)
            )
        ]);

        if (response.startsWith('250 OK')) {
            return true;
        } else {
            console.error(`Failed to set events [${events.join(', ')}]: ${response}`);
            return false;
        }
    }

    // ==================== Circuit Management ====================

    async circuitStatus(): Promise<CircuitStatus[]> {
        await this.msgAsync('GETINFO circuit-status');

        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for circuit-status response')), 10000)
            )
        ]);

        if (!response.startsWith('250+circuit-status=') && !response.startsWith('250 OK')) {
            throw new Error('Invalid response format: ' + response);
        }

        const cleanedResponse = response
            .replace(/^250\+circuit-status=/, '')
            .replace(/250 OK$/, '');

        const circuits: CircuitStatus[] = [];
        const lines = cleanedResponse.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
            const trimmedLine = line.trim();
            const parts = trimmedLine.split(' ');

            if (parts.length < 4 || isNaN(parseInt(parts[0], 10))) {
                continue;
            }

            const state = parts[1];
            const circuitId = parseInt(parts[0], 10);
            const relaysPart = parts.find(part => part.startsWith('$'))?.split(',') || [];
            const relays: Relay[] = relaysPart.map(relay => {
                const [fingerprint, nickname] = relay.split('~');
                return {
                    fingerprint: fingerprint.replace(/^\$/, ''),
                    nickname: nickname
                };
            });

            const buildFlags = parts.find(part => part.startsWith('BUILD_FLAGS='))
                ?.split('=')[1]?.split(',') || [];
            const purpose = parts.find(part => part.startsWith('PURPOSE='))
                ?.split('=')[1] || '';
            const timeCreated = new Date(parts.find(part => part.startsWith('TIME_CREATED='))
                ?.split('=')[1] + 'Z' || '');

            const circuit: CircuitStatus = {
                circuitId,
                state,
                relays,
                buildFlags,
                purpose,
                timeCreated
            };

            circuits.push(circuit);
        }

        return circuits;
    }

    async getCircuit(circuitId: number): Promise<CircuitStatus> {
        const circuits = await this.circuitStatus();
        const circuit = circuits.find(c => c.circuitId === circuitId);
        if (!circuit) {
            throw new Error(`Circuit with ID ${circuitId} not found`);
        }
        return circuit;
    }

    async extendCircuit(options: ExtendCircuitOptions = {}): Promise<number> {
        if (!this.circuitEventListenerEnabled) {
            throw new Error("Circuit event listener must be enabled. Call enableCircuitEventListener() first.");
        }

        let circuitId: number = options.circuitId ?? 0;
        const serverSpecs: string[] = options.serverSpecs ?? [];
        const purpose: Purpose = options.purpose ?? 'general';
        const awaitBuild: boolean = options.awaitBuild ?? false;
        const buildTimeout: number = options.buildTimeout ?? 60000;

        let command = `EXTENDCIRCUIT ${circuitId}`;

        if (serverSpecs.length > 0) {
            command += ` ${serverSpecs.join(',')}`;
        }

        if (purpose) {
            command += ` purpose=${purpose}`;
        }

        await this.msgAsync(command);

        const response = await this.extendQueue.pop();

        if (!response.startsWith('250 EXTENDED')) {
            throw new Error('Failed to extend circuit. Response: ' + response);
        }

        if (circuitId === 0) {
            circuitId = parseInt(response.split(' ')[2], 10);
        }

        if (awaitBuild) {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Circuit build timeout after ${buildTimeout}ms`));
                }, buildTimeout);
            });

            const waitPromise = new Promise<void>(async (resolve, reject) => {
                try {
                    let received = false;
                    let numb = 0;

                    while (!received) {
                        const event = await this.circuitEventQueue.pop();

                        if (event.circId === circuitId) {
                            numb++;
                            if (numb >= serverSpecs.length && (event.status == CircStatus.EXTENDED || event.status == CircStatus.BUILT)) {
                                received = true;
                                resolve();
                            }

                            if (event.status === CircStatus.FAILED || event.status === CircStatus.CLOSED) {
                                reject(new Error(`Circuit build failed: ${event.status} (${event.reason})`));
                            }
                        }
                    }
                } catch (error) {
                    reject(error);
                }
            });

            await Promise.race([waitPromise, timeoutPromise]);
        }

        return circuitId;
    }

    async closeCircuit(circuitId: number): Promise<void> {
        await this.msgAsync(`CLOSECIRCUIT ${circuitId}`);
        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for CLOSECIRCUIT response')), 10000)
            )
        ]);

        if (!response.startsWith('250')) {
            throw new Error(`Failed to close circuit: ${response}`);
        }
    }

    async attachStream(streamId: number, circuitId: number, exitingHop?: number): Promise<boolean> {
        if (!this.client || this.client.destroyed || !this.client.writable) {
            throw new Error('SocketClosed');
        }

        let command = `ATTACHSTREAM ${streamId} ${circuitId}`;

        if (exitingHop !== undefined) {
            command += ` HOP=${exitingHop}`;
        }

        await this.msgAsync(command);
        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for ATTACHSTREAM response')), 10000)
            )
        ]);

        const { code, text } = parseFirstStatusCode(response);

        if (!Number.isNaN(code)) {
            if (code === 552) {
                console.warn(`[AnonCtrl] ATTACHSTREAM ${streamId} -> 552 Unknown stream; ignoring`);
                return false;
            }
            if (code === 555) {
                console.warn(`[AnonCtrl] ATTACHSTREAM ${streamId} -> 555 Connection not managed; ignoring`);
                return false;
            }
            if (!isOkCode(code)) {
                throw new Error(`AttachStream failed (${code}): ${text}`);
            }
        }

        return true;
    }

    // ==================== Configuration ====================

    async disableStreamAttachment(): Promise<void> {
        await this.setConf('__LeaveStreamsUnattached', '1');
    }

    async enableStreamAttachment(): Promise<void> {
        await this.resetConf('__LeaveStreamsUnattached');
    }

    async disablePredictedCircuits(): Promise<void> {
        await this.setConf('__DisablePredictedCircuits', '1');
    }

    async enablePredictedCircuits(): Promise<void> {
        await this.resetConf('__DisablePredictedCircuits');
    }

    async setConf(param: string, value: string | string[]): Promise<void> {
        await this.setOptions({ [param]: value }, false);
    }

    async resetConf(...params: string[]): Promise<void> {
        const resetOptions: Record<string, null> = {};
        for (const param of params) {
            resetOptions[param] = null;
        }
        await this.setOptions(resetOptions, true);
    }

    private async setOptions(
        options: Record<string, string | string[] | null>,
        reset: boolean
    ): Promise<void> {
        const commandParts: string[] = [reset ? 'RESETCONF' : 'SETCONF'];

        for (const [key, val] of Object.entries(options)) {
            if (val === null || val === undefined) {
                commandParts.push(key);
            } else if (typeof val === 'string') {
                commandParts.push(`${key}="${val.trim()}"`);
            } else if (Array.isArray(val)) {
                for (const item of val) {
                    commandParts.push(`${key}="${item.trim()}"`);
                }
            } else {
                throw new Error(`Invalid config value for ${key}: ${val}`);
            }
        }

        const command = commandParts.join(' ');
        await this.msgAsync(command);

        const response = await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout waiting for SETCONF response (command: ${command})`)), 10000)
            )
        ]);

        if (!response.startsWith('250 OK')) {
            throw new Error(`SETCONF/RESETCONF failed: ${response}`);
        }
    }

    // ==================== Relay Management (delegated) ====================

    async getRelays(): Promise<RelayInfo[]> {
        return this.relayManager.getRelays();
    }

    async getRelayInfo(fingerprint: string, timeoutMs: number = 10000): Promise<RelayInfo> {
        return this.relayManager.getRelayInfo(fingerprint, timeoutMs);
    }

    async getCountry(address: string, timeoutMs: number = 10000): Promise<string> {
        return this.relayManager.getCountry(address, timeoutMs);
    }

    async populateCountries(relays: RelayInfo[]): Promise<void> {
        return this.relayManager.populateCountries(relays);
    }

    async findFirstByCountry(relays: RelayInfo[], firstCount: number, ...countries: string[]): Promise<RelayInfo[]> {
        return this.relayManager.findFirstByCountry(relays, firstCount, ...countries);
    }

    async getRelaysByCountries(...countries: string[]): Promise<RelayInfo[]> {
        return this.relayManager.getRelaysByCountries(...countries);
    }

    async filterRelaysByCountries(relays: RelayInfo[], ...countries: string[]): Promise<RelayInfo[]> {
        return this.relayManager.filterRelaysByCountries(relays, ...countries);
    }

    filterRelaysByFlags(relays: RelayInfo[], ...flags: Flag[]): RelayInfo[] {
        return this.relayManager.filterRelaysByFlags(relays, ...flags);
    }

    /**
     * Pause background country resolution (use before operations that need exclusive control port access)
     */
    pauseBackgroundResolution(): void {
        this.relayManager.pauseBackgroundResolution();
    }

    /**
     * Resume background country resolution
     */
    resumeBackgroundResolution(): void {
        this.relayManager.resumeBackgroundResolution();
    }

    /**
     * Stop background country resolution completely (use on shutdown)
     */
    stopBackgroundResolution(): void {
        this.relayManager.stopBackgroundResolution();
    }

    async resolve(hostname: string): Promise<void> {
        await this.msgAsync(`RESOLVE ${hostname}`);
        await Promise.race([
            this.defaultQueue.pop(),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for RESOLVE response')), 10000)
            )
        ]);
    }

    // ==================== Connection Management ====================

    end(): void {
        this.isShuttingDown = true;
        try {
            this.client.write('QUIT\r\n');
            this.client.end();
        } catch (e) {
            // Ignore errors during shutdown
        }
    }

    // ==================== Internal Message Handling ====================

    async msgAsync(message: string): Promise<void> {
        try {
            this.client.write(`${message}${CRLF}`);
        } catch (err) {
            if (!this.client || this.client.destroyed) {
                this.end?.();
                throw new Error('SocketClosed');
            }
            throw err;
        }
    }

    private async msgLoop(): Promise<void> {
        const pendingCountryRequests = this.relayManager.getPendingCountryRequests();
        const pendingNsRequests = this.relayManager.getPendingNsRequests();

        while (this.client && !this.client.destroyed) {
            try {
                let raw = await this.replyQueue.pop();

                if (raw.startsWith('ControllerError:')) {
                    if (!this.client || this.client.destroyed || this.isShuttingDown) {
                        return;
                    }
                    const msg = raw.slice('ControllerError:'.length).trim() || 'ControllerError';
                    console.error(`[AnonCtrl] Controller error: ${msg}`);
                    // Continue processing instead of throwing
                    continue;
                }

                if (raw.startsWith('ReplyError:')) {
                    const idx = raw.indexOf(CRLF);
                    if (idx >= 0) {
                        console.warn(`[AnonCtrl] ReplyError received: ${raw.slice(0, idx)}`);
                        raw = raw.slice(idx + CRLF.length);
                    }
                }

                // Route responses by correlation key

                if (raw.startsWith("250 EXTENDED")) {
                    this.extendQueue.push(raw);
                } else if (raw.startsWith("250-ip-to-country/")) {
                    const match = raw.match(/^250-ip-to-country\/([^=]+)=/);
                    if (match) {
                        const ip = match[1];
                        const pending = pendingCountryRequests.get(ip);
                        if (pending) {
                            clearTimeout(pending.timeoutId);
                            pending.resolve(raw);
                            pendingCountryRequests.delete(ip);
                        } else {
                            console.warn(`[AnonCtrl] Unexpected country response for ${ip}`);
                        }
                    }
                } else if (raw.startsWith("250+ns/id/$")) {
                    const match = raw.match(/^250\+ns\/id\/\$([A-F0-9]+)/i);
                    if (match) {
                        const fingerprint = match[1].toUpperCase();
                        const pending = pendingNsRequests.get(fingerprint);
                        if (pending) {
                            clearTimeout(pending.timeoutId);
                            pending.resolve(raw);
                            pendingNsRequests.delete(fingerprint);
                        } else {
                            console.warn(`[AnonCtrl] Unexpected ns response for ${fingerprint}`);
                        }
                    }
                } else {
                    this.defaultQueue.push(raw);
                }
            } catch (err) {
                if (this.isShuttingDown || !this.client || this.client.destroyed) {
                    return;
                }
                console.error('[AnonCtrl] Error in msgLoop:', err);
                // Continue processing instead of crashing
            }
        }
    }

    private createLoopTasks(): void {
        if (!this.readerLoopTask) {
            this.readerLoopTask = this.readerLoop();
        }

        this.eventDispatcher.startEventLoop();

        if (!this.msgLoopTask) {
            this.msgLoopTask = this.msgLoop();
        }
    }

    private async readerLoop(): Promise<void> {
        while (this.client && !this.client.destroyed && !this.isShuttingDown) {
            try {
                const raw = await this.parser.readReply(this.client, 0);

                const { code, text } = parseFirstStatusCode(raw);

                if (!Number.isNaN(code) && !isOkCode(code) && code >= 500) {
                    this.replyQueue.push(`ReplyError: ${code} ${text}${CRLF}${raw}`);
                } else {
                    this.replyQueue.push(raw);
                }
            } catch (err: any) {
                if (this.isShuttingDown) {
                    return;
                }
                const msg = err instanceof Error ? err.message : String(err);
                this.replyQueue.push(`ControllerError: ${msg}`);
            }
        }
    }
}