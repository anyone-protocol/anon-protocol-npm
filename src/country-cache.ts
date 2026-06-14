import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface CountryCache {
    [ip: string]: {
        country: string;
        timestamp: number;
    };
}

export class CountryCacheManager {
    private readonly cacheFilePath: string;
    private cache: CountryCache = {};
    private cacheTTL: number = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
    private pendingResolves: Map<string, Promise<string | undefined>> = new Map();
    private resolveQueue: string[] = [];
    private isResolving = false;
    private isPaused = true; // Start paused by default - caller must resume
    private isStopped = false;
    private resolveInterval = 5000; // 5 seconds between requests

    constructor(cacheFileName: string = 'ip-country-cache.json') {
        const cacheDir = path.join(os.homedir(), '.anon-cache');
        this.cacheFilePath = path.join(cacheDir, cacheFileName);
    }

    async initialize(): Promise<void> {
        await this.ensureCacheDir();
        await this.loadCache();
    }

    private async ensureCacheDir(): Promise<void> {
        const cacheDir = path.dirname(this.cacheFilePath);
        try {
            await fs.mkdir(cacheDir, { recursive: true });
        } catch (error) {
            // Directory might already exist, ignore
        }
    }

    private async loadCache(): Promise<void> {
        console.log(`Loading cache from: ${this.cacheFilePath}`);
        try {
            const data = await fs.readFile(this.cacheFilePath, 'utf-8');
            console.log(`Raw cache file size: ${data.length} bytes`);
            const loadedCache = JSON.parse(data) as CountryCache;
            const totalLoaded = Object.keys(loadedCache).length;
            console.log(`Parsed ${totalLoaded} entries from cache file`);

            // Filter out expired entries
            const now = Date.now();
            for (const [ip, entry] of Object.entries(loadedCache)) {
                if (now - entry.timestamp < this.cacheTTL) {
                    this.cache[ip] = entry;
                }
            }

            console.log(`Loaded ${Object.keys(this.cache).length}/${totalLoaded} cached IP-to-country mappings (${totalLoaded - Object.keys(this.cache).length} expired)`);
        } catch (error) {
            // Cache file doesn't exist or is corrupted, start fresh
            console.log(`No existing cache found at ${this.cacheFilePath}, starting fresh:`, error instanceof Error ? error.message : error);
            this.cache = {};
        }
    }

    async saveCache(): Promise<void> {
        try {
            await fs.writeFile(
                this.cacheFilePath,
                JSON.stringify(this.cache, null, 2),
                'utf-8'
            );
        } catch (error) {
            console.warn(`Failed to save country cache to ${this.cacheFilePath}:`, error);
        }
    }

    get(ip: string): string | undefined {
        const entry = this.cache[ip];
        if (!entry) return undefined;

        // Check if entry is still valid
        const now = Date.now();
        if (now - entry.timestamp > this.cacheTTL) {
            delete this.cache[ip];
            return undefined;
        }

        return entry.country;
    }

    set(ip: string, country: string): void {
        this.cache[ip] = {
            country,
            timestamp: Date.now()
        };
    }

    /**
     * Queue an IP for background resolution
     * Returns a promise that resolves when the IP's country is determined
     */
    queueResolve(ip: string, resolver: (ip: string) => Promise<string>): Promise<string | undefined> {
        // Check cache first
        const cached = this.get(ip);
        if (cached) {
            return Promise.resolve(cached);
        }

        // Check if already pending
        const pending = this.pendingResolves.get(ip);
        if (pending) {
            return pending;
        }

        // Create new pending promise
        const promise = new Promise<string | undefined>((resolve) => {
            // Add to queue
            if (!this.resolveQueue.includes(ip)) {
                this.resolveQueue.push(ip);
            }

            // Start processing if not already running
            if (!this.isResolving) {
                this.startBackgroundResolve(resolver);
            }

            // Check periodically if resolved
            const checkInterval = setInterval(() => {
                const country = this.get(ip);
                if (country) {
                    clearInterval(checkInterval);
                    resolve(country);
                }
            }, 1000);

            // Timeout after 5 minutes
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve(undefined);
            }, 300000);
        });

        this.pendingResolves.set(ip, promise);
        return promise;
    }

    /**
     * Pause background resolution (use before operations that need exclusive control port access)
     */
    pause(): void {
        this.isPaused = true;
    }

    /**
     * Resume background resolution
     */
    resume(): void {
        this.isPaused = false;
    }

    /**
     * Stop background resolution completely (use on shutdown)
     */
    stop(): void {
        this.isStopped = true;
        this.isPaused = false; // Unpause so the loop can exit
        this.resolveQueue = []; // Clear queue
        this.pendingResolves.clear();
    }

    private async startBackgroundResolve(resolver: (ip: string) => Promise<string>): Promise<void> {
        if (this.isResolving) return;
        this.isResolving = true;

        console.log(`Starting background country resolution for ${this.resolveQueue.length} IPs (rate: 1 per ${this.resolveInterval}ms)`);

        while (this.resolveQueue.length > 0 && !this.isStopped) {
            // Wait while paused (but exit if stopped)
            while (this.isPaused && !this.isStopped) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (this.isStopped) break;

            const ip = this.resolveQueue.shift()!

            try {
                const country = await resolver(ip);
                this.set(ip, country);
                await this.saveCache();
            } catch {
                // Skip failed resolutions silently, will retry on next pass
            }

            // Rate limit: wait before next request
            if (this.resolveQueue.length > 0 && !this.isStopped) {
                await new Promise(resolve => setTimeout(resolve, this.resolveInterval));
            }
        }

        if (!this.isStopped) {
            console.log('Background country resolution complete');
        }
        this.isResolving = false;
        this.pendingResolves.clear();
    }

    /**
     * Populate countries for relays in background
     * Returns immediately, resolution happens in background
     */
    populateInBackground(
        ips: string[],
        resolver: (ip: string) => Promise<string>
    ): void {
        const uncached = ips.filter(ip => !this.get(ip));

        if (uncached.length === 0) {
            console.log('All IPs already cached');
            return;
        }

        console.log(`Queueing ${uncached.length} IPs for background resolution`);

        // Add to queue
        for (const ip of uncached) {
            if (!this.resolveQueue.includes(ip)) {
                this.resolveQueue.push(ip);
            }
        }

        // Start processing if not already running
        if (!this.isResolving) {
            this.startBackgroundResolve(resolver);
        }
    }

    getStats(): { total: number; cached: number; pending: number } {
        return {
            total: Object.keys(this.cache).length,
            cached: Object.keys(this.cache).length,
            pending: this.resolveQueue.length
        };
    }
}