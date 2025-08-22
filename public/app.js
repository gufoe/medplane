// Initialize the map
const map = L.map('map');
// Fit to Sicily Channel bounds before any data loads
map.fitBounds([[33, 10], [38, 18]]);

// Add OpenStreetMap tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Store aircraft markers and tracks
const aircraftMarkers = new Map();
const aircraftTracks = new Map();

// Store monitoring area rectangle
let monitoringAreaRect = null;
let hasFitToMonitoringArea = false;

// Aircraft renderer class for drawing detailed aircraft
class AircraftRenderer {
    constructor() {
        this.size = 18; // Display size
        this.pixelRatio = window.devicePixelRatio || 1;
        this.padding = 4; // Add padding to prevent clipping
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.canvas.width = (this.size * 2 + this.padding * 2) * this.pixelRatio;
        this.canvas.height = (this.size * 2 + this.padding * 2) * this.pixelRatio;
        this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    }

    /**
     * Draw a simplified aircraft silhouette from top view
     * @param {boolean} isLoitering - Whether the aircraft is flagged as loitering
     * @param {boolean} isMonitored - Whether the aircraft is monitored
     * @param {number} heading - Aircraft heading in degrees
     * @returns {HTMLCanvasElement} Canvas with the aircraft drawing
     */
    drawAircraft(isLoitering, isMonitored, heading = 0) {
        const ctx = this.ctx;
        const size = this.size;
        const centerX = (this.canvas.width / this.pixelRatio) / 2;
        const centerY = (this.canvas.height / this.pixelRatio) / 2;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate((heading - 90) * Math.PI / 180);

        let color, strokeColor, opacity;
        if (isLoitering) {
            color = '#dc3545'; // red
            strokeColor = 'rgba(255,255,255,0.8)';
            opacity = 1;
        } else if (isMonitored) {
            color = '#007bff'; // blue
            strokeColor = 'rgba(255,255,255,0.8)';
            opacity = 1;
        } else {
            color = '#888'; // solid gray
            strokeColor = 'rgba(0,0,0,0)'; // no stroke
            opacity = 1;
        }
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;

        // Fuselage
        const fuselageLength = size * 1.1;
        const fuselageWidth = size * 0.22;
        ctx.beginPath();
        ctx.rect(-fuselageLength/2, -fuselageWidth/2, fuselageLength, fuselageWidth);
        ctx.fill();
        ctx.stroke();

        // Wings
        const wingSpan = size * 2.0;
        const wingWidth = size * 0.35;
        ctx.save();
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.rect(-wingSpan/2, -wingWidth/2, wingSpan, wingWidth);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Tail
        const tailBase = size * 0.6;
        const tailHeight = size * 0.5;
        ctx.beginPath();
        ctx.moveTo(-fuselageLength/2, 0);
        ctx.lineTo(-fuselageLength/2 - tailHeight, -tailBase/2);
        ctx.lineTo(-fuselageLength/2 - tailHeight, tailBase/2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.restore();
        ctx.globalAlpha = 1;

        return this.canvas;
    }

    /**
     * Create a Leaflet icon using the aircraft drawing
     * @param {boolean} isLoitering - Whether the aircraft is loitering
     * @param {boolean} isMonitored - Whether the aircraft is monitored
     * @param {number} heading - Aircraft heading in degrees
     * @returns {L.Icon} Leaflet icon with the aircraft drawing
     */
    createIcon(isLoitering, isMonitored, heading = 0) {
        const canvas = this.drawAircraft(isLoitering, isMonitored, heading);
        const dataUrl = canvas.toDataURL();
        const iconSize = (this.size * 2 + this.padding * 2);
        return L.icon({
            iconUrl: dataUrl,
            iconSize: [iconSize, iconSize],
            iconAnchor: [iconSize / 2, iconSize / 2],
            popupAnchor: [0, -this.size],
            className: `aircraft-icon-${Math.random().toString(36).substring(2, 9)}`
        });
    }
}

// Initialize the aircraft renderer
const aircraftRenderer = new AircraftRenderer();

// Custom aircraft icon (legacy - keeping for fallback)
const createAircraftIcon = () => {
    return L.divIcon({
        className: `aircraft-marker`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
    });
};

// Update aircraft positions and tracks
function updateAircraft(data) {
    const { aircraft, monitoringArea } = data;

    // Update monitoring area if needed
    if (monitoringArea && (!monitoringAreaRect || !monitoringAreaRect._map)) {
        if (monitoringAreaRect) {
            monitoringAreaRect.remove();
        }
        
        // Check if we have the new polygon format or old bounds format
        if (monitoringArea.polygon) {
            // New polygon format
            monitoringAreaRect = L.polygon(monitoringArea.polygon, {
                color: 'red',
                weight: 2,
                fillColor: 'red',
                fillOpacity: 0.1
            }).addTo(map);
        } else {
            // Fallback to old rectangle format (for backward compatibility)
            monitoringAreaRect = L.rectangle([
                [monitoringArea.minLat, monitoringArea.minLon],
                [monitoringArea.maxLat, monitoringArea.maxLon]
            ], {
                color: 'red',
                weight: 2,
                fillColor: 'red',
                fillOpacity: 0.1
            }).addTo(map);
        }
        
        if (!hasFitToMonitoringArea) {
            map.fitBounds(monitoringAreaRect.getBounds());
            hasFitToMonitoringArea = true;
        }
    }

    // Update aircraft
    aircraft.forEach(ac => {
        const latest = ac.track && ac.track[0] ? ac.track[0] : {};
        const position = [latest.latitude, latest.longitude];
        const heading = latest.heading || 0;

        // Remove and recreate marker for update
        if (aircraftMarkers.has(ac.icao)) {
            const oldMarker = aircraftMarkers.get(ac.icao);
            oldMarker.remove();
            aircraftMarkers.delete(ac.icao);
        }
        // Create new aircraft icon
        const icon = aircraftRenderer.createIcon(ac.is_loitering, ac.is_monitored, heading);
        const marker = L.marker(position, {
            icon: icon
        }).addTo(map);
        // Set initial opacity based on monitoring status
        const markerElement = marker.getElement();
        if (markerElement) {
            markerElement.style.opacity = ac.is_monitored ? '1' : '0.3';
        }
        // Add popup with more detailed information
        marker.bindPopup(`
            <h3>${ac.callsign || 'Unknown'} (${ac.icao})</h3>
            ${ac.info ? `<p><b>Aircraft Info:</b> ${ac.info}</p>` : ''}
            <p>Position: ${latest.latitude?.toFixed(4)}, ${latest.longitude?.toFixed(4)}</p>
            <p>Altitude: ${latest.altitude}ft</p>
            <p>Speed: ${latest.speed}kts</p>
            <p>Heading: ${latest.heading}°</p>
            <p>Vertical Rate: ${latest.verticalRate}ft/min</p>
            <p>Distance to Coast: ${latest.distanceToCoast?.toFixed(0) ?? '?'} km</p>
            <p>Last Update: ${latest.timestamp ? new Date(latest.timestamp * 1000).toLocaleTimeString() : 'N/A'}</p>
            ${ac.is_loitering ? '<p class="highlight">Loitering Aircraft</p>' : ''}
            ${ac.is_monitored ? '<p class="monitored">Monitored Aircraft</p>' : `<p class="unmonitored">${ac.not_monitored_reason || 'Outside Monitoring Area'}</p>`}
        `);
        aircraftMarkers.set(ac.icao, marker);

        // Update track
        if (ac.track && ac.track.length > 1) {
            const trackPoints = ac.track.map(pt => [pt.latitude, pt.longitude]);
            if (aircraftTracks.has(ac.icao)) {
                const track = aircraftTracks.get(ac.icao);
                track.setLatLngs(trackPoints);
                track.setStyle({
                    color: ac.is_loitering ? '#dc3545' : (ac.is_monitored ? '#007bff' : 'rgba(120,120,120,0.5)'),
                    weight: 2,
                    opacity: ac.is_monitored ? 0.7 : 0.3
                });
            } else {
                const track = L.polyline(trackPoints, {
                    color: ac.is_loitering ? '#dc3545' : (ac.is_monitored ? '#007bff' : 'rgba(120,120,120,0.5)'),
                    weight: 2,
                    opacity: ac.is_monitored ? 0.7 : 0.3
                }).addTo(map);
                aircraftTracks.set(ac.icao, track);
            }
        }
    });

    // Remove old markers and tracks
    for (const [icao, marker] of aircraftMarkers) {
        if (!aircraft.find(ac => ac.icao === icao)) {
            marker.remove();
            aircraftMarkers.delete(icao);
            if (aircraftTracks.has(icao)) {
                aircraftTracks.get(icao).remove();
                aircraftTracks.delete(icao);
            }
        }
    }

    // Update aircraft list with all aircraft
    updateAircraftList(aircraft);
}

// Update the aircraft information panel
function updateAircraftList(aircraft) {
    const container = document.getElementById('aircraft-list');
    container.innerHTML = '';

    if (aircraft.length === 0) {
        container.innerHTML = '<p>No aircraft detected.</p>';
        return;
    }

    // Sort aircraft by status (loitering -> monitored -> unmonitored) and then by altitude within each group
    aircraft.sort((a, b) => {
        // First sort by status
        if (a.is_loitering !== b.is_loitering) {
            return b.is_loitering ? 1 : -1; // Loitering aircraft first (red)
        }
        if (a.is_monitored !== b.is_monitored) {
            return b.is_monitored ? 1 : -1; // Then monitored aircraft (blue)
        }
        // Within same status group, sort by altitude
        return (b.track && b.track[0]?.altitude || 0) - (a.track && a.track[0]?.altitude || 0);
    });

    let expandedIcao = null;
    // If already expanded, keep it expanded after update
    if (window._expandedAircraftIcao) {
        expandedIcao = window._expandedAircraftIcao;
    }

    aircraft.forEach(ac => {
        const latest = ac.track && ac.track[0] ? ac.track[0] : {};
        const item = document.createElement('div');
        item.className = 'aircraft-item' + (expandedIcao === ac.icao ? ' expanded' : '');
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-expanded', expandedIcao === ac.icao ? 'true' : 'false');
        let color = '';
        if (ac.is_loitering) {
            color = '#dc3545'; // red
        } else if (ac.is_monitored) {
            color = '#007bff'; // blue
        } else {
            color = '#888'; // gray
        }
        // Compact main row
        item.innerHTML = `
            <div class="aircraft-main">
                <span class="aircraft-callsign" style="color:${color}">${ac.callsign || ac.icao}</span>
                <span class="aircraft-alt">${latest.altitude ?? '?'} ft</span>
                <span class="aircraft-speed">${latest.speed ?? '?'} kts</span>
                <span class="aircraft-status${ac.is_monitored ? ' monitored' : ''}">
                    ${ac.is_loitering ? 'Loitering' : (ac.is_monitored ? 'Monitored' : 'Unmonitored')}
                </span>
            </div>
            <div class="aircraft-details">
                ${ac.info ? `<p><b>Aircraft Info:</b> ${ac.info}</p>` : ''}
                <p><b>Position:</b> ${latest.latitude?.toFixed(4)}, ${latest.longitude?.toFixed(4)}</p>
                <p><b>Heading:</b> ${latest.heading ?? '?'}°</p>
                <p><b>Vertical Rate:</b> ${latest.verticalRate ?? '?'} ft/min</p>
                <p><b>Distance to Coast:</b> ${latest.distanceToCoast?.toFixed(0) ?? '?'} km</p>
                <p><b>Last Update:</b> ${latest.timestamp ? new Date(latest.timestamp * 1000).toLocaleTimeString() : 'N/A'}</p>
                ${ac.not_monitored_reason ? `<p><b>Reason:</b> ${ac.not_monitored_reason}</p>` : ''}
            </div>
        `;
        item.addEventListener('click', () => {
            if (window._expandedAircraftIcao === ac.icao) {
                window._expandedAircraftIcao = null;
            } else {
                window._expandedAircraftIcao = ac.icao;
            }
            updateAircraftList(aircraft);
        });
        container.appendChild(item);
    });
}

// Fetch aircraft data periodically
function fetchAircraftData() {
    fetch('/api/aircraft')
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (!data || !data.aircraft) {
                throw new Error('Invalid response format');
            }
            updateAircraft(data);
        })
        .catch(error => console.error('Error fetching aircraft data:', error));
}

// Update every 10 seconds
setInterval(fetchAircraftData, 10000);

// Initial fetch
fetchAircraftData();
