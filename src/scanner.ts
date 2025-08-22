
import * as fs from 'fs';
import * as path from 'path';
import { AircraftAnalyzer } from './aircraft-analyzer';
import { CENTRAL_MED_BOUNDS } from './config';
import { logger } from './logger';
import { TelegramNotifier } from './notifications/telegram-notifier';
import { ScannerProvider } from './providers/base-provider';
import { getLoiteringStorage } from './storage/loitering-storage';
import { Aircraft, LoiteringEvent } from './types';

const STORAGE_DIR = path.join(process.cwd(), 'storage');
const AIRCRAFT_FILE = path.join(STORAGE_DIR, 'aircraft-states.json');

function ensureStorageDir() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function atomicWriteFileSync(filePath: string, data: string) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
}

export class AircraftScanner {
    private aircraft: Map<string, Aircraft> = new Map();
    private analyzer: AircraftAnalyzer;
    private updateIntervalMs = 15000; // 10 seconds default update interval
    private loiteringStorage = getLoiteringStorage();

    /** The maximum inactivity time for an aircraft; if an aircraft is inactive for more than this time, it will be considered inactive and removed from the map */
    private readonly INACTIVITY_THRESHOLD_MS = 20 * 60 * 1000;

    /** The maximum time to keep track of an aircraft; data points older than this time will be removed from the track */
    private readonly TRACK_RETENTION_MS = 30 * 60 * 1000;

    /** The maximum inactivity time for a single event; if an event is inactive for more than this time, it will be considered a new event */
    private readonly SINGLE_EVENT_INACTIVITY_MS = 10 * 60 * 1000;

    private running = false;
    private telegramNotifier: TelegramNotifier;

    constructor(private provider: ScannerProvider) {
        this.analyzer = new AircraftAnalyzer();
        this.telegramNotifier = TelegramNotifier.getInstance();
        ensureStorageDir();
        this.loadAircraftFromDisk();
    }

    private saveAircraftToDisk() {
        try {
            ensureStorageDir();
            const arr = Array.from(this.aircraft.values());
            atomicWriteFileSync(AIRCRAFT_FILE, JSON.stringify(arr, null, 2));
        } catch (err) {
            logger.error({ err }, 'Failed to save aircraft states to disk');
        }
    }

    private loadAircraftFromDisk() {
        try {
            if (fs.existsSync(AIRCRAFT_FILE)) {
                const data = fs.readFileSync(AIRCRAFT_FILE, 'utf-8');
                const arr: Aircraft[] = JSON.parse(data);
                // Ensure all aircraft have the info field
                const processedArr = arr.map(ac => ({
                    ...ac,
                    info: ac.info || 'Aircraft information not available'
                }));
                this.aircraft = new Map(processedArr.map(ac => [ac.icao, ac]));
                logger.info(`Loaded ${arr.length} aircraft states from disk.`);
            }
        } catch (err) {
            logger.error({ err }, 'Failed to load aircraft states from disk');
        }
    }

    async start(): Promise<void> {
        if (this.running) {
            logger.warn('Scanner is already running');
            return;
        }
        this.running = true;
        logger.info(`Scanner started with ${this.loiteringStorage.getEventCount()} existing loitering events`);
        while (this.running) {
            try {
                await this.scan();
                this.cleanupInactiveAircraft();
            } catch (error) {
                logger.error('Error in scanner:', error);
                if (!String(error).includes('429')) {
                    this.telegramNotifier.sendNotification({
                        markdown: `🚨 **Scanner error:**\n\n${error}`
                    });
                }
            } finally {
                await new Promise(resolve => setTimeout(resolve, this.updateIntervalMs));
            }
        }
    }

    stop(): void {
        this.running = false;
    }

    private cleanupInactiveAircraft(): void {
        const now = Date.now();
        const inactiveThreshold = now - this.INACTIVITY_THRESHOLD_MS;
        let removed = false;
        for (const [icao, aircraft] of this.aircraft.entries()) {
            const latest = aircraft.track[0]?.timestamp ? aircraft.track[0].timestamp * 1000 : 0;
            if (latest < inactiveThreshold) {
                this.aircraft.delete(icao);
                removed = true;
                // Note: Loitering events are preserved for 7 days regardless of aircraft activity
            }
        }
        if (removed) this.saveAircraftToDisk();
    }

