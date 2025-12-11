import {CircEvent, CircHop, Control, EventType, Process, StreamEvent} from '../src';
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
};

class StateManager {
    private control!: Control;
    private anon: Process;
    private shuttingDown = false;
    private streams: Map<number, StreamEntry> = new Map();
    private circuits: Map<number, CircuitEntry> = new Map();
    private targets: string[] = ['ip-api.com', 'api.ipify.org'];

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

            await this.control.disableStreamAttachment();

            const attachStreamIfNeeded = async (streamEvent: StreamEvent) => {
                const streamId = streamEvent.streamId;
                const se = this.streams.get(streamId);
                if (!se || (se.status !== 'NEW' && se.status !== 'DETACHED')) return;

                const target = streamEvent.target.split(":")[0];
                if (this.targets.length !== 0 && this.targets.includes(target)) {
                    const built = [...this.circuits.values()].filter(c => c.status === 'BUILT');
                    if (built.length === 0) {
                        console.warn(`No built circuits available for stream ${streamId}`);
                        return;
                    }
                    const circ = built[randomInt(built.length)];
                    const attached = await this.control.attachStream(streamId, circ.id);
                    if (!attached) console.warn(`Failed to manually attach stream ${streamId} to circuit  ${circ.id}`);
                } else {
                    const attached = await this.control.attachStream(streamId, 0);
                    if (!attached) console.warn(`Failed to automatically attach stream ${streamId}`);
                }
            }

            const streamEventListener = async (event: StreamEvent) => {
                // console.log("Stream Event:", event);
                const streamId = event.streamId;
                let se = this.streams.get(streamId);

                const circId = event.circId;

                if (!se) {
                    se = {
                        id: streamId,
                        target: event.target,
                        status: event.status,
                        circId: circId
                    };
                    this.streams.set(streamId, se);
                } else {
                    if (se.status !== event.status) {
                        se.status = event.status;
                    }
                    if (se.circId !== circId) {
                        se.circId = circId;
                        if (circId !== 0) {
                            const circ = this.circuits.get(circId);
                            if (circ && circ.country) {
                                console.log(`Stream [${streamId}] === (${event.target}) --> ${flagEmoji(circ.country!)}`);
                            }
                        }
                    }
                    if (se.target !== event.target) {
                        se.target = event.target;
                    }
                }

                if (se.status === 'CLOSED') {
                    this.streams.delete(streamId);
                }

                await attachStreamIfNeeded(event);
            };
            await this.control.addEventListener(streamEventListener, EventType.STREAM);

            const circEventListener = async (event: CircEvent) => {
                const circId = event.circId;
                let ce = this.circuits.get(circId);

                if (!ce) {
                    ce = {
                        id: circId,
                        status: event.status,
                        path: event.path
                    }
                    this.circuits.set(circId, ce!);
                } else {
                    if (ce.status !== event.status) {
                        ce.status = event.status;
                        if (ce.status === 'BUILT') {
                            const relay = await this.control.getRelayInfo(ce.path![ce.path!.length - 1].fingerprint);
                            ce.country = await this.control.getCountry(relay.ip);
                        }
                    }
                    if (event.path.length !== ce.path?.length) {
                        ce.path = event.path;
                    }
                }

                if (ce.status === 'CLOSED' || ce.status === 'FAILED') {
                    this.circuits.delete(circId);
                    if (ce.status === 'FAILED') {
                        console.log("Circuit failure details:", event.reason, event.remoteReason);
                    }
                }
            };
            await this.control.addEventListener(circEventListener, EventType.CIRC);

            // keep process alive
            console.log('Anon state manager is active. Press Ctrl+C to quit.');
            await new Promise<void>((resolve) => {
                this._exitPromiseResolver = resolve;
            });
        } catch (error) {
            console.error('Error:', error);
            await this.shutdown();
        }
    }

    private _exitPromiseResolver?: () => void;

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        console.log('Shutting down Anon SDK process...');

        try {
            if (this.control) await this.control.end();
            console.log('Anon SDK process shut down');
        } catch (e) {
            console.warn('Control shutdown error:', e);
        }

        try {
            await this.anon.stop();
            console.log('Anon stopped');
        } catch (e) {
            console.warn('Anon shutdown error:', e);
        }

        if (this._exitPromiseResolver) this._exitPromiseResolver();
    }

}

async function main() {
    new StateManager().run();
    console.log('Anon SDK process started');

    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled Rejection:', reason);
        process.exit(1);
    });
}

function flagEmoji(code: string): string {
    const cc = code.toUpperCase();
    return String.fromCodePoint(
        ...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
    );
}

main();