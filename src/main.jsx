import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import { contours } from 'd3-contour';
import { Search, ArrowUpRight, MapPin, Layers, Mountain, Crosshair, Plus, Minus, Maximize, Scan, Route, Download, X, Check, Info, SlidersHorizontal, LoaderCircle, MoveUpRight, Globe2, LocateFixed, CircleHelp, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, HardDrive, Trash2, Languages, FolderOpen, Eye, EyeOff, Undo2 } from 'lucide-react';
import { pointIndex, makeProfile, exportCollection, unproject, SOURCE } from './hydrology.js';
import { cacheEnabled, setCacheEnabled, cacheStats, clearCache, MAX_CACHE_BYTES } from './cache.js';
import { terrainTask } from './terrain-client.js';
import { createTranslator, readLanguage, saveLanguage } from './i18n.js';
import { EMPTY_ANALYSES, createWatershedAnalysis, analysesReducer } from './analyses.js';
import { deleteAnalysisCollection, listAnalysisCollections, saveAnalysisCollection } from './collections.js';
import 'leaflet/dist/leaflet.css';
import './styles.css';

const DEFAULT_POINT = [33.053, 35.628];
const WATERSHED_COLOR = '#197659';
const REGION_BOUNDS = [[28.7, 32.1], [37.5, 42.5]];
const PLACES = [
  { name: 'Jordan River, northern Israel', point: DEFAULT_POINT },
  { name: 'Mount Hermon', point: [33.4162, 35.8575] },
  { name: 'Sea of Galilee', point: [32.81, 35.59] },
  { name: 'Jerusalem', point: [31.778, 35.235] },
  { name: 'Beirut, Lebanon', point: [33.894, 35.502] },
  { name: 'Damascus, Syria', point: [33.513, 36.293] },
  { name: 'Amman, Jordan', point: [31.954, 35.91] },
  { name: 'Nahal Zin, Israel', point: [30.83, 34.77] },
];
const format = (number, digits = 0) => Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '--';
const formatArea = area => area > 0 && area < 0.01 ? '< 0.01' : format(area, 2);
const profileDirection = bearing => Math.round(bearing) % 180 === 0 ? 'North / south' : Math.round(bearing) % 180 === 90 ? 'East / west' : 'Custom transect';

