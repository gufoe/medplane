import { MONITORING_THRESHOLDS, CENTRAL_MED_POLYGON, CENTRAL_MED_BOUNDS } from './config';
import { Aircraft, Position, ExtendedPosition } from './types';
import { areIntersecting, GeoUtils } from './utils';

export interface AircraftAnalysisResult {
    is_monitored: boolean;
    not_monitored_reason: string | null;
    is_loitering: boolean;
}

/**
 * AircraftAnalyzer is responsible for analyzing a single aircraft's monitoring and loitering status.
 * It uses only the provided aircraft data (such as track and position) and does not mutate any input objects.
 * All methods are pure and return new values or results, making the class stateless and easy to test.
 */
export class AircraftAnalyzer {

    /**
     * Checks if a position meets all monitoring requirements and returns the result with reason
     * @param position The position to check (must include altitude and speed)
     * @returns Object with is_monitored status and reason
     */
    private static checkMonitoringRequirements(position: ExtendedPosition): { is_monitored: boolean; not_monitored_reason: string | null } {
        const inArea = AircraftAnalyzer.isInGeoBounds(position);
        const inAltitudeRange = AircraftAnalyzer.isInTargetAltitude(position.altitude);
        const inSpeedRange = AircraftAnalyzer.isInTargetSpeed(position.speed);
        const overSea = position.distanceToCoast > MONITORING_THRESHOLDS.coast.minDistance;

        if (!inArea) {
            return {
                is_monitored: false,
                not_monitored_reason: 'Aircraft is outside the Sicily Channel monitoring area.'
            };
        }
        if (!overSea) {
            return {
                is_monitored: false,
                not_monitored_reason: 'Aircraft is over land or too close to coast.'
            };
        }
        if (!inSpeedRange) {
            const speed = position.speed;
            return {
                is_monitored: false,
                not_monitored_reason: speed < MONITORING_THRESHOLDS.speed.min
                    ? `Aircraft speed (${speed.toFixed(1)} knots) is too slow (minimum: ${MONITORING_THRESHOLDS.speed.min} knots).`
                    : `Aircraft speed (${speed.toFixed(1)} knots) is too fast (maximum: ${MONITORING_THRESHOLDS.speed.max} knots).`
            };
        }
        if (!inAltitudeRange) {
            const altitude = position.altitude;
            return {
                is_monitored: false,
                not_monitored_reason: altitude < MONITORING_THRESHOLDS.altitude.min
                    ? `Aircraft altitude (${altitude.toFixed(1)} feet) is too low (minimum: ${MONITORING_THRESHOLDS.altitude.min} feet).`
                    : `Aircraft altitude (${altitude.toFixed(1)} feet) is too high (maximum: ${MONITORING_THRESHOLDS.altitude.max} feet).`
            };
        }

        return {
            is_monitored: true,
            not_monitored_reason: null
        };
    }


    private static isInGeoBounds(position: Position): boolean {
        // Fast bounding box check first
        if (position.latitude < CENTRAL_MED_BOUNDS.minLat ||
            position.latitude > CENTRAL_MED_BOUNDS.maxLat ||
            position.longitude < CENTRAL_MED_BOUNDS.minLon ||
            position.longitude > CENTRAL_MED_BOUNDS.maxLon) {
        return false;
        }
        
        // If inside bounding box, check polygon precisely
        return this.isPointInPolygon(position.latitude, position.longitude);
    }

    private static isPointInPolygon(lat: number, lon: number): boolean {
        let inside = false;
        
        for (let i = 0, j = CENTRAL_MED_POLYGON.length - 1; i < CENTRAL_MED_POLYGON.length; j = i++) {
        const [xi, yi] = CENTRAL_MED_POLYGON[i];
        const [xj, yj] = CENTRAL_MED_POLYGON[j];
        
        if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
        }
        
        return inside;
    }
  
    private static isInTargetAltitude(altitude: number): boolean {
        return altitude >= MONITORING_THRESHOLDS.altitude.min &&
            altitude <= MONITORING_THRESHOLDS.altitude.max;
    }

    private static isInTargetSpeed(speed: number): boolean {
        return speed >= MONITORING_THRESHOLDS.speed.min &&
            speed <= MONITORING_THRESHOLDS.speed.max;
    }


    /**
     * Analyzes an aircraft and returns its monitoring and loitering status.
     * Does not mutate the input aircraft object.
     * @param aircraft - The aircraft to analyze.
     * @returns AircraftAnalysisResult
     */
    public analyzeAircraft(aircraft: Aircraft): AircraftAnalysisResult {

        // Just a simple way to debug the loitering event page
        // uncomment if you want to see all aircraft as loitering
        // if (aircraft.track.length > 2) {
        //     return {
        //         is_monitored: true,
        //         not_monitored_reason: null,
        //         is_loitering: true,
        //     };
        // }

        const latestPosition = aircraft.track[0];
        if (!latestPosition) {
            return {
                is_monitored: false,
                not_monitored_reason: 'No position data available.',
                is_loitering: false,
            };
        }

        // Check monitoring requirements
        const monitoringCheck = AircraftAnalyzer.checkMonitoringRequirements(latestPosition);
        if (!monitoringCheck.is_monitored) {
            return {
                is_monitored: false,
                not_monitored_reason: monitoringCheck.not_monitored_reason,
                is_loitering: false,
            };
        }

        // If all checks pass, the aircraft is monitored
        const is_loitering = AircraftAnalyzer.hasIntersectingTrack(aircraft);
        return {
            is_monitored: true,
            not_monitored_reason: null,
            is_loitering,
        };
    }

    static hasIntersectingTrack(aircraft: Aircraft): boolean {
        const intersections = AircraftAnalyzer.getIntersections(aircraft);
        return intersections.length > 0;
    }

    /**
     * Returns all intersection points (with segment info and timestamp) for a given aircraft track.
     * Only includes intersections where all segment endpoints meet monitoring requirements.
     */
    static getIntersections(aircraft: Aircraft): Array<{ segments: { start: ExtendedPosition, end: ExtendedPosition }[], timestamp: number }> {
        const intersections: Array<{ segments: { start: ExtendedPosition, end: ExtendedPosition }[], timestamp: number }> = [];
        const segments = aircraft.track.slice(1).map((point, i) => ({
            start: aircraft.track[i],
            end: point
        }));
        for (let i = 0; i < segments.length - 2; i++) {
            for (let j = i + 2; j < segments.length; j++) {
                if (areIntersecting(segments[i], segments[j])) {
                    const pointsToCheck = [
                        segments[i].start,
                        segments[i].end,
                        segments[j].start,
                        segments[j].end
                    ];
                    const allPointsValid = pointsToCheck.every(point =>
                        AircraftAnalyzer.checkMonitoringRequirements(point).is_monitored
                    );
                    if (allPointsValid) {
                        // Use the newer of the two segment endpoints as the timestamp
                        const timestamp = Math.max(
                            segments[i].end.timestamp,
                            segments[j].end.timestamp
                        );
                        intersections.push({
                            segments: [segments[i], segments[j]],
                            timestamp
                        });
                    }
                }
            }
        }
        return intersections;
    }
}
