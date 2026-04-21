import * as net from 'net';
import { AsyncEvent, AsyncQueue } from './queue';
import { AddrMapEvent, CircEvent, CircHop, CircStatus, Event, EventType, StreamEvent } from './models';

// Constants
export const CRLF = '\r\n' as const;
const STATUS_LINE_RE = /^(\d{3})[ +\-](.*)$/;

// Helper functions
export function isOkCode(n: number): boolean {
    return n >= 200 && n < 300;
}

export function parseFirstStatusCode(raw: string): { code: number; text: string } {
    const line = raw.split(CRLF)[0] ?? '';
    const m = STATUS_LINE_RE.exec(line);
    if (!m) return { code: NaN, text: line };
    return { code: Number(m[1]), text: m[2] ?? '' };
}

function splitSmart(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"') {
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

function partitionKv(tokens: string[]): { positional: string[]; kv: Record<string, string> } {
    const positional: string[] = [];
    const kv: Record<string, string> = {};
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

/**
 * Handles parsing of Tor control protocol messages
 */
export class ProtocolParser {
    private eventQueue: AsyncQueue<string>;
    private eventNotice: AsyncEvent;

    constructor(eventQueue: AsyncQueue<string>, eventNotice: AsyncEvent) {
        this.eventQueue = eventQueue;
        this.eventNotice = eventNotice;
    }

    /**
     * Reads a single complete Tor reply from the control socket.
     * - Handles 250/552 with -, +, and dot-terminated blocks
     * - Routes async events (650 / 650- / 650+ ... '.') to eventQueue
     */
    readReply(client: net.Socket, timeoutMs: number = 10000): Promise<string> {
        return new Promise((resolve, reject) => {
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

            const tidy = () => {
                client.off('data', onData);
                client.off('error', onError);
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

            const onData = (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\r\n');
                buffer = lines.pop() || '';

                for (const raw of lines) {
                    const line = raw;

                    // Handle asynchronous events
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

                    // Handle event data blocks (650+)
                    if (inEventDataBlock) {
                        if (line === '.') {
                            inEventDataBlock = false;
                            pushEventNow();
                        } else {
                            eventLines.push(line.startsWith('..') ? line.slice(1) : line);
                        }
                        continue;
                    }

                    // Handle event continuations (650-)
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

                        pushEventNow();
                    }

                    // First reply status line
                    if (!replyStatus) {
                        const m = line.match(/^(\d{3})([ +\-])(.*)$/);
                        if (!m) continue;
                        replyStatus = m[1];
                        replyDivider = m[2] as ' ' | '+' | '-';
                    }

                    // Collect reply lines
                    if (inReplyDataBlock && line.startsWith('..')) {
                        replyLines.push(line.slice(1));
                    } else {
                        replyLines.push(line);
                    }

                    // Terminal reply
                    if (line.startsWith(replyStatus + ' ')) {
                        tidy();
                        return resolve(replyLines.join('\r\n'));
                    }

                    // Manage block/continuation
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
                            break;
                        default:
                            tidy();
                            return reject(new Error(`Unknown reply divider '${replyDivider}' in line: ${line}`));
                    }
                }
            };

            client.on('data', onData);
            client.once('error', onError);
        });
    }

    /**
     * Convert raw event message to typed Event object
     */
    convertToEvent(eventMessage: string): Event {
        const lines = eventMessage.split(CRLF);
        const header = lines[0] ?? '';
        const extraLines = lines.slice(1);

        const headerTokens = splitSmart(header);
        const eventName = headerTokens[0] ?? '';
        const allTokens = collectTokensFromLines([headerTokens.slice(1).join(' '), ...extraLines]);
        const { positional, kv } = partitionKv(allTokens);

        const payload = extraLines.length ? extraLines.join(CRLF) : undefined;
        const eventType = (EventType as any)[eventName] as EventType | undefined;

        switch (eventType) {
            case EventType.STREAM: {
                const [streamIdStr, status, circIdStr, target, ...restPos] = positional;
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
                    kv,
                    payload,
                    data: lines.join(" ")
                } as StreamEvent;
            }

            case EventType.ADDRMAP: {
                const [address, mappedAddress, expires] = positional;
                return {
                    type: EventType.ADDRMAP,
                    address,
                    mappedAddress,
                    expires: expires ? new Date(expires) : undefined,
                    streamId: kv['STREAMID'] ? toInt(kv['STREAMID']!) ?? undefined : undefined,
                    cached: kv['CACHED'] ? kv['CACHED'] === 'YES' : undefined,
                    kv,
                    payload,
                    data: lines.join(" ")
                } as AddrMapEvent;
            }

            case EventType.CIRC: {
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
                    data: lines.join(" ")
                } as CircEvent;
            }

            default: {
                return {
                    type: eventType ?? (eventName as any),
                    args: positional,
                    kv,
                    payload,
                    raw: eventMessage,
                } as any;
            }
        }
    }
}