function IconButton({ icon: Icon, label, active = false, className = '', ...props }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`.trim()} title={label} aria-label={label} {...props}><Icon size={18}/></button>;
}

function Toggle({ label, checked, onChange, icon: Icon, detail, disabled = false }) {
  return <label className="layer-row"><span className="layer-name"><Icon size={17}/><span>{label}{detail && <small>{detail}</small>}</span></span><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span className="switch"/></label>;
}

function AppMark({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 22 21H2L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/></svg>;
}

function terrainContours(model) {
  const step = 4;
  const width = Math.floor(model.width / step);
  const height = Math.floor(model.height / step);
  const values = Array.from({ length: width * height }, (_, index) => model.elevations[Math.floor(index / width) * step * model.width + index % width * step]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const interval = Math.max(50, Math.ceil((maximum - minimum) / 18 / 50) * 50);
  const thresholds = Array.from({ length: Math.floor((maximum - minimum) / interval) }, (_, index) => Math.ceil(minimum / interval) * interval + index * interval);
  return { type: 'FeatureCollection', features: contours().size([width, height]).thresholds(thresholds)(values).map(shape => ({ type: 'Feature', properties: { elevation: shape.value }, geometry: { type: 'MultiPolygon', coordinates: shape.coordinates.map(polygon => polygon.map(ring => ring.map(([column, row]) => {
    const [lat, lng] = unproject(model.origin[0] + column * step, model.origin[1] + row * step);
    return [lng, lat];
  }))) } })) };
}

function TerrainMap({ mapRef, model, selected, deletePromptId, onDeleteAnalysis, onDismissDelete, hasAnalysis, selectedAnalysisVisible, results, activeId, pendingSnap, layers, profiles, hoverPoint, mode, onSelect, onDraw, onOutletClick, onAnalysisNumberClick, aoi, areaHydrology, axisWaypoints, axisRoute, axisViewshed, language }) {
  const t = createTranslator(language);
  const element = useRef(null);
  const [deletePosition, setDeletePosition] = useState(null);
  const handlers = useRef({ onSelect, onDraw, onOutletClick, onAnalysisNumberClick, mode });
  const groups = useRef({});
  handlers.current = { onSelect, onDraw, onOutletClick, onAnalysisNumberClick, mode };
  useEffect(() => {
    const map = L.map(element.current, { zoomControl: false, preferCanvas: true, minZoom: 5, maxZoom: 17 });
    mapRef.current = map;
    map.setView([32.781942, 35.3277836], 13, { animate: false });
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
    map.attributionControl.setPrefix(false);
    map.on('click', event => {
      const point = [event.latlng.lat, event.latlng.lng];
      if (handlers.current.mode === 'point') handlers.current.onSelect(point);
      else handlers.current.onDraw(point);
    });
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(element.current);
    return () => { observer.disconnect(); map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const base = L.tileLayer(layers.satellite
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      : 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: layers.satellite ? 'Imagery &copy; Esri, Maxar, Earthstar Geographics' : 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | DEM: <a href="https://viewfinderpanoramas.org/">SRTM</a>, <a href="https://sonny.4lima.de/">Sonny</a> | map style: &copy; <a href="https://opentopomap.org/">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)', maxZoom: 17,
    }).addTo(map);
    return () => base.remove();
  }, [layers.satellite]);
  useEffect(() => {
    if (!layers.satellite) return;
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Place names &copy; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community',
      maxZoom: 23,
      pane: 'overlayPane',
    }).addTo(mapRef.current);
    return () => labels.remove();
  }, [layers.satellite]);
  useEffect(() => {
    if (!layers.hillshade) return;
    const tile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { opacity: 0.4, attribution: 'Hillshade &copy; Esri, USGS' }).addTo(mapRef.current);
    return () => tile.remove();
  }, [layers.hillshade]);
  useEffect(() => {
    if (!model || !layers.contours) return;
    const layer = L.geoJSON(terrainContours(model), { style: { color: '#756e5b', weight: 0.8, opacity: 0.45, fill: false, interactive: false } }).addTo(mapRef.current);
    return () => layer.remove();
  }, [model, layers.contours]);
  useEffect(() => {
    if (!model || !axisViewshed?.mask?.some(Boolean)) return;
    const canvas = document.createElement('canvas');
    canvas.width = axisViewshed.width;
    canvas.height = axisViewshed.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(canvas.width, canvas.height);
    for (let index = 0; index < axisViewshed.mask.length; index++) {
      if (!axisViewshed.mask[index]) continue;
      const offset = index * 4;
      image.data[offset] = 224;
      image.data[offset + 1] = 82;
      image.data[offset + 2] = 70;
      image.data[offset + 3] = 78;
    }
    context.putImageData(image, 0, 0);
    const [north, west] = unproject(axisViewshed.origin[0], axisViewshed.origin[1]);
    const [south, east] = unproject(axisViewshed.origin[0] + axisViewshed.width, axisViewshed.origin[1] + axisViewshed.height);
    let overlay = null;
    let objectUrl = null;
    let disposed = false;
    canvas.toBlob(blob => {
      if (disposed || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      overlay = L.imageOverlay(objectUrl, [[south, west], [north, east]], { opacity: 1, interactive: false, pane: 'overlayPane' }).addTo(mapRef.current);
    }, 'image/png');
    return () => { disposed = true; overlay?.remove(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [axisViewshed, model]);
  useEffect(() => {
    const group = L.layerGroup().addTo(mapRef.current);
    results.filter(result => result.visible !== false).forEach((result, index) => {
      const color = WATERSHED_COLOR;
      L.geoJSON(result.boundary, { style: { color: '#ffffff', weight: 5, fill: false, interactive: false } }).addTo(group);
      const analysisName = result.name || t('Watershed');
      const partialLabel = result.partial ? ` · ${t('Partial')}` : '';
      L.geoJSON(result.boundary, { style: { color: '#dc4541', weight: 2.5, fillColor: color, fillOpacity: result.id === activeId ? 0.15 : 0.07 } }).bindTooltip(`${analysisName} · ${formatArea(result.area)} ${t('km²')} · ${t('Watershed divide')}${partialLabel}`).addTo(group);
      if (layers.drainage) L.geoJSON(result.channels, { style: { color: '#247dcc', weight: 1.8, opacity: 0.95, interactive: false } }).addTo(group);
      L.geoJSON(result.downstream, { style: { color: '#246eb5', weight: 2.5, dashArray: '5 6', interactive: false } }).addTo(group);
      L.marker(result.point, { icon: L.divIcon({ className: 'analysis-outlet', html: `<span>${Number(result.number) || index + 1}</span>`, iconSize: [23, 23], iconAnchor: [11.5, 11.5] }), zIndexOffset: 900 }).bindTooltip(analysisName).on('click', event => { L.DomEvent.stopPropagation(event); handlers.current.onAnalysisNumberClick(result.id); }).addTo(group);
    });
    return () => group.remove();
  }, [results, activeId, layers.drainage, language]);
  useEffect(() => {
    if (!areaHydrology) return;
    const group = L.layerGroup().addTo(mapRef.current);
    if (layers.drainage) L.geoJSON(areaHydrology.streams, { style: { color: '#247dcc', weight: 1.8, opacity: 0.95, interactive: false } }).addTo(group);
    L.geoJSON(areaHydrology.divides, { style: { color: '#dc4541', weight: 1.8, opacity: 0.9, dashArray: '5 3', interactive: false } }).addTo(group);
    return () => group.remove();
  }, [areaHydrology, layers.drainage]);
  useEffect(() => {
    const group = L.layerGroup().addTo(mapRef.current);
    const showSelected = !hasAnalysis || selectedAnalysisVisible;
    if (selected && showSelected) {
      const marker = L.marker(selected, { icon: L.divIcon({ className: 'point-marker', html: '<span class="point-ring"><i></i></span>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 500 }).addTo(group);
      marker.bindTooltip(t('Selected point · {coordinates}', { coordinates: `${selected[0].toFixed(4)}, ${selected[1].toFixed(4)}` }), { direction: 'top', offset: [0, -16] });
      marker.on('click', event => { L.DomEvent.stopPropagation(event); handlers.current.onOutletClick(selected); });
    }
    if (pendingSnap && selected && showSelected) {
      L.marker(pendingSnap.point, { icon: L.divIcon({ className: 'proposed-outlet-marker', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 700 }).bindTooltip(t('Proposed channel outlet'), { permanent: true, direction: 'top' }).on('click', event => { L.DomEvent.stopPropagation(event); handlers.current.onOutletClick(pendingSnap.point); }).addTo(group);
      L.polyline([selected, pendingSnap.point], { color: '#bc7f39', dashArray: '4 5', weight: 2 }).addTo(group);
    }
    axisWaypoints.forEach((point, index) => L.circleMarker(point, { radius: 6, color: '#fff', weight: 2, fillColor: '#378365', fillOpacity: 1 }).bindTooltip(String(index + 1), { permanent: true, direction: 'top', offset: [0, -5] }).addTo(group));
    if (axisRoute?.path?.length > 1) {
      L.polyline(axisRoute.path, { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(group);
      L.polyline(axisRoute.path, { color: '#d58a32', weight: 3.5, opacity: 1, interactive: false }).addTo(group);
      L.circleMarker(axisRoute.path.at(-1), { radius: 6, color: '#fff', weight: 2, fillColor: '#b94f40', fillOpacity: 1 }).bindTooltip(t('Axis destination')).addTo(group);
    }
    profiles.forEach((profile, index) => {
      L.polyline(profile.samples.map(sample => sample.point), { color: index ? '#b77b45' : '#5a7b72', dashArray: '5 6', weight: 2 }).addTo(group);
      L.marker(profile.samples[0].point, { icon: L.divIcon({ className: 'profile-end', html: index ? 'B' : 'A', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(group);
    });
    if (aoi) L.rectangle(aoi, { color: '#6f7794', weight: 2, dashArray: '5 5', fillOpacity: 0.04 }).addTo(group);
    groups.current.markers = group;
    return () => group.remove();
  }, [selected, selectedAnalysisVisible, hasAnalysis, pendingSnap, profiles, aoi, axisWaypoints, axisRoute, language]);
  useEffect(() => {
    const map = mapRef.current;
    const analysis = results.find(item => item.id === deletePromptId);
    if (!map || !analysis) { setDeletePosition(null); return; }
    const updatePosition = () => {
      const point = map.latLngToContainerPoint(analysis.point);
      const size = map.getSize();
      const width = 74;
      const height = 34;
      let left = point.x + 16;
      if (left + width > size.x - 12) left = point.x - width - 16;
      left = Math.max(12, Math.min(left, size.x - width - 12));
      const top = Math.max(52, Math.min(point.y - height / 2, size.y - height - 16));
      setDeletePosition({ left, top });
    };
    map.on('move zoom resize', updatePosition);
    window.addEventListener('resize', updatePosition);
    const observer = new ResizeObserver(updatePosition);
    observer.observe(element.current);
    updatePosition();
    return () => { map.off('move zoom resize', updatePosition); window.removeEventListener('resize', updatePosition); observer.disconnect(); };
  }, [deletePromptId, results, mapRef]);
  useEffect(() => {
    if (!hoverPoint) return;
    const marker = L.circleMarker(hoverPoint, { radius: 6, color: '#fff', weight: 2, fillColor: '#1b7155', fillOpacity: 1 }).addTo(mapRef.current);
    return () => marker.remove();
  }, [hoverPoint]);
  return <>
    <div ref={element} id="terrain-map" dir="ltr" className={`terrain-map ${mode !== 'point' ? 'drawing' : ''}`} aria-label={t('Interactive terrain map of Israel and neighboring countries')}/>
    {deletePosition && <div className="map-delete-menu" dir={language === 'he' ? 'rtl' : 'ltr'} style={deletePosition}>
      <button className="delete-confirm-button" onClick={onDeleteAnalysis}>{t('Remove')}</button>
    </div>}
  </>;
}

function ProfileChart({ profile, onHover, index, language }) {
  const t = createTranslator(language);
  const [active, setActive] = useState(null);
  const valid = profile.samples.filter(sample => sample.elevation !== null);
  const min = valid.length ? Math.floor(Math.min(...valid.map(sample => sample.elevation)) / 50) * 50 - 20 : 0;
  const max = valid.length ? Math.ceil(Math.max(...valid.map(sample => sample.elevation)) / 50) * 50 + 20 : 100;
  const plotX = distance => 43 + distance / profile.length * 570;
  const plotY = elevation => 119 - (elevation - min) / (max - min) * 94;
  const line = profile.samples.map((sample, sampleIndex) => sample.elevation === null ? '' : `${sampleIndex === 0 || profile.samples[sampleIndex - 1].elevation === null ? 'M' : 'L'}${plotX(sample.distance)},${plotY(sample.elevation)}`).join(' ');
  const color = index ? '#c28a55' : '#4b8c72';
  return <div className="profile-chart"><div className="profile-chart-heading"><span><i style={{ background: color }}/>{profile.kind === 'axis' ? t('Movement axis') : index ? 'B' : 'A'} <b dir="ltr">{profile.bearing.toFixed(0)}°</b> <span className="muted">{t(profile.kind === 'axis' ? 'Least elevation change' : profileDirection(profile.bearing))}</span></span><span>{format(profile.length / 1000, 1)} {t('km')}</span></div>
    <svg viewBox="0 0 640 151" direction="ltr" role="img" aria-label={t('Elevation profile {number}, bearing {bearing} degrees', { number: index + 1, bearing: profile.bearing.toFixed(0) })} onMouseMove={event => {
      const box = event.currentTarget.getBoundingClientRect();
      const sampleIndex = Math.max(0, Math.min(120, Math.round(((event.clientX - box.left) / box.width * 640 - 43) / 570 * 120)));
      setActive(profile.samples[sampleIndex]); onHover(profile.samples[sampleIndex].point);
    }} onMouseLeave={() => { setActive(null); onHover(null); }}>
      <defs><linearGradient id={`profile-fill-${index}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.25"/><stop offset="100%" stopColor={color} stopOpacity="0.025"/></linearGradient></defs>
      {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="43" x2="613" y1={25 + fraction * 94} y2={25 + fraction * 94} stroke="#e9ede9" strokeDasharray="3 4"/><text x="33" y={29 + fraction * 94} textAnchor="end">{format(max - fraction * (max - min))}</text></g>)}
      <path d={`${line} L613,119 L43,119 Z`} fill={`url(#profile-fill-${index})`} stroke="none"/><path d={line} fill="none" stroke={color} strokeWidth="2"/>
      <line x1="328" x2="328" y1="22" y2="120" stroke="#a9b5ad" strokeDasharray="3 4"/>
      {[0, 0.5, 1].map(fraction => <text key={fraction} x={43 + fraction * 570} y="135" textAnchor="middle">{format(profile.length * fraction / 1000, 1)}</text>)}
      <text x="328" y="150" textAnchor="middle">{t('Distance (km)')}</text><text x="5" y="12">{t('Elevation (m)')}</text>
      {active?.elevation !== null && active && <g><line x1={plotX(active.distance)} x2={plotX(active.distance)} y1="20" y2="119" stroke={color}/><circle cx={plotX(active.distance)} cy={plotY(active.elevation)} r="4" fill={color}/><text x={Math.max(80, Math.min(560, plotX(active.distance)))} y="17" textAnchor="middle" className="chart-readout">{format(active.elevation)} {t('m')} · {format(active.distance / 1000, 2)} {t('km')}</text></g>}
    </svg>
  </div>;
}

