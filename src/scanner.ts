import { EventEmitter } from 'events';
import { AircraftAnalyzer } from './aircraft-analyzer';
import { SICILY_CHANNEL_BOUNDS } from './config';
import { ScannerProvider } from './providers/base-provider';
import { Aircraft, ExtendedPosition, LoiteringEvent } from './types';
import { getLoiteringStorage } from './storage/loitering-storage';

export class AircraftScanner extends EventEmitter {
    private aircraft: Map<string, Aircraft> = new Map();
    private analyzer: AircraftAnalyzer;
    private updateIntervalMs = 10000; // 10 seconds default update interval
    private loiteringStorage = getLoiteringStorage();
    private readonly INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes of inactivity
    private running = false;

    constructor(private provider: ScannerProvider) {
        super();
        this.analyzer = new AircraftAnalyzer();
    }

    async start(): Promise<void> {
        if (this.running) {
            console.warn('Scanner is already running');
            return;
        }
        this.running = true;
        while (this.running) {
            await this.scan();
            this.cleanupInactiveAircraft();
            await new Promise(resolve => setTimeout(resolve, this.updateIntervalMs));
        }
    }

    stop(): void {
        this.running = false;
    }

    private cleanupInactiveAircraft(): void {
        const now = Date.now();
        const inactiveThreshold = now - this.INACTIVITY_THRESHOLD_MS;
        for (const [icao, aircraft] of this.aircraft.entries()) {
            const latest = aircraft.track[0]?.timestamp ? aircraft.track[0].timestamp * 1000 : 0;
            if (latest < inactiveThreshold) {
                console.log(`Removing inactive aircraft ${icao} (last update: ${new Date(latest).toISOString()})`);
                this.aircraft.delete(icao);
                // Also remove any associated loitering events
                const event = this.loiteringStorage.getEventByIcao(icao);
                if (event) {
                    console.log(`Removing loitering event for inactive aircraft ${icao}`);
                    this.loiteringStorage.deleteEvent(event.id);
                }
            }
        }
    }

    private async scan(): Promise<void> {
        try {
            const result = await this.provider.scan(SICILY_CHANNEL_BOUNDS);

            // DEBUG: log raw response
            console.log('Aircraft found:', result.aircraft.length, result.aircraft.slice(0, 3));

            // Update aircraft data and check for interesting patterns
            result.aircraft.forEach(scanAc => {
                // Convert ScanAircraft to Aircraft (single-point track, default fields)
                const aircraft: Aircraft = {
                    icao: scanAc.icao,
                    callsign: scanAc.callsign,
                    is_monitored: false,
                    is_loitering: false,
                    not_monitored_reason: null,
                    track: [{
                        latitude: scanAc.latitude,
                        longitude: scanAc.longitude,
                        timestamp: scanAc.timestamp,
                        altitude: scanAc.altitude,
                        speed: scanAc.speed,
                        heading: scanAc.heading,
                        verticalRate: scanAc.verticalRate
                    }]
                };
                this.updateAircraft(aircraft);
            });

            this.emit('scan', result.aircraft);
        } catch (error) {
            console.error('Error scanning aircraft:', error);
            this.emit('error', error);
        }
    }

    public updateAircraft(aircraft: Aircraft): void {
        let tracked = this.aircraft.get(aircraft.icao);
        if (!tracked) {
            // New aircraft, add to map
            this.aircraft.set(aircraft.icao, aircraft);
            tracked = aircraft;
        } else {
            // Existing: update track (prepend new point if different)
            const latest = aircraft.track[0];
            const prev = tracked.track[0];
            if (!prev || !latest ||
                prev.latitude !== latest.latitude ||
                prev.longitude !== latest.longitude ||
                prev.altitude !== latest.altitude ||
                prev.speed !== latest.speed ||
                prev.heading !== latest.heading ||
                prev.verticalRate !== latest.verticalRate) {
                tracked.track.unshift(latest);
                if (tracked.track.length > 50) tracked.track.length = 50;
            }
            tracked.callsign = aircraft.callsign;
        }

        // Analyze aircraft with the analyzer
        const analysis = this.analyzer.analyzeAircraft(tracked);
        tracked.is_monitored = analysis.is_monitored;
        tracked.not_monitored_reason = analysis.not_monitored_reason;
        tracked.is_loitering = analysis.is_loitering;

        // If loitering is detected (new or continued)
        if (tracked.is_loitering) {
            this.handleLoiteringDetection(tracked);
            this.emit('loiteringAircraft', tracked);
        }
    }

    public getAircraft(): Aircraft[] {
        return Array.from(this.aircraft.values());
    }

    private handleLoiteringDetection(aircraft: Aircraft): void {
        // Check if we already have an event for this aircraft
        let event = this.loiteringStorage.getEventByIcao(aircraft.icao);
        const now = Date.now();

        if (event) {
            // Update existing event
            event.lastUpdated = now;
            event.detectionCount += 1;

            // Update aircraft state with latest position
            const latestPosition = aircraft.track[0];
            if (latestPosition) {
                event.aircraftState = {
                    altitude: latestPosition.altitude,
                    speed: latestPosition.speed,
                    heading: latestPosition.heading,
                    verticalRate: latestPosition.verticalRate,
                    position: {
                        latitude: latestPosition.latitude,
                        longitude: latestPosition.longitude
                    }
                };
            }

            // Update track with the latest data
            event.track = [...aircraft.track];
        } else {
            // Create new event
            const latestPosition = aircraft.track[0];
            if (!latestPosition) return;

            event = {
                id: aircraft.icao, // Use ICAO as the ID
                icao: aircraft.icao,
                callsign: aircraft.callsign,
                firstDetected: now,
                lastUpdated: now,
                detectionCount: 1,
                intersectionPoints: [], // We don't need intersection points for basic loitering detection
                aircraftState: {
                    altitude: latestPosition.altitude,
                    speed: latestPosition.speed,
                    heading: latestPosition.heading,
                    verticalRate: latestPosition.verticalRate,
                    position: {
                        latitude: latestPosition.latitude,
                        longitude: latestPosition.longitude
                    }
                },
                track: [...aircraft.track]
            };
        }

        // Store the event in memory
        this.loiteringStorage.saveEvent(event);
        console.log(`Loitering event ${event.id ? 'updated' : 'created'} for aircraft ${aircraft.icao}`);
    }

    public getLoiteringEvents(): LoiteringEvent[] {
        return this.loiteringStorage.listEvents();
    }

    public getLoiteringEvent(icao: string): LoiteringEvent | undefined {
        return this.loiteringStorage.getEventByIcao(icao);
    }
}
