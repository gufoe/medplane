import { AdsbFiProvider } from '../providers/adsbfi-provider';
import { CENTRAL_MED_BOUNDS } from '../config';
import { logger } from '../logger';

export async function runProviderTest(): Promise<void> {
    logger.debug('Running in test mode - fetching aircraft data...');

    try {
        const provider = AdsbFiProvider.fromEnv();
        logger.debug('\nInitiating API call...');

        const result = await provider.scan(CENTRAL_MED_BOUNDS);
        logger.debug('\nAPI call completed successfully.');
        logger.debug('\nAircraft Data:');
        logger.debug('Timestamp:', new Date(result.timestamp * 1000).toISOString());
        logger.debug('Number of aircraft:', result.aircraft.length);

        // Print details of first 3 aircraft
        result.aircraft.slice(0, 3).forEach((aircraft, index) => {
            logger.debug(`\nAircraft ${index + 1}:`);
            logger.debug('ICAO:', aircraft.icao);
            logger.debug('Callsign:', aircraft.callsign);
            logger.debug('Position:', { latitude: aircraft.latitude, longitude: aircraft.longitude });
            logger.debug('Altitude:', aircraft.altitude);
            logger.debug('Speed:', aircraft.speed);
            logger.debug('Heading:', aircraft.heading);
            logger.debug('Vertical Rate:', aircraft.verticalRate);
            logger.debug('Distance to Coast:', aircraft.distanceToCoast);
        });
    } catch (error) {
        logger.error('\nTest failed:', error);
        throw error;
    }
}
