import { AddrMapEvent, CircEvent, CircHop, CircStatus, CircuitStatus, Event, EventType, ExtendCircuitOptions, Flag, Purpose, Relay, RelayInfo, StreamEvent } from './models';
import * as net from 'net';
import { AsyncEvent, AsyncQueue } from './queue';
import { Buffer } from 'buffer';

export class Control {
    private readonly client: net.Socket;
    private isAuthenticated: boolean = false;
    private eventListeners: Map<EventType, Function[]> = new Map();

    private msgLock = new AsyncQueue<void>();
    private replyQueue = new AsyncQueue<string>();
    private eventQueue = new AsyncQueue<string>();
    private eventNotice = new AsyncEvent();

    private readerLoopTask: Promise<void> | null = null;
    private eventLoopTask: Promise<void> | null = null;

    constructor(host = '127.0.0.1', port = 9051) {
        console.log('Connecting to Anon Control Port at', host, port);

        this.client = net.createConnection({ host, port }, () => {
            console.log('Successfully connected to Anon Control Port');
        });

        this.createLoopTasks();
    }

    async authenticate(password: string = 'password'): Promise<void> {
        const response = await this.msg(`AUTHENTICATE "${password}"`);

        if (response.startsWith('250 OK')) {
            this.isAuthenticated = true;
            console.log('Authenticated to Anon Control Port');
        } else if (response.startsWith('515')) {
            throw new Error('Authentication failed');
        } else {
            throw new Error(`Unexpected response: ${response}`);
        }
    }

    /**
     *  Request the server to inform the client about interesting events.
     *  The syntax is:
     *      "SETEVENTS" [SP "EXTENDED"] *(SP EventCode) CRLF
     *      EventCode = 1*(ALPHA / "_")  (see section 4.1.x for event types)
     *  Any events not listed in the SETEVENTS line are turned off;
     *  thus, sending SETEVENTS with an empty body turns off all event reporting.
     *  The server responds with a 250 OK reply on success,
     *  and a 552 Unrecognized event reply if one of the event codes isn’t recognized.
     *  (On error, the list of active event codes isn’t changed.)
     *  If the flag string “EXTENDED” is provided,
     *  Anon may provide extra information with events for this connection;
     *
     * @param events Array of EventType to set
     * @returns {Promise<boolean>} true if successful, false otherwise
     */
    async setEvents(events: EventType[]): Promise<boolean> {
        const command = `SETEVENTS ${events.join(' ')}`;
        const response = await this.msg(command);

        if (response.startsWith('250 OK')) {
            return true;
        } else {
            console.error(`Failed to set events [${events.join(', ')}]: ${response}`);
            return false;
        }
    }

