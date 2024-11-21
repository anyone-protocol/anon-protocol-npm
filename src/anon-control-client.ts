import * as net from 'net';

export class AnonControlClient {
    private client: net.Socket;

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
    authenticate(password: string = 'password'): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.client.write(`AUTHENTICATE "${password}"\r\n`);

            this.client.once('data', (data: Buffer) => {
                const response = data.toString();
                console.log('Control port response:', response);

                if (response.startsWith('250 OK')) {
                    console.log('Authenticated successfully');
                    resolve();
                } else if (response.startsWith('515')) {
                    console.error('Authentication failed');
                    this.client.end();
                    reject('Authentication failed');
                }
            });

            this.client.on('error', (err: Error) => {
                console.error('Control port error:', err);
                reject(err);
            });
        });
    }

    async sendCommand(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.client.write(`${command}\r\n`);

            this.client.once('data', (data: Buffer) => {
                const response = data.toString();
                resolve(response);
            });

            this.client.on('error', (err: Error) => {
                console.error('Control port error:', err);
                reject(err);
            });
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
                    ?.split('=')[1]+'Z' || ''); // Add Z to make it ISO 8601 compliant
        
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

        return {fingerprint, nickname, ip, orPort, flags, bandwidth};
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
