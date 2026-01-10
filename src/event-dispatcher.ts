import { AsyncEvent, AsyncQueue } from './queue';
import { Event, EventType } from './models';
import { ProtocolParser } from './protocol-parser';
import * as net from 'net';

/**
 * Manages event listeners and dispatches events to registered callbacks
 */
export class EventDispatcher {
    private eventListeners: Map<EventType, Function[]> = new Map();
    private eventQueue: AsyncQueue<string>;
    private eventNotice: AsyncEvent;
    private parser: ProtocolParser;
    private client: net.Socket;
    private isAuthenticated: () => boolean;
    private setEvents: (events: EventType[]) => Promise<boolean>;
    private eventLoopTask: Promise<void> | null = null;

    constructor(
        client: net.Socket,
        eventQueue: AsyncQueue<string>,
        eventNotice: AsyncEvent,
        parser: ProtocolParser,
        isAuthenticated: () => boolean,
        setEvents: (events: EventType[]) => Promise<boolean>
    ) {
        this.client = client;
        this.eventQueue = eventQueue;
        this.eventNotice = eventNotice;
        this.parser = parser;
        this.isAuthenticated = isAuthenticated;
        this.setEvents = setEvents;
    }

    /**
     * Start the event loop
     */
    startEventLoop(): void {
        if (!this.eventLoopTask) {
            this.eventLoopTask = this.eventLoop();
        }
    }

    /**
     * Add an event listener for specified event types
     */
    async addEventListener(callback: Function, ...eventTypes: EventType[]): Promise<void> {
        for (const eventType of eventTypes) {
            const callbacks: Function[] = this.eventListeners.get(eventType) || [];
            callbacks.push(callback);
            this.eventListeners.set(eventType, callbacks);
        }

        await this.attachEventListenersOrFail();
    }

    /**
     * Remove an event listener
     */
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
     * Get all registered event types
     */
    getRegisteredEventTypes(): EventType[] {
        return Array.from(this.eventListeners.keys());
    }

    /**
     * Check if there are any listeners registered
     */
    hasListeners(): boolean {
        return this.eventListeners.size > 0;
    }

    private async attachListeners(): Promise<[EventType[], EventType[]]> {
        const setEventsResult: EventType[] = [];
        const failedEvents: EventType[] = [];

        if (!this.isAuthenticated() || !this.client || this.client.destroyed) {
            return [setEventsResult, failedEvents];
        }

        const eventTypes = Array.from(this.eventListeners?.keys() || []);

        try {
            let isOk = await this.setEvents(eventTypes);
            if (isOk) {
                setEventsResult.push(...eventTypes);
            } else {
                for (const eventType of eventTypes) {
                    isOk = await this.setEvents([eventType]);
                    if (isOk) {
                        setEventsResult.push(eventType);
                    } else {
                        failedEvents.push(eventType);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to attach listeners:', err);
            failedEvents.push(...eventTypes);
        }

        return [setEventsResult, failedEvents];
    }

    private async attachEventListenersOrFail(): Promise<void> {
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

    private async handleEvent(eventMessage: string): Promise<void> {
        const event: Event = this.parser.convertToEvent(eventMessage);
        const eventType = event.type;

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
}