    async circuitStatus(): Promise<CircuitStatus[]> {
        return this.msg('GETINFO circuit-status').then(response => {

            if (!response.startsWith('250+circuit-status=') && !response.startsWith('250 OK')) {
                throw new Error('Invalid response format');
            }

            const cleanedResponse = response
                .replace(/^250\+circuit-status=/, '')
                .replace(/250 OK$/, '')

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
                    ?.split('=')[1] + 'Z' || ''); // Add Z to make it ISO 8601 compliant

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
        });
    }

    async getCircuit(circuitId: number): Promise<CircuitStatus> {
        const circuits = await this.circuitStatus();
        const circuit = circuits.find(c => c.circuitId === circuitId);
        if (!circuit) {
            console.error(`Circuit with ID ${circuitId} not found`);
            throw new Error(`Circuit with ID ${circuitId} not found`);
        }
        return circuit;
    }

    async msg(message: string, expectOk: boolean = false): Promise<string> {
        this.msgLock.push(); // serialize command → reply
        try {
            // --- Send the command ---
            this.client.write(`${message}${CRLF}`);

            // --- Await one full reply ---
            let raw = await this.replyQueue.pop();

            // --- Handle transport-level errors bubbled from readerLoop ---
            if (raw.startsWith('ControllerError:')) {
                const msg = raw.slice('ControllerError:'.length).trim() || 'ControllerError';
                if (!this.client || this.client.destroyed) {
                    this.end?.();
                    throw new Error('SocketClosed');
                }
                throw new Error(msg);
            }

            // --- Handle annotated 5xx replies from readerLoop ---
            if (raw.startsWith('ReplyError:')) {
                const idx = raw.indexOf(CRLF);
                if (idx >= 0) {
                    const annotated = raw.slice(0, idx);
                    console.warn(`[AnonCtrl] ReplyError received: ${annotated}`);
                    raw = raw.slice(idx + CRLF.length);
                }
            }

            // --- Optionally enforce OK replies (2xx) ---
            if (expectOk) {
                const { code, text } = parseFirstStatusCode(raw);
                if (!Number.isFinite(code) || !isOkCode(code)) {
                    console.error(`[AnonCtrl] Command failed (${code || '???'}): ${text}`);
                    throw new Error(`Command failed (${Number.isFinite(code) ? code : '???'}): ${text}`);
                }
            }

            return raw;
        } catch (err) {
            if (!this.client || this.client.destroyed) {
                this.end?.();
                throw new Error('SocketClosed');
            }
            throw err;
        } finally {
            await this.msgLock.pop();
        }
    }

    async resolve(hostname: string): Promise<void> {
        await this.msg(`RESOLVE ${hostname}`);
    }

    async extendCircuit(options: ExtendCircuitOptions = {}): Promise<number> {
        let circuitId: number = options.circuitId ?? 0;
        const serverSpecs: string[] = options.serverSpecs ?? [];
        const purpose: Purpose = options.purpose ?? 'general';
        const awaitBuild: boolean = options.awaitBuild ?? false;
        const buildTimeout: number = options.buildTimeout ?? 60000;

        let queue;
        let eventListener: Function | null = null;
        if (awaitBuild) {
            queue = new AsyncQueue<CircEvent>();

            eventListener = (event: Event) => {
                if (event.type === EventType.CIRC) {
                    queue.push(event as CircEvent);
                }
            };
            await this.addEventListener(eventListener, EventType.CIRC);
        }

        let command = `EXTENDCIRCUIT ${circuitId}`;

        if (serverSpecs.length > 0) {
            command += ` ${serverSpecs.join(',')}`;
        }

        if (purpose) {
            command += ` purpose=${purpose}`;
        }

        const response = await this.msg(command);

        if (!response.startsWith('250 EXTENDED')) {
            throw new Error('Failed to extend circuit');
        }

        if (circuitId === 0) {
            circuitId = parseInt(response.split(' ')[2], 10);
        }

        if (awaitBuild) {
            // Create a timeout promise
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Circuit build timeout after ${buildTimeout}ms`));
                }, buildTimeout);
            });

            // Create the circuit wait promise
            const waitPromise = new Promise<void>(async (resolve, reject) => {
                try {
                    let received = false;
                    let numb = 0;

                    while (!received) {
                        const event = await queue!.pop();

                        if (event.circId === circuitId) {
                            console.log('Received event', event);
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

            try {
                // Race between timeout and circuit build
                await Promise.race([waitPromise, timeoutPromise]);
            } finally {
                // Always cleanup the event listener
                await this.removeEventListener(eventListener!);
            }
        }

        return circuitId;
    }

    async closeCircuit(circuitId: number): Promise<void> {
        const command = `CLOSECIRCUIT ${circuitId}`;

        const response = await this.msg(command);

        if (!response.startsWith('250')) {
            throw new Error(`Failed to close circuit: ${response}`);
        }
    }

    async getRelayInfo(fingerprint: string): Promise<RelayInfo> {
        const command = `GETINFO ns/id/$${fingerprint}`;
        const response = await this.msg(command);

        if (!response.startsWith('250+ns/id/')) {
            throw new Error(`Failed to get relay address: ${response}`);
        }

        const lines = response.split('\n').map(line => line.trim());

        let flags: Flag[] = [];
        let ip: string = '';
        let orPort: number = 0;
        let bandwidth: number = 0;
        let nickname: string = '';

        for (const line of lines) {
            // Extract flags from the line starting with 's '
            if (line.startsWith('s ')) {
                flags = line.substring(2).trim().split(' ').map(flag => Flag[flag as keyof typeof Flag]);
            }

            // Extract IP and ORPort from the line starting with 'r '
            if (line.startsWith('r ')) {
                const parts = line.split(' ');

                if (parts.length >= 7) {
                    nickname = parts[1];
                    ip = parts[6];
                    orPort = parseInt(parts[7], 10);
                }
            }

            if (line.startsWith('w ')) {
                bandwidth = parseInt(line.split('=')[1], 10);
            }
        }

        return { fingerprint, nickname, ip, orPort, flags, bandwidth };
    }

    end() {
        this.client.write('QUIT\r\n');
        this.client.end();
    }

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
                commandParts.push(key); // RESETCONF-style nulling
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
        const response = await this.msg(command);

        if (!response.startsWith('250 OK')) {
            throw new Error(`SETCONF/RESETCONF failed: ${response}`);
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

        const response = await this.msg(command);

        const {code, text} = parseFirstStatusCode(response);

        if (!Number.isNaN(code)) {
            if (code === 552) {
                console.warn(`[AnonCtrl] ATTACHSTREAM ${streamId} -> 552 Unknown stream; ignoring (stream likely closed)`);
                return false;
            }
            if (code === 555) {
                console.warn(`[AnonCtrl] ATTACHSTREAM ${streamId} -> 555 Connection is not managed by controller; ignoring`);
                return false;
            }
            if (!isOkCode(code)) {
                throw new Error(`AttachStream failed (${code}): ${text}`);
            }
        }

        return true;
    }

    private async attachListeners(): Promise<[EventType[], EventType[]]> {
        const setEvents: EventType[] = [];
        const failedEvents: EventType[] = [];

        if (!this.isAuthenticated || !this.client || this.client.destroyed) {
            return [setEvents, failedEvents];
        }

        const eventTypes = Array.from(this.eventListeners?.keys() || []);

        try {
            let isOk = await this.setEvents(eventTypes);
            if (isOk) {
                setEvents.push(...eventTypes);
            } else {
                for (const eventType of eventTypes) {
                    isOk = await this.setEvents([eventType]);
                    if (isOk) {
                        setEvents.push(eventType);
                    } else {
                        failedEvents.push(eventType);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to attach listeners:', err);
            failedEvents.push(...eventTypes);
        }

        return [setEvents, failedEvents];
    }

    private async attachEventListenersOrFail() {
        if (this.eventListeners.size === 0) {
            return;
        }

        const [, failedEventTypes] = await this.attachListeners();

        if (failedEventTypes.length > 0) {
            console.error('Failed to set events:', failedEventTypes);
            for (const event of failedEventTypes) {
                const callbacks = this.eventListeners.get(event);
                if (callbacks) {
                    this.eventListeners.delete(event);
                }
            }

            throw new Error(`Failed to set events: ${failedEventTypes}`);
        }
    }

    async addEventListener(callback: Function, ...eventTypes: EventType[]): Promise<void> {
        for (const eventType of eventTypes) {
            const callbacks: Function[] = this.eventListeners.get(eventType) || [];
            callbacks.push(callback);
            this.eventListeners.set(eventType, callbacks);
        }

        await this.attachEventListenersOrFail();
    }

    async removeEventListener(callback: Function): Promise<void> {
        let eventTypesChanged = false;

        for (const [eventType, callbacks] of this.eventListeners.entries()) {
            const index = callbacks.indexOf(callback);
            if (index !== -1) {
                callbacks.splice(index, 1);
            }

            if (callbacks.length === 0) {
                eventTypesChanged = true;
                this.eventListeners.delete(eventType);
            }
        }

        if (eventTypesChanged) {
            await this.attachEventListenersOrFail();
        }
    }

    /**
     *  Reads a single complete Tor *reply* from the control socket.
     *  - Handles 250/552 with -, +, and dot-terminated blocks
     *  - Routes async events (650 / 650- / 650+ ... '.') to eventQueue
     *  - Times out safely and cleans listeners
     *
     * * @param {number} timeoutMs - Timeout in milliseconds
     * * @returns {Promise<string>} - Resolves with the complete reply string
     */
    private readReply(timeoutMs: number = 10000): Promise<string> {
        return new Promise((resolve, reject) => {
            // -------------------------------
            // [1] Per-call state
            // -------------------------------
            let buffer = '';

            // Reply assembly
            let replyStatus: string | null = null;
            let replyDivider: ' ' | '+' | '-' | null = null;
            let inReplyDataBlock = false;
            const replyLines: string[] = [];

            // Event assembly
            let inEventDataBlock = false;
            let inEventContinuation = false;
            const eventLines: string[] = [];

            // -------------------------------
            // [2] Helpers
            // -------------------------------
            const tidy = () => {
                this.client.off('data', onData);
                this.client.off('error', onError);
                if (timer) clearTimeout(timer);
            };

            const pushEventNow = () => {
                if (!eventLines.length) return;
                this.eventQueue.push(eventLines.join('\r\n'));
                this.eventNotice?.set?.();
                eventLines.length = 0;
                inEventDataBlock = false;
                inEventContinuation = false;
            };

            const onError = (err: Error) => {
                tidy();
                reject(err);
            };

            let timer: NodeJS.Timeout;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    tidy();
                    reject(new Error('Timeout while waiting for Anon reply'));
                }, timeoutMs);
            }

            // -------------------------------
            // [3] Main data handler
            // -------------------------------
            const onData = (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n');
                buffer = lines.pop() || '';

                for (const raw of lines) {
                    const line = raw;

                    // --- [a] Handle asynchronous events ---
                    if (!replyStatus && line.startsWith('650')) {
                        const sep = line.charAt(3);
                        const rest = line.slice(4);

                        if (sep === ' ') {
                            eventLines.push(rest);
                            pushEventNow();
                            continue;
                        }
                        if (sep === '+') {
                            inEventDataBlock = true;
                            eventLines.push(rest);
                            continue;
                        }
                        if (sep === '-') {
                            inEventContinuation = true;
                            eventLines.push(rest);
                            continue;
                        }

                        eventLines.push(rest);
                        pushEventNow();
                        continue;
                    }

                    // --- [b] Handle event data blocks (650+) ---
                    if (inEventDataBlock) {
                        if (line === '.') {
                            inEventDataBlock = false;
                            pushEventNow();
                        } else {
                            eventLines.push(line.startsWith('..') ? line.slice(1) : line);
                        }
                        continue;
                    }

                    // --- [c] Handle event continuations (650-) ---
                    if (inEventContinuation) {
                        if (line.startsWith('650-')) {
                            eventLines.push(line.slice(4));
                            continue;
                        }
                        if (line.startsWith('650 ')) {
                            eventLines.push(line.slice(4));
                            pushEventNow();
                            continue;
                        }

                        pushEventNow(); // unexpected line ends continuation
                        // fall through to possible reply handling
                    }

                    // --- [d] First reply status line (e.g., 250 OK, 552 ...) ---
                    if (!replyStatus) {
                        const m = line.match(/^(\d{3})([ +\-])(.*)$/);
                        if (!m) continue; // ignore non-status noise
                        replyStatus = m[1];
                        replyDivider = m[2] as ' ' | '+' | '-';
                    }

                    // --- [e] Collect reply lines ---
                    if (inReplyDataBlock && line.startsWith('..')) {
                        replyLines.push(line.slice(1));
                    } else {
                        replyLines.push(line);
                    }

                    // --- [f] Terminal reply ---
                    if (line.startsWith(replyStatus + ' ')) {
                        tidy();
                        return resolve(replyLines.join('\r\n'));
                    }

                    // --- [g] Manage block/continuation ---
                    if (inReplyDataBlock) {
                        if (line === '.') inReplyDataBlock = false;
                        continue;
                    }

                    switch (replyDivider) {
                        case ' ':
                            tidy();
                            return resolve(replyLines.join('\r\n'));
                        case '+':
                            inReplyDataBlock = true;
                            break;
                        case '-':
                            // keep looping for more status lines
                            break;
                        default:
                            tidy();
                            return reject(new Error(`Unknown reply divider '${replyDivider}' in line: ${line}`));
                    }
                }
            };

            // -------------------------------
            // [4] Register listeners
            // -------------------------------
            this.client.on('data', onData);
            this.client.once('error', onError);
        });
    }

    private createLoopTasks(): void {
        if (!this.readerLoopTask) {
            this.readerLoopTask = this.readerLoop();
        }

        if (!this.eventLoopTask) {
            this.eventLoopTask = this.eventLoop();
        }
    }

    private async readerLoop(): Promise<void> {
        while (this.client && !this.client.destroyed) {
            try {
                // read one complete reply (events already routed inside readReply)
                const raw = await this.readReply(0);

                // soft-parse the first status line to detect 5xx
                const { code, text } = parseFirstStatusCode(raw);

                if (!Number.isNaN(code) && !isOkCode(code) && code >= 500) {
                    // Protocol error reply (e.g., 552 Unrecognized event)
                    // Log for observability; still push raw so msg() can decide what to do.
                    // (Optional) also push an annotated line to aid older callers.
                    // console.warn(`[TorCtrl] ReplyError ${code}: ${text}`);
                    this.replyQueue.push(`ReplyError: ${code} ${text}${CRLF}${raw}`);
                } else {
                    // Normal 2xx (or unparseable but non-fatal) reply
                    this.replyQueue.push(raw);
                }
            } catch (err: any) {
                // Only transport/timeout/etc errors should reach here
                const msg =
                    err instanceof Error ? err.message : String(err);
                this.replyQueue.push(`ControllerError: ${msg}`);
            }
        }
    }

    // --- parser ---
    private convertToEvent(eventMessage: string): Event {
        const lines = eventMessage.split(CRLF);         // supports multi-line events
        const header = lines[0] ?? '';
        const extraLines = lines.slice(1);        // 650- / 650+ payload or extra KEY=VALUE lines

        // Tokenize header + any extra lines; tolerate extra args/keywords in any order
        const headerTokens = splitSmart(header);
        const eventName = headerTokens[0] ?? '';
        const allTokens = collectTokensFromLines([headerTokens.slice(1).join(' '), ...extraLines]);
        const { positional, kv } = partitionKv(allTokens);

        // Optional raw payload (useful for 650+ blocks like HS_DESC_CONTENT)
        const payload = extraLines.length ? extraLines.join(CRLF) : undefined;

        // Map to enum safely
        const eventType = (EventType as any)[eventName] as EventType | undefined;

        switch (eventType) {
            case EventType.STREAM: {
                // STREAM <StreamID> <Status> <CircID> <Target> [KEY=VAL ...]
                const [streamIdStr, status, circIdStr, target, ...restPos] = positional;
                // Merge any restPos that look like KEY=VAL back into kv (robust to weird splitting)
                for (const t of restPos) {
                    const i = t.indexOf('=');
                    if (i > 0) kv[t.slice(0, i).toUpperCase()] = t.slice(i + 1);
                }
                return {
                    type: EventType.STREAM,
                    streamId: toInt(streamIdStr) ?? -1,
                    status,
                    circId: toInt(circIdStr),
                    target,
                    sourceAddr: kv['SOURCE_ADDR'] ?? null,
                    purpose: kv['PURPOSE'] ?? null,
                    reason: kv['REASON'] ?? null,
                    remoteReason: kv['REMOTE_REASON'] ?? null,
                    source: kv['SOURCE'] ?? null,
                    // keep everything else just in case
                    kv,
                    payload,
                    data: lines.join(" ") // todo - remove later
                } as StreamEvent;
            }

            case EventType.ADDRMAP: {
                // ADDRMAP <address> <newaddress> [expiry]
                const [address, mappedAddress, expires] = positional;
                return {
                    type: EventType.ADDRMAP,
                    address,
                    mappedAddress,
                    expires: expires ? new Date(expires) : undefined,
                    streamId: kv['STREAMID'] ? toInt(kv['STREAMID']!) ?? undefined : undefined,
                    cached: kv['CACHED'] ? kv['CACHED'] === 'YES' : undefined,
                    // keep everything else just in case
                    kv,
                    payload,
                    data: lines.join(" ")
                } as AddrMapEvent;
            }

            case EventType.CIRC: {
                // CIRC <CircID> <Status> [PathCommaList] [KEY=VAL ...]
                // Path tokens begin with '$' (may be comma-separated)
                const [circIdStr, status, ...rest] = positional;
                const circId = toInt(circIdStr) ?? -1;

                const path: CircHop[] = [];
                let i = 0;
                for (; i < rest.length; i++) {
                    const tok = rest[i];
                    if (!tok.startsWith('$')) break;
                    for (const hop of tok.split(',')) {
                        const [fpRaw, nick] = hop.split('~');
                        const fp = fpRaw?.replace(/^\$/, '') ?? '';
                        path.push({ fingerprint: fp, nickname: nick });
                    }
                }
                // Any leftover positional tokens that are KEY=VAL — fold them into kv
                for (; i < rest.length; i++) {
                    const t = rest[i];
                    const eq = t.indexOf('=');
                    if (eq > 0) kv[t.slice(0, eq).toUpperCase()] = t.slice(eq + 1);
                }

                return {
                    type: EventType.CIRC,
                    circId,
                    status: status as CircStatus,
                    path,
                    buildFlags: kv['BUILD_FLAGS'] ? kv['BUILD_FLAGS'].split(',') : undefined,
                    purpose: kv['PURPOSE'],
                    reason: kv['REASON'],
                    remoteReason: kv['REMOTE_REASON'],
                    timeCreated: kv['TIME_CREATED'] ? new Date(kv['TIME_CREATED'] + 'Z') : undefined,
                    kv,
                    payload,
                    data: lines.join(" ") // todo - remove later
                } as CircEvent;
            }

            default: {
                // Generic, tolerant handler for any current/future event types
                return {
                    type: eventType ?? (eventName as any),
                    args: positional,
                    kv,
                    payload,            // if this was a 650+ block, payload carries the body
                    raw: eventMessage,  // keep raw for debugging/advanced handlers
                } as any;
            }
        }
    }

    private async handleEvent(eventMessage: string): Promise<void> {
        let event: any = null;
        let eventType: EventType;

        event = this.convertToEvent(eventMessage);  // you’ll implement this parser
        eventType = event.type;

        // Dispatch to listeners
        const listeners = this.eventListeners.get(eventType);
        if (listeners) {
            for (const listener of listeners) {
                try {
                    const result = listener(event);
                    if (result instanceof Promise) {
                        await result;
                    }
                } catch (err) {
                    console.warn(`Event listener for ${eventType} raised an error:`, err);
                }
            }
        }
    }

    private async eventLoop(): Promise<void> {
        let socketClosedAt: number | null = null;

        while (true) {
            try {
                const eventMessage = await this.eventQueue.pop();

                await this.handleEvent(eventMessage);

                if (!this.client || this.client.destroyed) {
                    if (!socketClosedAt) {
                        socketClosedAt = Date.now();
                    } else if (Date.now() - socketClosedAt > 100) {
                        break;
                    }
                }
            } catch (err) {
                if (!this.client || this.client.destroyed) break;

                try {
                    await Promise.race([
                        this.eventNotice.wait(),
                        new Promise(resolve => setTimeout(resolve, 50)),
                    ]);
                } catch (err: any) {
                    console.log("Event loop wait error:", err);
                }
                this.eventNotice.clear();
            }
        }
    }

    async getRelays(): Promise<RelayInfo[]> {
        const response = await this.msg('GETINFO ns/all');

        if (!response.startsWith('250+ns/all=')) {
            throw new Error('Invalid response format');
        }

        const cleanedResponse = response
            .replace(/^250\+ns\/all=/, '')
            .replace(/250 OK$/, '')
            .trim();

        const relays: RelayInfo[] = [];
        const lines = cleanedResponse.split('\n');

        let current: Partial<RelayInfo> = {};

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith('r ')) {
                if (current.fingerprint) {
                    relays.push(current as RelayInfo);
                    current = {};
                }
                const [, nickname, fingerprint, , date, time, ip, orPort, dirPort] = trimmedLine.split(' ');

                current.nickname = nickname;
                current.fingerprint = this.base64ToHex(fingerprint);
                current.published = new Date(`${date}T${time}Z`);
                current.ip = ip;
                current.orPort = parseInt(orPort, 10);
                current.dirPort = parseInt(dirPort, 10);
                current.flags = [];
                current.bandwidth = 0;
            } else if (trimmedLine.startsWith('s ')) {
                current.flags = trimmedLine.substring(2).split(' ').map(flag => Flag[flag as keyof typeof Flag]);
            } else if (trimmedLine.startsWith('w ')) {
                const match = trimmedLine.match(/Bandwidth=(\d+)/);
                if (match) {
                    current.bandwidth = parseInt(match[1], 10);
                }
            }
        }

        if (current.fingerprint) {
            relays.push(current as RelayInfo);
        }

        return relays;
    }

    async findFirstByCountry(relays: RelayInfo[], firstCount: number, ...countries: string[]): Promise<RelayInfo[]> {
        const result: RelayInfo[] = [];

        for (const relay of relays) {
            if (firstCount > 0 && result.length >= firstCount) {
                break;
            }

            try {
                const country = await this.getCountry(relay.ip);
                if (countries.includes(country)) {
                    result.push(relay);
                }
            } catch (err) {
                console.warn(`Failed to get country for ${relay.ip}:`, err);
            }
        }

        return result;
    }

    async getRelaysByCountries(...countries: string[]): Promise<RelayInfo[]> {
        const relays = await this.getRelays();
        const result: RelayInfo[] = [];

        for (const relay of relays) {
            try {
                const country = await this.getCountry(relay.ip);
                if (countries.includes(country)) {
                    result.push(relay);
                }
            } catch (err) {
                console.warn(`Failed to get country for ${relay.ip}:`, err);
            }
        }

        return result;
    }

    async populateCountries(relays: RelayInfo[]): Promise<void> {
        for (const relay of relays) {
            if (relay.country) {
                continue;
            }

            try {
                relay.country = await this.getCountry(relay.ip);
            } catch (err) {
                console.warn(`Failed to get country for ${relay.ip}:`, err);
            }
        }
    }

    async filterRelaysByCountries(relays: RelayInfo[], ...countries: string[]): Promise<RelayInfo[]> {
        countries = countries.map(country => country.toLowerCase());
        const result: RelayInfo[] = [];

        for (const relay of relays) {
            try {
                const country = await this.getCountry(relay.ip);
                if (countries.includes(country)) {
                    result.push(relay);
                }
            } catch (err) {
                console.warn(`Failed to get country for ${relay.ip}:`, err);
            }
        }

        return result;
    }

    filterRelaysByFlags(relays: RelayInfo[], ...flags: Flag[]): RelayInfo[] {
        return relays.filter(relay => {
            return flags.every(flag => relay.flags.includes(flag));
        });
    }

    async getCountry(address: string, timeoutMs: number = 1000): Promise<string> {
        const msgPromise = this.msg(`GETINFO ip-to-country/${address}`);
        const timeout = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('getCountry timeout')), timeoutMs)
        );

        const response = await Promise.race([msgPromise, timeout]);

        if (!response.startsWith('250-ip-to-country/')) {
            throw new Error('Invalid response format');
        }

        const cleanedResponse = response
            .replace(/^250-ip-to-country\//, '')
            .replace(/250 OK$/, '')
            .trim();

        const parts = cleanedResponse.split('=');
        if (parts.length < 2) {
            throw new Error('Invalid response format');
        }

        return parts[1];
    }

    private base64ToHex(identity: string, checkIfFingerprint: boolean = true): string {
        let decoded: Buffer;

        try {
            decoded = Buffer.from(identity, 'base64');
        } catch (err) {
            throw new Error(`Unable to decode identity string '${identity}'`);
        }

        const hex = decoded.toString('hex').toUpperCase();

        if (checkIfFingerprint && !this.isValidFingerprint(hex)) {
            throw new Error(`Decoded '${identity}' to '${hex}', which isn't a valid fingerprint`);
        }

        return hex;
    }

    private isValidFingerprint(hex: string): boolean {
        return /^[A-F0-9]{40}$/.test(hex);
    }
}