function App() {
  const mapRef = useRef(null);
  const requestId = useRef(0);
  const analysisSequence = useRef(0);
  const analysisListRef = useRef(null);
  const [language, setLanguage] = useState(readLanguage);
  const t = createTranslator(language);
  const direction = language === 'he' ? 'rtl' : 'ltr';
  const [model, setModel] = useState(null);
  const [selected, setSelected] = useState(null);
  const [pointName, setPointName] = useState('');
  const [analysisState, dispatchAnalysis] = useReducer(analysesReducer, EMPTY_ANALYSES);
  const results = analysisState.items;
  const activeId = analysisState.activeId;
  const [loading, setLoading] = useState(false);
  const [deletePromptId, setDeletePromptId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingSnap, setPendingSnap] = useState(null);
  const [layers, setLayers] = useState({ satellite: false, hillshade: false, contours: false, drainage: true });
  const [profiles, setProfiles] = useState([]);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [mode, setMode] = useState('point');
  const [aoi, setAoi] = useState(null);
  const [areaHydrology, setAreaHydrology] = useState(null);
  const [axisWaypoints, setAxisWaypoints] = useState([]);
  const [axisRoute, setAxisRoute] = useState(null);
  const [axisViewshed, setAxisViewshed] = useState(null);
  const [viewshedRadius, setViewshedRadius] = useState(1000);
  const [firstCorner, setFirstCorner] = useState(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [modal, setModal] = useState(null);
  const [savedCollections, setSavedCollections] = useState([]);
  const [collectionName, setCollectionName] = useState('');
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [collectionError, setCollectionError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [analysesOnly, setAnalysesOnly] = useState(false);
  const [localCache, setLocalCache] = useState(cacheEnabled);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState('loading');
  const index = model && selected ? pointIndex(model, ...selected) : -1;
  const elevation = index >= 0 ? model.elevations[index] : null;
  const current = results.find(analysis => analysis.id === activeId);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
    document.title = t('AGANIM | Israel & Neighbors');
    saveLanguage(language);
  }, [language]);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  }, []);

  async function fetchTerrain(point, name = pointName, target = current, initial = false) {
    const request = ++requestId.current;
    const started = performance.now();
    const reuse = model && pointIndex(model, ...point) >= 0 ? model : null;
    setLoading(true); setProgress(0); setError(''); setPendingSnap(null);
    setAnalysisPhase('loading');
    if (!reuse) { setModel(null); setProfiles([]); }
    try {
      const response = await terrainTask(initial ? 'initial' : 'inspect-point', { point, model: reuse, initial, cacheEnabled: localCache }, (value, phase) => {
        if (request === requestId.current) { setProgress(value); setAnalysisPhase(phase); }
      });
      if (request !== requestId.current) return;
      const data = response.model || reuse;
      setModel(data);
      if (initial) {
        const outletPoint = response.point || point;
        const number = ++analysisSequence.current;
        const origin = data.cache?.source === 'local' ? 'Local terrain cache' : data.cache?.source === 'local tiles' ? 'Cached elevation tiles' : 'In-memory terrain';
        dispatchAnalysis({ type: 'upsert', analysis: createWatershedAnalysis(response.result, { id: `analysis-${number}`, number, name: '', location: name, point: outletPoint, model: data, elapsedMs: performance.now() - started, origin }) });
        setSelected(outletPoint); setPointName(name); setPendingSnap(null);
        if (profilesOpen) setProfiles([makeProfile(data, outletPoint, 0), makeProfile(data, outletPoint, 90)]);
        setLoading(false);
        setCacheInfo(await cacheStats());
        if (response.expansionWarning) setNotice(response.expansionWarning);
        else if (response.proposed?.distance > data.resolution * 0.8) setNotice('Watershed outlet moved to the nearest drainage channel.');
        else if (response.result.area < 0.08) setNotice('Very little upslope area drains to this point. For a ridge or summit, try an outlet in a wadi farther downslope.');
        return;
      }
      if (target) dispatchAnalysis({ type: 'upsert', analysis: { ...target, model: data } });
      setSelected(point);
      setPointName(name);
      setPendingSnap(response.proposed?.distance > data.resolution * 0.8 ? response.proposed : null);
      if (profilesOpen) setProfiles([makeProfile(data, point, 0), makeProfile(data, point, 90)]);
      setLoading(false);
      setCacheInfo(await cacheStats());
    } catch (failure) {
      if (request !== requestId.current) return;
      setError('Elevation data is unavailable for this location. The provider may lack coverage, or the connection failed. Try again or select another location. No sample results are substituted.');
      setLoading(false); setModel(null);
      setCacheInfo(await cacheStats());
    }
  }
  useEffect(() => {
    let disposed = false;
    cacheStats().then(info => { if (!disposed) setCacheInfo(info); });
    return () => { disposed = true; requestId.current++; };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  function selectPoint(point, name = 'Selected terrain point') {
    setSelected(point); setPointName(name); setPendingSnap(null); setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null); setError('');
    setDeletePromptId(null);
    dispatchAnalysis({ type: 'activate', id: null });
    setSearchOpen(false);
    fetchTerrain(point, name, null, true);
  }
  async function calculate(outletIndex = index, usePoint = selected) {
    if (!model || !selected || outletIndex < 0) return;
    const request = ++requestId.current;
    const started = performance.now();
    setLoading(true); setAnalysisPhase('calculating'); setError('');
    try {
      const { result } = await terrainTask('calculate', { model, outlet: outletIndex, cacheEnabled: localCache });
      if (request !== requestId.current) return;
      const number = current?.number ?? ++analysisSequence.current;
      const origin = current?.origin || (model.cache?.source === 'local' ? 'Local terrain cache' : model.cache?.source === 'local tiles' ? 'Cached elevation tiles' : 'In-memory terrain');
      dispatchAnalysis({ type: 'upsert', analysis: createWatershedAnalysis(result, { id: current?.id ?? `analysis-${number}`, number, name: current?.name || '', location: current?.location || pointName, point: usePoint, model, elapsedMs: performance.now() - started, origin }) });
      setSelected(usePoint); setPendingSnap(null);
      if (profilesOpen) setProfiles([makeProfile(model, usePoint, 0), makeProfile(model, usePoint, 90)]);
      setLoading(false);
      setCacheInfo(await cacheStats());
      if (result.area < 0.08) setNotice('Very little upslope area drains to this point. For a ridge or summit, try an outlet in a wadi farther downslope.');
    } catch (failure) {
      if (request !== requestId.current) return;
      setLoading(false); setError('The watershed calculation failed. Try another outlet or reload terrain data.');
    }
  }
  function requestWatershed() {
    if (!model || index < 0) return;
    calculate(index, selected);
  }
  function analyzeTerrain() {
    if (index < 0) return;
    setProfiles([makeProfile(model, selected, 0), makeProfile(model, selected, 90)]);
    setProfilesOpen(true);
    mapRef.current.setView(selected, 12);
  }
  async function analyzeArea(bounds) {
    const request = ++requestId.current;
    const south = Math.min(bounds[0][0], bounds[1][0]);
    const north = Math.max(bounds[0][0], bounds[1][0]);
    const west = Math.min(bounds[0][1], bounds[1][1]);
    const east = Math.max(bounds[0][1], bounds[1][1]);
    const normalized = [[south, west], [north, east]];
    const center = [(south + north) / 2, (west + east) / 2];
    const reuse = model && normalized.every(point => pointIndex(model, ...point) >= 0) ? model : null;
    setAoi(normalized); setAreaHydrology(null); setLoading(true); setProgress(0);
    setAnalysisPhase(reuse ? 'calculating' : 'loading'); setError(''); setLayers(previous => ({ ...previous, drainage: true }));
    setNotice('Loading streams and watershed divides for area…');
    try {
      const { hydrology } = await terrainTask('area-hydrology', { point: center, bounds: normalized, model: reuse, cacheEnabled: localCache }, (value, phase) => {
        if (request === requestId.current) { setProgress(value); setAnalysisPhase(phase); }
      });
      if (request !== requestId.current) return;
      setAreaHydrology(hydrology); setLoading(false);
      setNotice(hydrology.partial ? 'Streams and divides are shown where DEM coverage is available; this area extends beyond the data.' : 'Streams and watershed divides are shown for the selected area.');
      setCacheInfo(await cacheStats());
    } catch (failure) {
      if (request !== requestId.current) return;
      setLoading(false); setAreaHydrology(null);
      setNotice('Could not load hydrology for this area. Try a smaller area or check the connection.');
    }
  }
  async function analyzeAxis(waypoints) {
    const request = ++requestId.current;
    const midpoint = [waypoints.reduce((sum, point) => sum + point[0], 0) / waypoints.length, waypoints.reduce((sum, point) => sum + point[1], 0) / waypoints.length];
    const reuse = model && waypoints.every(point => pointIndex(model, ...point) >= 0) ? model : null;
    setAxisRoute(null); setAxisViewshed(null); setSelected(null); setPointName(''); setPendingSnap(null);
    setLoading(true); setProgress(0); setAnalysisPhase(reuse ? 'calculating' : 'loading'); setError('');
    setNotice('Calculating movement axis with the least elevation change…');
    try {
      const { axis, model: responseModel, expansionWarning } = await terrainTask('terrain-axis', { waypoints, point: midpoint, model: reuse, cacheEnabled: localCache }, (value, phase) => {
        if (request === requestId.current) { setProgress(value); setAnalysisPhase(phase); }
      });
      if (request !== requestId.current) return;
      const data = responseModel || reuse;
      setModel(data);
      setAxisRoute(axis);
      setAxisViewshed(null);
      setProfiles([{ ...axis, kind: 'axis' }]);
      setProfilesOpen(true);
      setLoading(false);
      setCacheInfo(await cacheStats());
      if (expansionWarning) setNotice(expansionWarning);
      else if (axis.partial) setNotice('The movement axis reaches the edge of available elevation data and is partial.');
      else setNotice('Movement axis calculated with reduced elevation changes.');
      mapRef.current.fitBounds(L.polyline(axis.path).getBounds(), { paddingTopLeft: [55, 75], paddingBottomRight: [65, 110], maxZoom: 14 });
    } catch (failure) {
      if (request !== requestId.current) return;
      setLoading(false); setError('The movement axis could not be calculated between these points. Try points closer together or check elevation coverage.');
      setAxisWaypoints([...waypoints]);
    }
  }
  async function calculateAxisViewshed() {
    if (!model || !axisRoute || loading) return;
    const request = ++requestId.current;
    setLoading(true); setProgress(0); setAnalysisPhase('calculating'); setError('');
    try {
      const { viewshed } = await terrainTask('axis-viewshed', { model, routeSamples: axisRoute.samples, radius: viewshedRadius, cacheEnabled: localCache }, value => {
        if (request === requestId.current) { setProgress(value); setAnalysisPhase('calculating'); }
      });
      if (request !== requestId.current) return;
      setAxisViewshed(viewshed); setLoading(false); setCacheInfo(await cacheStats());
      setNotice(viewshed.partial ? 'The visibility area reaches beyond the loaded elevation coverage.' : 'Visibility area calculated for the selected radius.');
    } catch (failure) {
      if (request !== requestId.current) return;
      setLoading(false); setError('Could not calculate the axis visibility area. Try a smaller radius.');
    }
  }
  function handleDraw(point) {
    if (mode === 'axis') {
      setAxisRoute(null);
      setAxisViewshed(null);
      setProfiles([]); setProfilesOpen(false);
      setAxisWaypoints(previous => [...previous, point]);
      setNotice('Axis point added. Add another point or calculate the axis.');
    } else if (mode === 'area') {
      if (!firstCorner) { setFirstCorner(point); setNotice('Area of interest: select the opposite corner.'); }
      else { const bounds = [firstCorner, point]; setFirstCorner(null); setMode('point'); mapRef.current.fitBounds(bounds, { padding: [40, 40] }); analyzeArea(bounds); }
    } else if (mode === 'profile') {
      if (index < 0) { setNotice('Select a point within the loaded terrain first.'); setMode('point'); return; }
      const north = (point[0] - selected[0]) * 111320;
      const east = (point[1] - selected[1]) * 111320 * Math.cos(selected[0] * Math.PI / 180);
      const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
      const length = Math.min(15000, Math.max(500, Math.hypot(north, east) * 2));
      setProfiles(previous => [...previous.slice(-1), makeProfile(model, selected, bearing, length)]);
      setProfilesOpen(true); setMode('point');
    }
  }
  function finishAxis() {
    if (axisWaypoints.length < 2 || loading) return;
    analyzeAxis(axisWaypoints);
  }
  function undoAxisWaypoint() {
    setAxisWaypoints(previous => previous.slice(0, -1));
    setAxisRoute(null);
    setAxisViewshed(null);
    setProfiles([]); setProfilesOpen(false);
  }
  function choosePlace(place) {
    if (mode === 'axis') handleDraw(place.point);
    else selectPoint(place.point, place.name);
    setQuery(''); setSearchOpen(false);
  }
  async function search(event) {
    event.preventDefault();
    const coordinates = query.trim().split(/[,\s]+/).map(Number);
    if (coordinates.length === 2 && coordinates.every(Number.isFinite)) {
      if (Math.abs(coordinates[0]) > 85 || Math.abs(coordinates[1]) > 180) { setError('Enter valid coordinates as latitude, longitude.'); return; }
      choosePlace({ point: coordinates, name: 'Coordinate selection' }); return;
    }
    const local = PLACES.find(place => [place.name, t(place.name)].some(name => name.toLowerCase().includes(query.toLowerCase())));
    if (query.trim() && local) { choosePlace(local); return; }
    if (!query.trim()) return;
    setSearching(true);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=${language}&viewbox=32,37,43,27&bounded=1&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Search unavailable');
      const data = await response.json();
      if (!data.length) setError('No matching place in this region. Try coordinates or a nearby town.');
      else choosePlace({ point: [Number(data[0].lat), Number(data[0].lon)], name: data[0].display_name.split(',').slice(0, 2).join(',') });
    } catch (failure) { setError('Place search is unavailable. You can still select the map or enter latitude, longitude.'); }
    setSearching(false);
  }
  function zoomResult(analysis = current) {
    if (!analysis) return;
    const bounds = L.geoJSON(analysis.boundary).getBounds();
    const bottomPadding = Math.min(mapRef.current.getSize().y * 0.3, profilesOpen ? 240 : 65);
    mapRef.current.fitBounds(bounds, { paddingTopLeft: [55, 75], paddingBottomRight: [65, bottomPadding], maxZoom: 14 });
  }
  function zoomAllAnalyses() {
    const visible = results.filter(result => result.visible !== false);
    if (!visible.length) return;
    mapRef.current.fitBounds(L.featureGroup(visible.map(result => L.geoJSON(result.boundary))).getBounds(), { padding: [65, 75], maxZoom: 14 });
  }
  function resetSelection() {
    requestId.current++;
    setSelected(null); setPointName(''); setModel(null); setLoading(false);
    setPendingSnap(null); setProfiles([]); setProfilesOpen(false); setHoverPoint(null);
    setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null);
    setError(''); setNotice(''); setProgress(0); setMode('point'); setFirstCorner(null);
    mapRef.current?.fitBounds(REGION_BOUNDS, { padding: [28, 28], maxZoom: 7 });
  }
  function activateAnalysis(analysis) {
    requestId.current++;
    setDeletePromptId(null);
    dispatchAnalysis({ type: 'activate', id: analysis.id });
    setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null);
    setModel(analysis.model); setSelected(analysis.point); setPointName(analysis.location || analysis.name);
    setLoading(false); setError(''); setPendingSnap(null); setProfiles([]); setProfilesOpen(false); setHoverPoint(null); setMode('point'); setFirstCorner(null);
    zoomResult(analysis);
    if (!analysis.model) fetchTerrain(analysis.point, analysis.location || analysis.name, analysis);
  }
  async function openCollections() {
    setCollectionError(''); setModal('collections');
    setSavedCollections(await listAnalysisCollections());
  }
  async function saveCurrentCollection(event) {
    event.preventDefault();
    if (!collectionName.trim() || !results.length || collectionBusy) return;
    setCollectionBusy(true); setCollectionError('');
    try {
      await saveAnalysisCollection(collectionName, results);
      setSavedCollections(await listAnalysisCollections());
      setCollectionName('');
      setNotice('Analysis collection saved on this device.');
    } catch { setCollectionError('The collection could not be saved in browser storage.'); }
    setCollectionBusy(false);
  }
  function loadCollection(collection) {
    const restored = collection.analyses.map(analysis => ({ ...analysis, model: null, mask: null }));
    requestId.current++;
    dispatchAnalysis({ type: 'restore', items: restored, activeId: null });
    analysisSequence.current = restored.reduce((maximum, analysis) => Math.max(maximum, analysis.number), 0);
    setSelected(null); setPointName(''); setModel(null); setLoading(false); setError(''); setPendingSnap(null);
    setProfiles([]); setProfilesOpen(false); setHoverPoint(null); setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null); setAnalysesOnly(false);
    setModal(null); setSidebarOpen(true); setMobilePanelOpen(true);
    if (restored.length) mapRef.current.fitBounds(L.featureGroup(restored.map(analysis => L.geoJSON(analysis.boundary))).getBounds(), { padding: [65, 75], maxZoom: 14 });
  }
  async function removeSavedCollection(id) {
    await deleteAnalysisCollection(id);
    setSavedCollections(await listAnalysisCollections());
  }
  function removeAnalysis(id) {
    const remaining = results.filter(analysis => analysis.id !== id);
    setDeletePromptId(null);
    dispatchAnalysis({ type: 'remove', id });
    if (activeId === id) {
      if (remaining.length) activateAnalysis(remaining.at(-1));
      else resetSelection();
    }
  }
  function clearMap() {
    resetSelection(); dispatchAnalysis({ type: 'clear' });
    analysisSequence.current = 0; setDeletePromptId(null);
    setAoi(null); setAreaHydrology(null); setQuery(''); setSearchOpen(false);
  }
  function download() {
    if (!results.length) { setNotice('Calculate a watershed before exporting.'); return; }
    const blob = new Blob([JSON.stringify(exportCollection(results), null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'watershed-analysis.geojson'; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('GeoJSON exported with watershed boundaries, drainage channels and downstream paths.');
  }
  async function removeLocalCache() {
    setCacheBusy(true);
    try {
      const cleared = await clearCache();
      setCacheInfo(await cacheStats());
      setNotice(cleared ? 'Local terrain and watershed cache cleared. The current map is unchanged.' : 'Local storage is unavailable in this browser.');
    } catch { setNotice('The local cache could not be cleared.'); }
    setCacheBusy(false);
  }
  const filteredPlaces = PLACES.filter(place => [place.name, t(place.name)].some(name => name.toLowerCase().includes(query.toLowerCase())));

  return <div className="app-shell" dir={direction} lang={language}>
    <header className="app-header">
      <a className="brand" dir="ltr" href={import.meta.env.BASE_URL} aria-label={t('AGANIM home')}><span className="brand-symbol"><AppMark size={26}/></span><span>AGANIM</span></a>
      <nav className="header-nav" aria-label={t('Main navigation')}><button className="nav-active" onClick={() => setModal(null)}>{t('Explore')}</button><button onClick={() => { setSidebarOpen(true); setMobilePanelOpen(true); analysisListRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}>{t('Map analyses')}{results.length > 0 && <span className="count-badge">{results.length}</span>}</button></nav>
      <div className="header-right"><span className="live-status"><i/>{t(loading ? 'Loading terrain' : model ? 'Live terrain data' : selected ? 'Terrain unavailable' : 'Ready to analyze')}</span><IconButton icon={CircleHelp} label={t('About this explorer')} onClick={() => setModal('sources')}/><button className="language-button" aria-label={t(language === 'en' ? 'Switch to Hebrew' : 'Switch to English')} title={t(language === 'en' ? 'Switch to Hebrew' : 'Switch to English')} onClick={() => setLanguage(language === 'en' ? 'he' : 'en')}><Languages size={16}/><span lang={language === 'en' ? 'he' : 'en'}>{language === 'en' ? 'עברית' : 'English'}</span></button></div>
    </header>
    <div className="workspace-bar"><div className="workspace-actions"><span className="desktop-text" dir="ltr">WGS 84 <span className="tiny-dot">·</span> EPSG:4326</span><IconButton icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen} label={t('Toggle analysis panel')} onClick={() => setSidebarOpen(!sidebarOpen)}/><button className="button button-small clear-map-button" title={t('Clear map')} aria-label={t('Clear map')} disabled={!results.length && !selected && !aoi && !loading} onClick={clearMap}><Trash2 size={15}/><span>{t('Clear map')}</span></button><button className="button button-small" onClick={download} disabled={!results.length}><Download size={15}/>{t('Export GeoJSON')}</button></div></div>
    <main className={`main-layout ${!sidebarOpen ? 'sidebar-hidden' : ''} ${mobilePanelOpen ? 'mobile-panel-open' : ''}`}>
      <aside className={`sidebar ${analysesOnly ? 'sidebar-analyses-only' : ''}`}>
        <div className="mobile-sheet-bar"><button type="button" aria-controls="mobile-analysis-content" aria-expanded={mobilePanelOpen} aria-label={t(mobilePanelOpen ? 'Collapse analysis panel' : 'Expand analysis panel')} onClick={() => setMobilePanelOpen(!mobilePanelOpen)}><span className="mobile-sheet-grip"/><span className="mobile-sheet-title">{t('Map analyses')}</span><span className="analysis-count">{results.length}</span>{mobilePanelOpen ? <ChevronDown size={18}/> : <ChevronUp size={18}/>}</button></div>
        <div className="sidebar-scroll" id="mobile-analysis-content">
          <section className="analyses-section" ref={analysisListRef}><div className="section-title"><h3><Layers size={16}/>{t('Map analyses')} <span className="analysis-count">{results.length}</span></h3><div className="analysis-heading-actions"><IconButton icon={FolderOpen} label={t('Saved collections')} onClick={openCollections}/><IconButton icon={Scan} label={t('Fit all analyses')} disabled={!results.some(analysis => analysis.visible !== false)} onClick={zoomAllAnalyses}/><IconButton icon={analysesOnly ? ChevronDown : ChevronUp} label={t(analysesOnly ? 'Show full panel' : 'Show basins only')} disabled={!results.length} active={analysesOnly} onClick={() => setAnalysesOnly(!analysesOnly)}/></div></div>{results.length ? <ol className="analysis-list">{results.map(analysis => <li key={analysis.id} data-analysis-id={analysis.id} className={`${analysis.id === activeId ? 'active ' : ''}${analysis.visible === false ? 'analysis-hidden' : ''}`}><button className="analysis-select" aria-pressed={analysis.id === activeId} onClick={() => activateAnalysis(analysis)}><span className="analysis-number">{analysis.number}</span><span><strong>{analysis.name || t('Watershed')}</strong><small>{t(analysis.location || 'Selected terrain point')} · {formatArea(analysis.area)} {t('km²')}</small></span></button><input className="analysis-name-input" aria-label={t('Name watershed {number}', { number: analysis.number })} value={analysis.name} maxLength={60} placeholder={t('Name this watershed')} onFocus={() => dispatchAnalysis({ type: 'activate', id: analysis.id })} onChange={event => dispatchAnalysis({ type: 'rename', id: analysis.id, name: event.target.value })}/><IconButton className="analysis-visibility-button" icon={analysis.visible === false ? Eye : EyeOff} label={t(analysis.visible === false ? 'Show analysis {number}' : 'Hide analysis {number}', { number: analysis.number })} aria-pressed={analysis.visible !== false} onClick={() => dispatchAnalysis({ type: 'visibility', id: analysis.id, visible: analysis.visible === false })}/><IconButton className="analysis-delete-button" icon={X} label={t('Remove analysis {number}', { number: analysis.number })} onClick={() => removeAnalysis(analysis.id)}/></li>)}</ol> : <p className="analysis-empty">{t('No analyses on the map yet.')}</p>}</section>
          <section className="layers-section"><div className="section-title"><h3><Layers size={16}/>{t('Map layers')}</h3><SlidersHorizontal size={15}/></div><div className="map-style-selector" role="group" aria-label={t('Base map')}><button type="button" className={!layers.satellite ? 'active' : ''} aria-pressed={!layers.satellite} onClick={() => setLayers(previous => ({ ...previous, satellite: false }))}><Mountain size={15}/>{t('Topographic')}</button><button type="button" className={layers.satellite ? 'active' : ''} aria-pressed={layers.satellite} onClick={() => setLayers(previous => ({ ...previous, satellite: true }))}><Globe2 size={15}/>{t('Satellite')}</button></div><Toggle label={t('Drainage network')} icon={Route} checked={layers.drainage} onChange={value => setLayers(previous => ({ ...previous, drainage: value }))}/><Toggle label={t('Contour lines')} icon={Mountain} checked={layers.contours} onChange={value => setLayers(previous => ({ ...previous, contours: value }))}/><Toggle label={t('Hillshade')} icon={Layers} checked={layers.hillshade} onChange={value => setLayers(previous => ({ ...previous, hillshade: value }))}/></section>
          <div className="map-style-selector analysis-mode-selector" role="group" aria-label={t('Analysis mode')}><button type="button" className={mode !== 'axis' ? 'active' : ''} aria-pressed={mode !== 'axis'} onClick={() => { setMode('point'); setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null); setProfiles([]); setProfilesOpen(false); setHoverPoint(null); }}><Layers size={15}/>{t('Watershed analysis')}</button><button type="button" className={mode === 'axis' ? 'active' : ''} aria-pressed={mode === 'axis'} onClick={() => { setMode('axis'); setFirstCorner(null); setAxisWaypoints([]); setAxisRoute(null); setAxisViewshed(null); setProfiles([]); setProfilesOpen(false); setNotice('Select the axis start point.'); }}><Route size={15}/>{t('Movement axis')}</button></div>{mode === 'axis' && <div className="axis-waypoint-controls"><p>{t('Select at least two points in order. The axis will pass through them and minimize elevation changes between each pair.')}</p><div><span>{t('{count} axis points selected', { count: axisWaypoints.length })}</span><IconButton icon={Undo2} label={t('Undo last axis point')} disabled={!axisWaypoints.length || loading} onClick={undoAxisWaypoint}/><button className="button button-primary" disabled={axisWaypoints.length < 2 || loading} onClick={finishAxis}>{loading ? t('Calculating movement axis…') : t('Calculate axis')}</button></div></div>}
          <div className="area-actions">{mode !== 'axis' && <button className="button button-secondary full" onClick={() => { setMode(mode === 'area' ? 'point' : 'area'); setFirstCorner(null); setAxisWaypoints([]); setAxisRoute(null); setNotice('Area of interest: choose two opposite corners.'); }}><Scan size={15}/>{t('Draw area of interest')}</button>}{aoi && <IconButton icon={X} label={t('Clear area of interest')} onClick={() => { setAoi(null); setAreaHydrology(null); }}/>}</div>
            {mode !== 'point' && !(mode === 'axis' && (axisRoute || loading)) && <div className="drawing-status"><span className="connection-dot"/>{t(mode === 'area' ? firstCorner ? 'Choose opposite corner' : 'Draw area of interest' : mode === 'axis' ? t('Select axis point {number}', { number: axisWaypoints.length + 1 }) : 'Choose profile endpoint')}<button onClick={() => { setMode('point'); setFirstCorner(null); setAxisWaypoints([]); setAxisRoute(null); }} aria-label={t('Cancel drawing')}><X size={14}/></button></div>}
          <section className="point-section">{selected ? <><div className="section-label"><span><MapPin size={14}/>{t('SELECTED POINT')}</span><span className="point-status">{t(loading ? 'Loading' : index >= 0 ? 'DEM verified' : 'Outside coverage')}</span></div>
            <h2>{t(pointName)}</h2><div className="coordinates" dir="ltr"><span>{selected[0].toFixed(5)}° N</span><span>{selected[1].toFixed(5)}° E</span><IconButton icon={Crosshair} label={t('Center on selected point')} onClick={() => mapRef.current.setView(selected, 12)}/></div>
            {loading ? <div className="loading-status"><LoaderCircle size={14} className="spin"/><span>{t(analysisPhase === 'calculating' ? 'Calculating watershed in background…' : 'Loading elevation tiles… {progress}%', { progress: format(progress * 100) })}</span></div> : index < 0 ? <button className="button button-primary full" onClick={() => fetchTerrain(selected, pointName, null, true)}><Download size={16}/>{t('Retry point analysis')}</button> : <p className="point-action-hint">{t(current ? 'Select another map point to analyze another watershed.' : 'The watershed will be calculated automatically when you select a point.')}</p>}
            {current?.partial && <p className="partial-catchment-notice" role="status">{t('The basin reaches the edge of available elevation data and is partial.')}</p>}
            {error && <div className="error-message" role="alert"><AlertTriangle size={17}/><span>{t(error)}<button onClick={() => fetchTerrain(selected, pointName, null, true)}>{t('Retry terrain download')}</button></span></div>}
          </> : <div className="clean-map-prompt"><Crosshair size={25} strokeWidth={1.4}/><h2>{t('Select a point on the map')}</h2><p>{t('Add its watershed and surrounding drainage divide to the map.')}</p></div>}
          </section>
          <div className="map-legend sidebar-legend"><span><i className="legend-area"/>{t('Watershed divide')}</span><span><i className="legend-river"/>{t('Streams')}</span><span><i className="legend-flow"/>{t('Downstream')}</span></div>
          <section className="cache-section"><div className="section-title"><h3><HardDrive size={16}/>{t('Local storage')}</h3><IconButton icon={cacheBusy ? LoaderCircle : Trash2} label={t('Clear local terrain cache')} disabled={loading || cacheBusy || !cacheInfo?.bytes} onClick={removeLocalCache}/></div><Toggle label={t('Cache terrain & watersheds')} icon={HardDrive} checked={localCache} disabled={loading || cacheBusy} onChange={value => { setLocalCache(value); setCacheEnabled(value); }}/><div className="cache-usage"><span>{t('{used} MB', { used: format((cacheInfo?.bytes || 0) / 1048576, 1) })}</span><span>{t('{limit} GB limit', { limit: format(MAX_CACHE_BYTES / 1073741824, 0) })}</span></div><progress aria-label={t('Local cache storage usage')} value={cacheInfo?.bytes || 0} max={MAX_CACHE_BYTES}/><div className="cache-counts">{t('{count} terrain areas', { count: format(cacheInfo?.models || 0) })} <span>·</span> {t('{count} watersheds', { count: format(cacheInfo?.watersheds || 0) })}</div><p>{t(cacheInfo?.available === false ? 'Browser storage unavailable. Analysis still works without caching.' : !localCache ? 'Cache disabled. Existing data stays stored until cleared.' : 'Saved on this device. Basemaps and new areas still need internet.')}</p></section>
        </div>
        <div className="sidebar-footer"><span className={`connection-dot ${loading ? 'loading' : ''}`}/><span>{loading ? t('Connecting to elevation data') : model ? t('Terrain grid · {resolution} m', { resolution: format(model.resolution) }) : t(selected ? 'Terrain data unavailable' : 'Ready to analyze')}</span><button title={t('Data sources and limitations')} aria-label={t('Data sources and limitations')} onClick={() => setModal('sources')}><Info size={15}/></button></div>
      </aside>
      <section className="map-workspace">
        <TerrainMap {...{ mapRef, model, selected, deletePromptId, hasAnalysis: Boolean(current), selectedAnalysisVisible: current?.visible !== false, results, activeId, pendingSnap, layers, hoverPoint, mode, aoi, areaHydrology, axisWaypoints, axisRoute, axisViewshed, language }} profiles={profilesOpen ? profiles : []} onSelect={selectPoint} onDraw={handleDraw} onOutletClick={point => { const outlet = pointIndex(model, ...point); calculate(outlet, point); }} onAnalysisNumberClick={id => { const analysis = results.find(item => item.id === id); if (!analysis) return; if (analysis.id !== activeId) activateAnalysis(analysis); setDeletePromptId(id); setSidebarOpen(true); setMobilePanelOpen(false); }} onDeleteAnalysis={() => deletePromptId && removeAnalysis(deletePromptId)} onDismissDelete={() => setDeletePromptId(null)}/>
        <div className="map-topbar"><div className="map-search"><form onSubmit={search}><Search size={18}/><input aria-label={t('Search a place or coordinates')} placeholder={t('Search a place or coordinates')} value={query} onChange={event => { setQuery(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={event => { if (event.key === 'Escape') setSearchOpen(false); }}/>{searching ? <LoaderCircle size={17} className="spin"/> : <kbd>↵</kbd>}</form>{searchOpen && <div className="search-results"><div className="search-heading">{t(query ? 'MATCHING PLACES' : 'EXPLORE THE REGION')}<button aria-label={t('Close search')} onClick={() => setSearchOpen(false)}><X size={14}/></button></div>{filteredPlaces.map(place => <button key={place.name} onClick={() => choosePlace(place)}><MapPin size={15}/><span>{t(place.name)}</span><ArrowUpRight size={13}/></button>)}<small>{t('Coordinates: latitude, longitude (WGS 84)')}</small></div>}</div></div>
        <div className="map-tools"><div className="tool-group zoom-tools"><IconButton icon={Plus} label={t('Zoom in')} onClick={() => mapRef.current.zoomIn()}/><IconButton icon={Minus} label={t('Zoom out')} onClick={() => mapRef.current.zoomOut()}/></div><div className="tool-group"><IconButton icon={LocateFixed} label={t('Go to selected point')} disabled={!selected} onClick={() => mapRef.current.setView(selected, 12)}/><IconButton icon={Maximize} label={t('Show Israel and neighbors')} onClick={() => mapRef.current.fitBounds(REGION_BOUNDS, { padding: [28, 28], maxZoom: 7 })}/></div></div>
        {mode !== 'point' && !(mode === 'axis' && (axisRoute || loading)) && <div className="drawing-status"><span className="connection-dot"/>{t(mode === 'area' ? firstCorner ? 'Choose opposite corner' : 'Draw area of interest' : mode === 'axis' ? t('Select axis point {number}', { number: axisWaypoints.length + 1 }) : 'Choose profile endpoint')}<button onClick={() => { setMode('point'); setFirstCorner(null); setAxisWaypoints([]); setAxisRoute(null); }} aria-label={t('Cancel drawing')}><X size={14}/></button></div>}
        {profilesOpen && profiles.length > 0 && <div className="map-bottom with-profiles"><div className="profiles-panel"><div className="profiles-header"><h3><Mountain size={17}/>{t(axisRoute ? 'Movement axis' : 'Elevation profiles')} <span>{axisRoute ? t('Least elevation change') : t('{count} transects', { count: profiles.length })}</span></h3><div><span className="profile-source">{format(model?.resolution)} {t('m')} DEM</span><IconButton icon={X} label={t('Close elevation profiles')} onClick={() => { setProfilesOpen(false); setHoverPoint(null); }}/></div></div>{axisRoute && <><div className="axis-metrics"><div><small>{t('Axis length')}</small><strong>{format(axisRoute.length / 1000, 2)} {t('km')}</strong></div><div><small>{t('Total ascent')}</small><strong>{format(axisRoute.ascent)} {t('m')}</strong></div><div><small>{t('Total descent')}</small><strong>{format(axisRoute.descent)} {t('m')}</strong></div></div><div className="viewshed-controls"><label htmlFor="viewshed-radius">{t('Visibility radius')}<output>{format(viewshedRadius / 1000, 2)} {t('km')}</output></label><input id="viewshed-radius" type="range" min="250" max="5000" step="250" value={viewshedRadius} onChange={event => setViewshedRadius(Number(event.target.value))}/><div className="viewshed-actions"><button className="button button-secondary" disabled={loading} onClick={calculateAxisViewshed}>{loading ? <LoaderCircle size={14} className="spin"/> : <Eye size={14}/>}<span>{t(axisViewshed ? 'Update visibility' : 'Calculate visibility')}</span></button>{axisViewshed && <IconButton icon={EyeOff} label={t('Hide visibility layer')} onClick={() => setAxisViewshed(null)}/>}</div>{axisViewshed && <><div className="viewshed-legend"><span className="viewshed-swatch"/><span>{t('Visible from route')} · {t('{count} visible cells', { count: format(axisViewshed.visibleCells) })}</span></div><small className="viewshed-assumption">{t('Observer height 1.7 m; route height 1.5 m.')}</small></>}{axisViewshed?.partial && <p className="viewshed-warning" role="status">{t('Visibility extends beyond available elevation coverage; the shaded result is partial.')}</p>}</div></>}<div className="profiles-grid">{profiles.map((profile, profileIndex) => <ProfileChart key={profileIndex} profile={profile} index={profileIndex} onHover={setHoverPoint} language={language}/>)}</div></div></div>}
        {notice && <div className="toast" role="status"><Info size={17}/><span>{t(notice)}</span><button aria-label={t('Dismiss message')} onClick={() => setNotice('')}><X size={15}/></button></div>}
      </section>
    </main>
    <footer className="app-footer"><span><span className="footer-logo"><AppMark size={13}/></span>{t('An open view of our shared landscape.')}</span><span>{t('Terrain analysis, not a flood forecast.')}<span className="footer-dot">·</span><button onClick={() => setModal('sources')}>{t('Sources & limitations')}</button></span></footer>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}>
      {modal === 'collections' ? <section className="modal collections-modal" role="dialog" aria-modal="true" aria-label={t('Saved collections')} onClick={event => event.stopPropagation()}>
        <div className="modal-heading"><span className="modal-icon"><FolderOpen size={24}/></span><IconButton icon={X} label={t('Close dialog')} onClick={() => setModal(null)}/></div>
        <h2>{t('Saved collections')}</h2><p>{t('Keep named groups of watersheds on this device. Terrain data remains in the separate local cache.')}</p>
        <form className="collection-save-form" onSubmit={saveCurrentCollection}><label htmlFor="collection-name">{t('Collection name')}</label><div><input id="collection-name" value={collectionName} maxLength={60} placeholder={t('Enter a name')} onChange={event => setCollectionName(event.target.value)}/><button className="button button-primary" type="submit" disabled={!results.length || !collectionName.trim() || collectionBusy}>{collectionBusy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}<span>{t('Save current basins')}</span></button></div>{!results.length && <small>{t('Calculate at least one watershed before saving.')}</small>}</form>
        {collectionError && <p className="collection-error" role="alert">{t(collectionError)}</p>}
        <div className="saved-collection-list">{savedCollections.length ? savedCollections.map(collection => <div className="saved-collection-row" key={collection.id}><button className="saved-collection-load" onClick={() => loadCollection(collection)}><strong>{collection.name}</strong><small>{t('{count} basins', { count: collection.analyses.length })} · {new Date(collection.savedAt).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')}</small></button><IconButton icon={Trash2} label={t('Delete collection {name}', { name: collection.name })} onClick={() => removeSavedCollection(collection.id)}/></div>) : <p className="analysis-empty">{t('No saved collections yet.')}</p>}</div>
      </section> : <section className="modal" role="dialog" aria-modal="true" aria-label={t('Data sources and limitations')} onClick={event => event.stopPropagation()}>
        <div className="modal-heading"><span className="modal-icon"><Globe2 size={24}/></span><IconButton icon={X} label={t('Close dialog')} onClick={() => setModal(null)}/></div>
          <h2>{t('The data behind the landscape.')}</h2><p>{t('Real DEM tiles cover roughly 25 × 25 km around each analysis point. Cached terrain is reused. No sample catchments are substituted.')}</p>
          <dl className="source-list">
            <div><dt>{t('Elevation model')}</dt><dd>{SOURCE}<small>{t('Terrarium tiles at zoom 12. Grid spacing here: approximately {resolution} m. Native resolution and accuracy vary.', { resolution: format(model?.resolution || 33) })}</small></dd></div>
            <div><dt>{t('Hydrology')}</dt><dd>{t('Local DEM analysis')}<small>{t('Depression filling, D8 flow direction and accumulation. Lakes, culverts, karst and engineered drainage are not modeled.')}</small></dd></div>
            <div><dt>{t('Basemap & imagery')}</dt><dd>Esri World Topographic / World Imagery<small>{t('Labels and boundaries follow the map provider. They do not express a political position.')}</small></dd></div>
            <div><dt>{t('Coverage limits')}</dt><dd>{t('Partial results are flagged')}<small>{t('Catchments and downstream paths stop at the DEM edge. Small wadis may be missed; profiles outside coverage have gaps.')}</small></dd></div>
            <div><dt>{t('Land cover')}</dt><dd>{t('Not included')}<small>{t('No validated, consistent classified land-cover dataset is bundled for this region.')}</small></dd></div>
          </dl><div className="source-warning"><Info size={18}/><span>{t('For exploration, not engineering design, flood warnings or navigation. Raster-derived boundaries are approximate.')}</span></div>
      </section>}
    </div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);