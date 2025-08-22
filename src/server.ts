import express from 'express';
import path from 'path';
import { MONITORING_THRESHOLDS, CENTRAL_MED_BOUNDS, CENTRAL_MED_POLYGON } from './config';
import { AircraftScanner } from './scanner';
import { logger } from './logger';

export class WebServer {
    private app: express.Application;
    private scanner: AircraftScanner | null = null;

    constructor() {
        this.app = express();
        this.setupRoutes();
    }

    public setScanner(scanner: AircraftScanner) {
        this.scanner = scanner;
    }

    private setupRoutes(): void {
        // Serve static files
        this.app.use(express.static(path.join(process.cwd(), 'public')));

        // API endpoints
        this.app.get('/api/aircraft', (_, res) => {
            if (!this.scanner) {
                res.status(500).json({ error: 'Scanner not initialized' });
                return;
            }
            res.json({
                aircraft: this.scanner.getAircraft(),
                monitoringArea: {
                    bounds: CENTRAL_MED_BOUNDS,
                    polygon: CENTRAL_MED_POLYGON
                }
            });
        });

        this.app.get('/api/loitering', (_, res) => {
            if (!this.scanner) {
                res.status(500).json({ error: 'Scanner not initialized' });
                return;
            }
            const events = this.scanner.getLoiteringEvents();
            // Sort events by lastUpdated timestamp in descending order
            const sortedEvents = events.sort((a, b) => b.lastUpdated - a.lastUpdated);
            res.json(sortedEvents);
        });

        this.app.get('/api/loitering/:id', (req, res) => {
            if (!this.scanner) {
                res.status(500).json({ error: 'Scanner not initialized' });
                return;
            }
            const event = this.scanner.getLoiteringEvent(req.params.id);
            if (event) {
                res.json(event);
            } else {
                res.status(404).json({ error: 'Event not found' });
            }
        });

        // Serve the main page
        this.app.get('/', (_, res) => {
            res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
        });

        // Serve the loitering event view page
        this.app.get('/loitering/:id', (_, res) => {
            res.sendFile(path.join(process.cwd(), 'public', 'loitering.html'));
        });

        // Serve the events list page
        this.app.get('/events', (_, res) => {
            res.sendFile(path.join(process.cwd(), 'public', 'events.html'));
        });

        // API endpoint for map configuration
        this.app.get('/api/map', (_, res) => {
            res.json({
                monitoringArea: {
                    bounds: CENTRAL_MED_BOUNDS,
                    polygon: CENTRAL_MED_POLYGON
                },
                thresholds: MONITORING_THRESHOLDS
            });
        });
    }

    public start(port: number) {
        this.app.listen(port, () => {
            logger.info(`Server running at http://localhost:${port}`);
        });
    }
}