    private async scan(): Promise<void> {
        const result = await this.provider.scan(CENTRAL_MED_BOUNDS);

        // Update aircraft data and check for interesting patterns
        result.aircraft.forEach(scanAc => {
            // Convert ScanAircraft to Aircraft (single-point track, default fields)
            const aircraft: Aircraft = {
                icao: scanAc.icao,
                info: scanAc.info,
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
                    verticalRate: scanAc.verticalRate,
                    distanceToCoast: scanAc.distanceToCoast
                }]
            };
            this.updateAircraft(aircraft);
        });

    }

    public updateAircraft(aircraft: Aircraft): void {
        let tracked = this.aircraft.get(aircraft.icao);
        if (!tracked) {
            // New aircraft, add to map
            this.aircraft.set(aircraft.icao, aircraft);
            this.saveAircraftToDisk();
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
                this.cleanupOldTrackPoints(tracked);
                this.saveAircraftToDisk();
            }
            tracked.callsign = aircraft.callsign;
            tracked.info = aircraft.info;
        }

        // Analyze aircraft with the analyzer
        const analysis = this.analyzer.analyzeAircraft(tracked);
        tracked.is_monitored = analysis.is_monitored;
        tracked.not_monitored_reason = analysis.not_monitored_reason;
        tracked.is_loitering = analysis.is_loitering;

        // If loitering is detected (new or continued)
        if (tracked.is_loitering) {
            this.handleLoiteringDetection(tracked);
        }
    }

    private cleanupOldTrackPoints(aircraft: Aircraft): void {
        const now = Date.now();
        const cutoffTime = now - this.TRACK_RETENTION_MS;

        // Remove track points older than 20 minutes
        aircraft.track = aircraft.track.filter(point => {
            const pointTime = point.timestamp * 1000; // Convert to milliseconds
            return pointTime > cutoffTime;
        });
    }

    public getAircraft(): Aircraft[] {
        return Array.from(this.aircraft.values());
    }

    private async handleLoiteringDetection(aircraft: Aircraft): Promise<void> {
        // Check if we already have an event for this aircraft
        let event = this.loiteringStorage.getLatestEventByIcao(aircraft.icao);
        const now = Date.now();
        const isNewEvent = !event;


        // Get all intersections for this aircraft
        const intersections = AircraftAnalyzer.getIntersections(aircraft);
        if (intersections.length === 0) {
            // No intersections, do not create/update event
            return;
        }

        const latestPosition = aircraft.track[0];
        if (!latestPosition) return;

        if (event && event.lastUpdated > now - this.SINGLE_EVENT_INACTIVITY_MS) {
            // Update existing event
            event.lastUpdated = now;
            event.intersectionPoints = intersections;
            // Add new track points to the event track, but keep the oldest points (new points are at the beginning of the array)
            event.track = [...aircraft.track].concat(event.track.filter(point => !aircraft.track.some(p => p.timestamp === point.timestamp)));
            // Update aircraft state with latest position
            event.aircraftState = {
                altitude: latestPosition.altitude,
                speed: latestPosition.speed,
                heading: latestPosition.heading,
                verticalRate: latestPosition.verticalRate,
                info: aircraft.info,
                position: {
                    latitude: latestPosition.latitude,
                    longitude: latestPosition.longitude
                }
            };
            logger.debug(`Updated loitering event for ${aircraft.icao} with ${event.track.length} track points (windowed)`);
        } else {
            // Create new event
            event = {
                id: Math.random().toString(36).substring(2, 15),
                icao: aircraft.icao,
                callsign: aircraft.callsign,
                firstDetected: now,
                lastUpdated: now,
                intersectionPoints: intersections,
                aircraftState: {
                    altitude: latestPosition.altitude,
                    speed: latestPosition.speed,
                    info: aircraft.info,
                    heading: latestPosition.heading,
                    verticalRate: latestPosition.verticalRate,
                    position: {
                        latitude: latestPosition.latitude,
                        longitude: latestPosition.longitude
                    }
                },
                track: [...aircraft.track]
            };
            logger.debug(`Created new loitering event for ${aircraft.icao} with ${event.track.length} track points (windowed)`);
        }

        // Store the event in memory
        this.loiteringStorage.saveEvent(event);

        // Send Telegram notification for new events
        if (isNewEvent) {
            logger.info(`🚨 New loitering event detected: ${aircraft.icao} (${event.track.length} track points)`);
            try {
                await this.telegramNotifier.sendNotification({
                    markdown: `🚨 **Loitering aircraft detected: ${aircraft.icao}**\n\nPlease click  here to see the event details:\nhttps://medplane.gufoe.it/loitering/${event.id}`
                });
            } catch (error) {
                logger.error('Failed to send Telegram notification:', error);
            }
        }
    }

    public getLoiteringEvents(): LoiteringEvent[] {
        return this.loiteringStorage.listEvents();
    }

    public getLoiteringEvent(id: string): LoiteringEvent | undefined {
        return this.loiteringStorage.getEvent(id);
    }
}
