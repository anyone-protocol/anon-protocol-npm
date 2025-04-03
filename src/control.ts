import * as net from 'net';
import { AsyncQueue, AsyncEvent } from './queue';

export class Control {
    private client: net.Socket;
    private isAuthenticated: boolean = false;
    private eventListeners: Map<string, Function[]> = new Map();

    private lastHeartbeat = Date.now();

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
    }

    /**
     * AUTHENTICATE
        Sent from the client to the server.  The syntax is:

            "AUTHENTICATE" [ SP 1*HEXDIG / QuotedString ] CRLF

        This command is used to authenticate to the server. The provided string is
        one of the following:

            * (For the HASHEDPASSWORD authentication method; see 3.21)
            The original password represented as a QuotedString.

            * (For the COOKIE is authentication method; see 3.21)
            The contents of the cookie file, formatted in hexadecimal

            * (For the SAFECOOKIE authentication method; see 3.21)
            The HMAC based on the AUTHCHALLENGE message, in hexadecimal.

        The server responds with 250 OK on success or 515 Bad authentication if
        the authentication cookie is incorrect.  Tor closes the connection on an
        authentication failure.

        The authentication token can be specified as either a quoted ASCII string,
        or as an unquoted hexadecimal encoding of that same string (to avoid escaping
        issues).

        For information on how the implementation securely stores authentication
        information on disk, see section 5.1.

        Before the client has authenticated, no command other than
        PROTOCOLINFO, AUTHCHALLENGE, AUTHENTICATE, or QUIT is valid.  If the
        controller sends any other command, or sends a malformed command, or
        sends an unsuccessful AUTHENTICATE command, or sends PROTOCOLINFO or
        AUTHCHALLENGE more than once, Tor sends an error reply and closes
        the connection.

        To prevent some cross-protocol attacks, the AUTHENTICATE command is still
        required even if all authentication methods in Tor are disabled.  In this
        case, the controller should just send "AUTHENTICATE" CRLF.
        (Versions of Tor before 0.1.2.16 and 0.2.0.4-alpha did not close the
        connection after an authentication failure.)
     * @param password 
     * @returns 
     */
    async authenticate(password: string = 'password'): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => {
                this.client.off('error', onError); // cleanup
                console.error('Control port error:', err);
                reject(err);
            };

            const onData = (data: Buffer) => {
                this.client.off('error', onError); // cleanup
                const response = data.toString();
                console.log('Control port response:', response);

                if (response.startsWith('250 OK')) {
                    console.log('Authenticated successfully');
                    this.isAuthenticated = true;
                    this.createLoopTasks();
                    resolve();
                } else if (response.startsWith('515')) {
                    console.error('Authentication failed');
                    this.client.end();
                    reject('Authentication failed');
                }
            };

            this.client.once('data', onData);
            this.client.on('error', onError);

            this.client.write(`AUTHENTICATE "${password}"\r\n`);
        });
    }

    /**
     * SETEVENTS
        Request the server to inform the client about interesting events. The syntax is:

        "SETEVENTS" [SP "EXTENDED"] *(SP EventCode) CRLF
    
        EventCode = 1*(ALPHA / "_")  (see section 4.1.x for event types)
        Any events not listed in the SETEVENTS line are turned off; thus, 
        sending SETEVENTS with an empty body turns off all event reporting.

        The server responds with a 250 OK reply on success, 
        and a 552 Unrecognized event reply if one of the event codes isn’t recognized. 
        (On error, the list of active event codes isn’t changed.)

        If the flag string “EXTENDED” is provided, 
        Tor may provide extra information with events for this connection; 
        see 4.1 for more information. 
        NOTE: All events on a given connection will be provided in extended format, or none. 
        NOTE: “EXTENDED” was first supported in Tor 0.1.1.9-alpha; it is always-on in Tor 0.2.2.1-alpha and later.

        Each event is described in more detail in Section 4.1.
     */
    async setEvents(events: string[]): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const command = `SETEVENTS ${events.join(' ')}\r\n`;

            const onError = (err: Error) => {
                this.client.off('error', onError);
                reject(err);
            };

            const onData = (data: Buffer) => {
                this.client.off('error', onError);
                const response = data.toString();
                console.log('Control port response:', response);

                if (response.startsWith('250 OK')) {
                    resolve(true);
                } else if (response.startsWith('552')) {
                    console.error('Unrecognized event');
                    reject(false);
                } else {
                    reject(new Error(`Unexpected response: ${response}`));
                }
            };

            this.client.once('data', onData);
            this.client.on('error', onError);
            this.client.write(command);
        });
    }

    async sendCommand(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const onError = (err: Error) => {
                this.client.off('error', onError);
                reject(err);
            };

            const onData = (data: Buffer) => {
                this.client.off('error', onError);
                const response = data.toString();
                resolve(response);
            };

            this.client.once('data', onData);
            this.client.on('error', onError);
            this.client.write(`${command}\r\n`);
        });
    }

    /**
     * GETINFO
        Sent from the client to the server.  The syntax is as for GETCONF:
            "GETINFO" 1*(SP keyword) CRLF

        Unlike GETCONF, this message is used for data that are not stored in the Tor
        configuration file, and that may be longer than a single line.  On success,
        one ReplyLine is sent for each requested value, followed by a final 250 OK
        ReplyLine.  If a value fits on a single line, the format is:
            250-keyword=value

        If a value must be split over multiple lines, the format is:
            250+keyword=
            value
            .
        The server sends a 551 or 552 error on failure.
        Recognized keys and their values include:
     
        "circuit-status"
        A series of lines as for a circuit status event. Each line is of
        the form described in section 4.1.1, omitting the initial
        "650 CIRC ".  Note that clients must be ready to accept additional
        arguments as described in section 4.1.

     * @returns 
     */
    async circuitStatus(): Promise<CircuitStatus[]> {
        return this.sendCommand('GETINFO circuit-status').then(response => {

            if (!response.startsWith('250+circuit-status=') && !response.startsWith('250 OK')) {
                console.error('Invalid response: ', response);
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

    async msg(message: string): Promise<string> {
        // Acquire message lock
        await this.msgLock.push();

        try {
            // Flush any old responses/errors in the reply queue
            while (!this.replyQueue.isEmpty) {
                const response = await this.replyQueue.pop();

                if (response.includes('SocketClosed')) {
                    // This is expected sometimes
                    continue;
                } else if (response.includes('ProtocolError')) {
                    console.info('Tor provided a malformed message:', response);
                } else if (response.includes('ControllerError')) {
                    console.info('Socket experienced a problem:', response);
                } else {
                    console.info('Failed to deliver a response:', response);
                }
            }

            // Send the message
            this.client.write(`${message}\r\n`);

            // Wait for reply
            const response = await this.replyQueue.pop();

            // In a real implementation, you'd parse response objects here
            if (response.startsWith('5')) {
                throw new Error(`ControllerError: ${response}`);
            }

            return response;
        } catch (err) {
            if (!this.client || this.client.destroyed) {
                this.end();
                throw new Error('SocketClosed');
            }

            throw err;
        } finally {
            this.msgLock.pop(); // Release lock
        }
    }

    async resolve(hostname: string): Promise<void> {
        await this.msg(`RESOLVE ${hostname}`);
    }

    /**
     * GETINFO
        Sent from the client to the server.  The syntax is as for GETCONF:
            "GETINFO" 1*(SP keyword) CRLF

        Unlike GETCONF, this message is used for data that are not stored in the Tor
        configuration file, and that may be longer than a single line.  On success,
        one ReplyLine is sent for each requested value, followed by a final 250 OK
        ReplyLine.  If a value fits on a single line, the format is:
            250-keyword=value

        If a value must be split over multiple lines, the format is:
            250+keyword=
            value
            .
        The server sends a 551 or 552 error on failure.
        Recognized keys and their values include:
     
        "ns/all"
         Router status info (v3 directory style) for all ORs we
        that the consensus has an opinion about, joined by newlines.
        [First implemented in 0.1.2.3-alpha.]
        [In 0.2.0.9-alpha this switched from v2 directory style to v3]

     * @returns 
     */
    async routerStatus(): Promise<RouterStatus[]> {
        const response = await this.sendCommand('GETINFO ns/all');

        if (!response.startsWith('250+ns/all=')) {
            throw new Error('Invalid response format');
        }

        const cleanedResponse = response
            .replace(/^250\+ns\/all=/, '')
            .replace(/250 OK$/, '')
            .trim();

        const routers: RouterStatus[] = [];
        const lines = cleanedResponse.split('\n');

        let currentRouter: Partial<RouterStatus> = {};

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Router line starts with 'r '
            if (trimmedLine.startsWith('r ')) {
                if (Object.keys(currentRouter).length > 0) {
                    routers.push(currentRouter as RouterStatus);
                }
                currentRouter = {};

                const [, nickname, fingerprint, digest, date, time, ip, orPort, dirPort] =
                    trimmedLine.split(' ');

                currentRouter = {
                    nickname,
                    fingerprint,
                    digest,
                    publishedTime: new Date(`${date}T${time}Z`),
                    ip,
                    orPort: parseInt(orPort, 10),
                    dirPort: parseInt(dirPort, 10),
                    flags: [],
                    bandwidth: 0
                };
            }

            // Flags line starts with 's '
            else if (trimmedLine.startsWith('s ')) {
                currentRouter.flags = trimmedLine.substring(2).split(' ');
            }

            // Bandwidth line starts with 'w '
            else if (trimmedLine.startsWith('w ')) {
                const bwMatch = trimmedLine.match(/Bandwidth=(\d+)/);
                if (bwMatch) {
                    currentRouter.bandwidth = parseInt(bwMatch[1], 10);
                }
            }
        }

        if (Object.keys(currentRouter).length > 0) {
            routers.push(currentRouter as RouterStatus);
        }

        return routers;
    }

    /**
     * EXTENDCIRCUIT
        Sent from the client to the server.  The format is:

        "EXTENDCIRCUIT" SP CircuitID
            [SP ServerSpec *("," ServerSpec)]
            [SP "purpose=" Purpose] CRLF

        This request takes one of two forms: either the CircuitID is zero, in
        which case it is a request for the server to build a new circuit,
        or the CircuitID is nonzero, in which case it is a request for the
        server to extend an existing circuit with that ID according to the
        specified path.

        If the CircuitID is 0, the controller has the option of providing
        a path for Anon to use to build the circuit. If it does not provide
        a path, Anon will select one automatically from high capacity nodes
        according to path-spec.txt.

        If CircuitID is 0 and "purpose=" is specified, then the circuit's
        purpose is set. Two choices are recognized: "general" and
        "controller". If not specified, circuits are created as "general".

        If the request is successful, the server sends a reply containing a
        message body consisting of the CircuitID of the (maybe newly created)
        circuit. The syntax is:
        "250" SP "EXTENDED" SP CircuitID CRLF
     * @param options 
     * @returns circuitId
     */
    async extendCircuit(options: ExtendCircuitOptions = {}): Promise<number> {
        const circuitId: number = options.circuitId ?? 0;
        const serverSpecs: string[] = options.serverSpecs ?? [];
        const purpose: Purpose = options.purpose ?? 'general';

        let command = `EXTENDCIRCUIT ${circuitId}`;

        if (serverSpecs.length > 0) {
            command += ` ${serverSpecs.join(',')}`;
        }

        if (purpose) {
            command += ` purpose=${purpose}`;
        }

        const response = await this.sendCommand(command);

        if (!response.startsWith('250 EXTENDED')) {
            console.error('Failed to extend circuit:', response);
            throw new Error('Failed to extend circuit');
        }

        return parseInt(response.split(' ')[2], 10); // circuitId
    }

    /**
     * CLOSECIRCUIT
        The syntax is:

            "CLOSECIRCUIT" SP CircuitID *(SP Flag) CRLF
            Flag = "IfUnused"


        Tells the server to close the specified circuit. If "IfUnused" is
        provided, do not close the circuit unless it is unused.
        Other flags may be defined in the future; Tor SHOULD ignore unrecognized
        flags.

        Tor replies with 250 OK on success, or a 512 if there aren't enough
        arguments, or a 552 if it doesn't recognize the CircuitID.
     * @param circuitId 
     */
    async closeCircuit(circuitId: number): Promise<void> {
        const command = `CLOSECIRCUIT ${circuitId}`;

        const response = await this.sendCommand(command);

        if (!response.startsWith('250')) {
            throw new Error(`Failed to close circuit: ${response}`);
        }
    }

    /**
     * Get relay info by fingerprint
     * @param fingerprint 
     * @returns address
     */
    async getRelayInfo(fingerprint: string): Promise<RelayInfo> {
        const command = `GETINFO ns/id/$${fingerprint}`;
        const response = await this.sendCommand(command);

        if (!response.startsWith('250+ns/id/')) {
            throw new Error(`Failed to get relay address: ${response}`);
        }

        const lines = response.split('\n').map(line => line.trim());

        let flags: string[] = [];
        let ip: string = '';
        let orPort: number = 0;
        let bandwidth: number = 0;
        let nickname: string = '';

        for (const line of lines) {
            // Extract flags from the line starting with 's '
            if (line.startsWith('s ')) {
                flags = line.substring(2).trim().split(' ');
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

    /**
     * QUIT
        Tells the server to hang up on this controller connection. This command
        can be used before authenticating.
     */
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
        const response = await this.sendCommand(command);

        if (!response.startsWith('250 OK')) {
            throw new Error(`SETCONF/RESETCONF failed: ${response}`);
        }
    }

    /**
     * ATTACHSTREAM
     * Attaches a stream to a circuit\
     * 
     * @param streamId - ID of the stream to be attached
     * @param circuitId - ID of the circuit to attach to
     * @param exitingHop - Optional hop index where traffic should exit
     * @throws Error if the stream or circuit is invalid, unsatisfiable, or the operation fails
     */
    async attachStream(streamId: number, circuitId: number, exitingHop?: number): Promise<void> {
        let command = `ATTACHSTREAM ${streamId} ${circuitId}`;

        if (exitingHop !== undefined) {
            command += ` HOP=${exitingHop}`;
        }

        const response = await this.sendCommand(command);

        if (!response.startsWith('250')) {
            if (response.startsWith('552')) {
                throw new Error(`InvalidRequest: ${response}`);
            } else if (response.startsWith('551')) {
                throw new Error(`OperationFailed: ${response}`);
            } else if (response.startsWith('555')) {
                throw new Error(`UnsatisfiableRequest: ${response}`);
            } else {
                throw new Error(`ProtocolError: Unexpected ATTACHSTREAM response: ${response}`);
            }
        }
    }

    private async attachListeners(): Promise<[string[], string[]]> {
        const setEvents: string[] = [];
        const failedEvents: string[] = [];

        console.log('Is auth:', this.isAuthenticated);

        if (!this.isAuthenticated || !this.client || this.client.destroyed) {
            return [setEvents, failedEvents];
        }

        const eventTypes = Array.from(this.eventListeners?.keys() || []);

        try {
            console.log('Send attach request');
            var isOk = await this.setEvents(eventTypes);
            console.log('Attach request response:', isOk);
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

        console.log('Attaching event listeners:', this.eventListeners.size);

        const [, failedEvents] = await this.attachListeners();

        console.log('Failed events:', failedEvents);

        if (failedEvents.length > 0) {
            console.error('Failed to set events:', failedEvents);
            for (const event of failedEvents) {
                const callbacks = this.eventListeners.get(event);
                if (callbacks) {
                    this.eventListeners.delete(event);
                }
            }

            throw new Error(`Failed to set events: ${failedEvents}`);
        }
    }

    async addEventListener(callback: Function, ...eventType: string[]): Promise<void> {
        for (const event of eventType) {
            var callbacks: Function[] = this.eventListeners.get(event) || [];
            callbacks.push(callback);
            this.eventListeners.set(event, callbacks);
        }

        console.log('Adding event listeners:', eventType);
        console.log('Listeners:', this.eventListeners);

        await this.attachEventListenersOrFail();
    }

    async removeEventListener(callback: Function): Promise<void> {
        var eventTypesChanged = false;

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

    private async recv(): Promise<string> {
        return new Promise((resolve, reject) => {
            let buffer = '';
            let rawLines: string[] = [];
            let inDataBlock = false;
            let statusCode: string | null = null;
            let divider: string | null = null;

            const onData = (data: Buffer) => {
                buffer += data.toString();

                const lines = buffer.split('\r\n');

                // Hold the last possibly incomplete line
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!inDataBlock && !/^\d{3}[ +\-]/.test(line)) {
                        this.client.off('data', onData);
                        return reject(new Error(`Malformed control message: ${line}`));
                    }

                    rawLines.push(line);

                    if (!statusCode) {
                        statusCode = line.substring(0, 3);
                        divider = line.charAt(3);
                    }

                    if (inDataBlock) {
                        if (line === '.') {
                            this.client.off('data', onData);
                            return resolve(rawLines.join('\r\n'));
                        }

                        const cleanLine = line.startsWith('..') ? line.slice(1) : line;
                        rawLines[rawLines.length - 1] = cleanLine;
                        continue;
                    }

                    switch (divider) {
                        case ' ':
                            this.client.off('data', onData);
                            return resolve(rawLines.join('\r\n'));
                        case '+':
                            inDataBlock = true;
                            break;
                        case '-':
                            // continue collecting lines
                            break;
                        default:
                            this.client.off('data', onData);
                            return reject(new Error(`Unknown divider: '${divider}' in line: ${line}`));
                    }
                }
            };

            this.client.on('data', onData);
            this.client.once('error', (err) => {
                this.client.off('data', onData);
                reject(err);
            });
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
                const message = await this.recv();
                this.lastHeartbeat = Date.now();

                if (message.startsWith('650')) {
                    // Asynchronous event
                    this.eventQueue.push(message.substring(4));
                    this.eventNotice.set();
                } else {
                    // Synchronous reply
                    this.replyQueue.push(message);
                }
            } catch (err: any) {
                // Unblock any waiting sendCommand calls
                this.replyQueue.push(err.toString());
            }
        }
    }

    private convertToEvent(eventMessage: string): Event {
        const parts = eventMessage.split(' ');
        const eventType = parts[0];
        const eventData = parts.slice(1).join(' ');

        // Example parsing logic
        // You can customize this based on the actual event format

        switch (eventType) {
            case 'STREAM':
                const [streamId, status, circId, target, ...rest] = parts.slice(1);

                const keywordArgs: Record<string, string> = {};
                for (const arg of rest) {
                    const [key, value] = arg.split('=');
                    if (key && value !== undefined) {
                        keywordArgs[key.toUpperCase()] = value;
                    }
                }

                const event: StreamEvent = {
                    type: eventType,
                    streamId: parseInt(streamId, 10),
                    status,
                    circId,
                    target,
                    sourceAddr: keywordArgs['SOURCE_ADDR'] || null,
                    purpose: keywordArgs['PURPOSE'] || null,
                    reason: keywordArgs['REASON'] || null,
                    remoteReason: keywordArgs['REMOTE_REASON'] || null,
                    source: keywordArgs['SOURCE'] || null
                };

                return event;

            case 'ADDRMAP':
                const [address, mappedAddress, expires] = parts.slice(1);
                const addrMapEvent: AddrMapEvent = {
                    type: eventType,
                    address,
                    mappedAddress,
                    expires: expires ? new Date(expires) : undefined
                };
                return addrMapEvent;

            default:
                return {
                    type: eventType,
                    data: eventData,
                };
        }
    }

    private async handleEvent(eventMessage: string): Promise<void> {
        let event: any = null;
        let eventType: string;

        try {
            event = this.convertToEvent(eventMessage);  // you’ll implement this parser
            eventType = event.type;
        } catch (err) {
            event = eventMessage;
            eventType = 'MALFORMED_EVENTS';
            console.error(`Tor sent a malformed event (${err}):`, eventMessage);
        }

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
                } catch { }
                this.eventNotice.clear();
            }
        }
    }
}

interface CircuitStatus {
    circuitId: number;
    state: string;
    relays: Relay[];
    buildFlags: string[];
    purpose: string;
    timeCreated: Date;
}

interface RouterStatus {
    nickname: string;
    fingerprint: string;
    digest: string;
    publishedTime: Date;
    ip: string;
    orPort: number;
    dirPort: number;
    flags: string[];
    bandwidth: number;
}

interface Relay {
    fingerprint: string;
    nickname: string;
}

type Purpose = 'general' | 'controller';

interface ExtendCircuitOptions {
    circuitId?: number;
    serverSpecs?: string[];
    purpose?: Purpose;
}

interface RelayInfo {
    fingerprint: string;
    nickname: string;
    ip: string;
    orPort: number;
    flags: string[];
    bandwidth: number;
}

interface ControlMessage {
    code: string;
    divider: string;
    content: string;
    raw: string;
    arrivedAt?: number;
}

interface Event {
    type: string;
    data?: string;
}

interface StreamEvent extends Event {
    type: 'STREAM';
    streamId: number;
    status: string;
    circId: string;
    target: string;
    sourceAddr: string | null;
    purpose: string | null;
    reason: string | null;
    remoteReason: string | null;
    source: string | null;
}

interface AddrMapEvent {
    type: 'ADDRMAP';
    address: string;
    mappedAddress: string;
    expires?: Date;
}

export {
    CircuitStatus,
    RouterStatus,
    Relay,
    Purpose,
    ExtendCircuitOptions,
    RelayInfo,
    ControlMessage,
    Event,
    StreamEvent,
    AddrMapEvent
}