// --- helpers ---
const CRLF = '\r\n' as const;
const STATUS_LINE_RE = /^(\d{3})[ +\-](.*)$/;
const isOkCode = (n: number) => n >= 200 && n < 300;

function parseFirstStatusCode(raw: string): { code: number; text: string } {
    const line = raw.split(CRLF)[0] ?? '';
    const m = STATUS_LINE_RE.exec(line);
    if (!m) return { code: NaN, text: line };
    return { code: Number(m[1]), text: m[2] ?? '' };
}

function splitSmart(s: string): string[] {
    // split on spaces but respect "quoted strings"
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' ) {
            inQ = !inQ;
            continue;
        }
        if (!inQ && ch === ' ') {
            if (cur) {
                out.push(cur);
                cur = '';
            }
            continue;
        }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

function collectTokensFromLines(lines: string[]): string[] {
    const tokens: string[] = [];
    for (const line of lines) {
        if (!line) continue;
        tokens.push(...splitSmart(line));
    }
    return tokens;
}

function partitionKv(tokens: string[]): { positional: string[]; kv: Record<string,string> } {
    const positional: string[] = [];
    const kv: Record<string,string> = {};
    for (const t of tokens) {
        const eq = t.indexOf('=');
        if (eq > 0) {
            const k = t.slice(0, eq).toUpperCase();
            const v = t.slice(eq + 1);
            kv[k] = v;
        } else {
            positional.push(t);
        }
    }
    return { positional, kv };
}

function toInt(x?: string): number | undefined {
    if (x == null) return undefined;
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
}
