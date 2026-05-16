import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

const MAPBOX_TOKEN = 'YOUR_ACCESS_TOKEN_HERE';
const BOSTON_BIKE_LANES_URL =
  'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D';
const CAMBRIDGE_BIKE_LANES_URL =
  'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';
const STATIONS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const TRAFFIC_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

if (!MAPBOX_TOKEN || MAPBOX_TOKEN === 'YOUR_ACCESS_TOKEN_HERE') {
  console.warn('Add your Mapbox token in map.js to render the map.');
}
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 8,
  maxZoom: 18,
});

let stations = [];
let stationsById = new Map();
let trips = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

const radiusScale = d3.scaleSqrt().range([0, 25]);
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

const svg = d3.select('#map').append('svg').classed('flow-colors', true);
const tooltip = d3
  .select('body')
  .append('div')
  .style('position', 'fixed')
  .style('background', 'rgba(15, 23, 42, 0.92)')
  .style('color', 'white')
  .style('padding', '0.5rem 0.65rem')
  .style('border-radius', '0.5rem')
  .style('font', '500 0.8rem/1.4 system-ui, sans-serif')
  .style('pointer-events', 'none')
  .style('z-index', '9999')
  .style('visibility', 'hidden');

const timeSlider = document.querySelector('#time-slider');
const selectedTime = document.querySelector('#selected-time');

map.on('load', async () => {
  map.addSource('boston_route', {
    type: 'geojson',
    data: BOSTON_BIKE_LANES_URL,
  });

  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': '#16a34a',
      'line-width': 3,
      'line-opacity': 0.4,
    },
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: CAMBRIDGE_BIKE_LANES_URL,
  });

  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#16a34a',
      'line-width': 3,
      'line-opacity': 0.4,
    },
  });

  const stationsJson = await d3.json(STATIONS_URL);
  stations = (stationsJson?.data?.stations ?? stationsJson ?? []).map((d) => ({
    ...d,
    lat: Number(d.Lat ?? d.lat),
    lon: Number(d.Long ?? d.long ?? d.lon),
    id: String(d.Number ?? d.station_id ?? d.id),
  }));

  stationsById = d3.index(stations, (d) => d.id);

  trips = await d3.csv(TRAFFIC_URL, (row) => ({
    ...row,
    started_at: new Date(row.started_at),
    ended_at: new Date(row.ended_at),
  }));

  departuresByMinute = Array.from({ length: 1440 }, () => []);
  arrivalsByMinute = Array.from({ length: 1440 }, () => []);

  trips.forEach((trip) => {
    const startMinute = minutesSinceMidnight(trip.started_at);
    const endMinute = minutesSinceMidnight(trip.ended_at);
    departuresByMinute[startMinute].push(trip);
    arrivalsByMinute[endMinute].push(trip);
  });

  updateScatterPlot(-1);
});

map.on('move', () => updateScatterPlot(Number(timeSlider.value)));
map.on('zoom', () => updateScatterPlot(Number(timeSlider.value)));

timeSlider.addEventListener('input', () => {
  const value = Number(timeSlider.value);
  selectedTime.textContent = value === -1 ? 'Any time' : formatTime(value);
  selectedTime.dateTime = value === -1 ? 'all-day' : formatTime(value);
  updateScatterPlot(value);
});

function getMapPoint(station) {
  return map.project([station.lon, station.lat]);
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(totalMinutes) {
  const hours24 = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  }

  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

function computeStationTraffic(stationList, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stationList.map((station) => {
    const stationId = station.id;
    const departureCount = departures.get(stationId) ?? 0;
    const arrivalCount = arrivals.get(stationId) ?? 0;
    const totalTraffic = departureCount + arrivalCount;

    return {
      ...station,
      departures: departureCount,
      arrivals: arrivalCount,
      totalTraffic,
    };
  });
}

function updateScatterPlot(timeFilter) {
  if (!stations.length) return;

  const filteredStations = computeStationTraffic(stations, timeFilter).filter(
    (d) => d.totalTraffic > 0,
  );

  radiusScale.domain(d3.extent(filteredStations, (d) => d.totalTraffic));
  timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

  const circles = svg.selectAll('circle').data(filteredStations, (d) => d.id);

  circles.exit().remove();

  circles
    .enter()
    .append('circle')
    .on('mouseenter', (event, d) => {
      tooltip.style('visibility', 'visible').text(
        `${d.NAME} | Total: ${d.totalTraffic} | Departures: ${d.departures} | Arrivals: ${d.arrivals}`,
      );
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.clientX + 12}px`).style('top', `${event.clientY + 12}px`);
    })
    .on('mouseleave', () => {
      tooltip.style('visibility', 'hidden');
    })
    .merge(circles)
    .attr('cx', (d) => getMapPoint(d).x)
    .attr('cy', (d) => getMapPoint(d).y)
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) => {
      if (!d.totalTraffic) return 0.5;
      return stationFlow(d.departures / d.totalTraffic);
    });
}
