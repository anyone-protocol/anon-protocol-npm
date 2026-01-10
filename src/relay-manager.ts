import { Flag, RelayInfo } from './models';
import { AsyncQueue } from './queue';
import { CountryCacheManager } from './country-cache';
import { Buffer } from 'buffer';

// Types for pending request correlation
type PendingRequest<T> = {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
};

/**
 * Manages relay information, country lookups, and filtering
 */
export class RelayManager {
    private countryCache: CountryCacheManager | null = null;
    private countryCacheInitPromise: Promise<void> | null = null;

    // Correlation-based pending request maps
    private pendingCountryRequests = new Map<string, PendingRequest<string>>();
    private pendingNsRequests = new Map<string, PendingRequest<string>>();

    private defaultQueue: AsyncQueue<string>;
    private msgAsync: (message: string) => Promise<void>;
    private requestTimeout = 10000;

    constructor(
        defaultQueue: AsyncQueue<string>,
        msgAsync: (message: string) => Promise<void>
    ) {
        this.defaultQueue = defaultQueue;
        this.msgAsync = msgAsync;
    }

    /**
     * Get pending country requests map (for msgLoop routing)
     */
    getPendingCountryRequests(): Map<string, PendingRequest<string>> {
        return this.pendingCountryRequests;
    }

    /**
     * Get pending ns requests map (for msgLoop routing)
     */
    getPendingNsRequests(): Map<string, PendingRequest<string>> {
        return this.pendingNsRequests;
    }

    /**
     * Get all relays from the network
     */
    async getRelays(): Promise<RelayInfo[]> {
        await this.msgAsync('GETINFO ns/all');

        const response = await this.defaultQueue.pop();

        if (!response.startsWith('250+ns/all=')) {
            throw new Error('Invalid response format: ' + response);
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

    /**
     * Get detailed information about a specific relay
     */
    async getRelayInfo(fingerprint: string, timeoutMs: number = 10000): Promise<RelayInfo> {
        const normalizedFp = fingerprint.toUpperCase();

        const existingPending = this.pendingNsRequests.get(normalizedFp);
        if (existingPending) {
            return new Promise<RelayInfo>((resolve, reject) => {
                const originalResolve = existingPending.resolve;
                const originalReject = existingPending.reject;
                existingPending.resolve = (value: string) => {
                    originalResolve(value);
                    resolve(this.parseRelayInfoResponse(value, normalizedFp));
                };
                existingPending.reject = (err: Error) => {
                    originalReject(err);
                    reject(err);
                };
            });
        }

        const response = await new Promise<string>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingNsRequests.delete(normalizedFp);
                reject(new Error(`getRelayInfo timeout for ${normalizedFp} after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingNsRequests.set(normalizedFp, { resolve, reject, timeoutId });

            this.msgAsync(`GETINFO ns/id/$${normalizedFp}`);
        });

        return this.parseRelayInfoResponse(response, normalizedFp);
    }

    /**
     * Ensure country cache is initialized (handles concurrent calls safely)
     */
    private async ensureCountryCacheInitialized(): Promise<void> {
        // Always wait for init promise if it exists (ensures initialize() completes)
        if (this.countryCacheInitPromise) {
            await this.countryCacheInitPromise;
            return;
        }

        // Create and store the promise BEFORE any async work
        this.countryCacheInitPromise = (async () => {
            const cache = new CountryCacheManager();
            await cache.initialize();
            this.countryCache = cache;  // Only set after fully initialized
        })();

        await this.countryCacheInitPromise;
    }

    /**
     * Get country code for an IP address
     */
    async getCountry(address: string, timeoutMs: number = 10000): Promise<string> {
        await this.ensureCountryCacheInitialized();

        const cached = this.countryCache!.get(address);
        if (cached) {
            return cached;
        }

        const existingPending = this.pendingCountryRequests.get(address);
        if (existingPending) {
            return new Promise<string>((resolve, reject) => {
                const originalResolve = existingPending.resolve;
                const originalReject = existingPending.reject;
                existingPending.resolve = (value: string) => {
                    originalResolve(value);
                    resolve(this.parseCountryResponse(value));
                };
                existingPending.reject = (err: Error) => {
                    originalReject(err);
                    reject(err);
                };
            });
        }

        const response = await new Promise<string>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingCountryRequests.delete(address);
                reject(new Error(`getCountry timeout for ${address} after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingCountryRequests.set(address, { resolve, reject, timeoutId });

            this.msgAsync(`GETINFO ip-to-country/${address}`);
        });

        const country = this.parseCountryResponse(response);

        this.countryCache!.set(address, country);
        await this.countryCache!.saveCache();

        return country;
    }

    /**
     * Populate country information for relays
     */
    async populateCountries(relays: RelayInfo[]): Promise<void> {
        await this.ensureCountryCacheInitialized();

        // First pass: populate from cache
        for (const relay of relays) {
            if (relay.country) {
                continue;
            }

            const cached = this.countryCache!.get(relay.ip);
            if (cached) {
                relay.country = cached;
            }
        }

        // Second pass: queue uncached IPs for background resolution
        const uncachedIps = relays
            .filter(relay => !relay.country)
            .map(relay => relay.ip);

        if (uncachedIps.length > 0) {
            console.log(`Queueing ${uncachedIps.length} IPs for background country resolution`);

            const resolver = async (ip: string) => {
                return await this.getCountry(ip);
            };

            this.countryCache!.populateInBackground(uncachedIps, resolver);
        }
    }

    /**
     * Find first N relays matching specified countries
     */
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

    /**
     * Get all relays from specified countries
     */
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

    /**
     * Filter relays by country
     */
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

    /**
     * Filter relays by flags
     */
    filterRelaysByFlags(relays: RelayInfo[], ...flags: Flag[]): RelayInfo[] {
        return relays.filter(relay => {
            return flags.every(flag => relay.flags.includes(flag));
        });
    }

    private parseRelayInfoResponse(response: string, fingerprint: string): RelayInfo {
        if (!response.startsWith('250+ns/id/')) {
            throw new Error(`Failed to get relay info: ${response}`);
        }

        const lines = response.split('\n').map(line => line.trim());

        let flags: Flag[] = [];
        let ip: string = '';
        let orPort: number = 0;
        let bandwidth: number = 0;
        let nickname: string = '';

        for (const line of lines) {
            if (line.startsWith('s ')) {
                flags = line.substring(2).trim().split(' ').map(flag => Flag[flag as keyof typeof Flag]);
            }

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

    private parseCountryResponse(response: string): string {
        if (!response.startsWith('250-ip-to-country/')) {
            throw new Error('Invalid response format: ' + response);
        }

        const cleanedResponse = response
            .replace(/^250-ip-to-country\//, '')
            .replace(/250 OK$/, '')
            .trim();

        const parts = cleanedResponse.split('=');
        if (parts.length < 2) {
            throw new Error('Invalid response format: ' + response);
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