import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { buildModel, calculateTerrainAxis, delineate, delineateCached, exportCollection, makeProfile, indexPoint, snapPoint, hydrologyWithinBounds } from '../src/hydrology.js';
import { readCached, writeCached, clearCache, cacheStats, setCacheEnabled, MAX_CACHE_BYTES } from '../src/cache.js';
import { createTranslator } from '../src/i18n.js';
import { EMPTY_ANALYSES, createWatershedAnalysis, analysesReducer } from '../src/analyses.js';
import { deleteAnalysisCollection, listAnalysisCollections, saveAnalysisCollection } from '../src/collections.js';

const width = 32;
const terrain = Float32Array.from({ length: width * width }, (_, index) => 1000 - Math.floor(index / width) * 5 + Math.abs(index % width - 16) * 4);
const model = buildModel(terrain, width, width);

test('named analysis collections persist complete geometries without DEM flow arrays', async () => {
  const outlet = 20 * width + 16;
  const analysis = createWatershedAnalysis(delineate(model, outlet), { id: 'basin-a', number: 1, name: 'Upper Wadi', location: 'Jordan River', point: indexPoint(model, outlet), model });
  const saved = await saveAnalysisCollection('My catchments', [analysis]);
  const collections = await listAnalysisCollections();
  assert.equal(collections[0].id, saved.id);
  assert.equal(collections[0].name, 'My catchments');
  assert.equal(collections[0].analyses[0].name, 'Upper Wadi');
  assert.deepEqual(collections[0].analyses[0].boundary, analysis.boundary);
  assert.equal(collections[0].analyses[0].model, undefined);
  assert.equal(collections[0].analyses[0].mask, undefined);
  assert.equal(await deleteAnalysisCollection(saved.id), true);
  assert.equal((await listAnalysisCollections()).some(collection => collection.id === saved.id), false);
});

test('analyses start empty and retain independent watersheds from different DEM windows', () => {
  assert.equal(EMPTY_ANALYSES.items.length, 0);
  assert.equal(EMPTY_ANALYSES.activeId, null);
  const outlet = 20 * width + 16;
  const first = createWatershedAnalysis(delineate(model, outlet), { id: 'first', number: 1, name: 'First', point: indexPoint(model, outlet), model });
  const shiftedModel = { ...model, origin: [256, 256] };
  const second = createWatershedAnalysis(delineate(shiftedModel, outlet), { id: 'second', number: 2, name: 'Second', point: indexPoint(shiftedModel, outlet), model: shiftedModel });
  let state = analysesReducer(EMPTY_ANALYSES, { type: 'upsert', analysis: first });
  state = analysesReducer(state, { type: 'upsert', analysis: second });
  assert.equal(state.items.length, 2);
  assert.equal(state.activeId, 'second');
  assert.deepEqual(state.items[0].point, indexPoint(model, outlet));
  assert.notDeepEqual(state.items[0].point, state.items[1].point);
  assert.equal(state.items[0].model, model);
  assert.equal(state.items[1].model, shiftedModel);
  assert.equal(state.items[0].number, 1);
  state = analysesReducer(state, { type: 'visibility', id: 'first', visible: false });
  assert.equal(state.items.length, 2);
  assert.equal(state.activeId, 'second');
  assert.equal(state.items[0].visible, false);
  state = analysesReducer(state, { type: 'visibility', id: 'first', visible: true });
  assert.equal(state.items[0].visible, true);
  const restored = analysesReducer(state, { type: 'restore', items: [{ id: 'restored' }], activeId: null });
  assert.deepEqual(restored.items, [{ id: 'restored' }]);
  assert.equal(restored.activeId, null);
  const collection = exportCollection(state.items);
  assert.equal(collection.features.length, 6);
  assert.equal(collection.features[0].properties.analysis_id, 'first');
  assert.equal(collection.features[3].properties.analysis_number, 2);
  const remaining = analysesReducer(state, { type: 'remove', id: 'first' });
  assert.equal(exportCollection(remaining.items).features.length, 3);
  assert.equal(exportCollection(remaining.items).features[0].properties.analysis_id, 'second');
});

test('updating or snapping an analysis replaces only that stable ID', () => {
  const original = { id: 'first', point: [33, 35] };
  const other = { id: 'second', point: [34, 36] };
  let state = analysesReducer(EMPTY_ANALYSES, { type: 'upsert', analysis: original });
  state = analysesReducer(state, { type: 'upsert', analysis: other });
  state = analysesReducer(state, { type: 'upsert', analysis: { ...original, point: [33.001, 35.001] } });
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items[0].point, [33.001, 35.001]);
  assert.equal(state.items[1], other);
  assert.equal(state.activeId, 'first');
});

test('editable watershed names persist through updates, export, and unrelated removal', () => {
  const outlet = 20 * width + 16;
  const result = delineate(model, outlet);
  const analysis = createWatershedAnalysis(result, { id: 'named', number: 4, name: '', location: 'Jordan River', point: indexPoint(model, outlet), model });
  let state = analysesReducer(EMPTY_ANALYSES, { type: 'upsert', analysis });
  state = analysesReducer(state, { type: 'upsert', analysis: { ...analysis, id: 'other', number: 5, name: 'Lower Wadi' } });
  state = analysesReducer(state, { type: 'rename', id: 'named', name: '  North ridge basin  ' });
  assert.equal(state.items[0].name, 'North ridge basin  ');
  assert.equal(state.items[0].location, 'Jordan River');
  state = analysesReducer(state, { type: 'upsert', analysis: { ...state.items[0], elapsedMs: 42 } });
  const collection = exportCollection(state.items);
  assert.equal(collection.features[0].properties.analysis_name, 'North ridge basin');
  assert.deepEqual(collection.features[0].geometry, result.boundary.geometry);
  assert.equal(state.items[1].name, 'Lower Wadi');
  state = analysesReducer(state, { type: 'remove', id: 'other' });
  assert.equal(state.items[0].name, 'North ridge basin  ');
});

test('individual removal and clearing preserve unrelated analyses and do not mutate history', () => {
  let state = analysesReducer(EMPTY_ANALYSES, { type: 'upsert', analysis: { id: 'first' } });
  state = analysesReducer(state, { type: 'upsert', analysis: { id: 'second' } });
  const history = state;
  state = analysesReducer(state, { type: 'remove', id: 'second' });
  assert.equal(state.activeId, 'first');
  assert.deepEqual(state.items.map(item => item.id), ['first']);
  state = analysesReducer(state, { type: 'clear' });
  assert.deepEqual(state, { items: [], activeId: null });
  assert.equal(history.items.length, 2);
});

test('English and Hebrew translations preserve values and source names', () => {
  const english = createTranslator('en');
  const hebrew = createTranslator('he');
  assert.equal(english('Zoom out'), 'Zoom out');
  assert.equal(hebrew('Zoom out'), 'התרחקות');
  assert.equal(english('Use channel outlet · {distance} m', { distance: 287 }), 'Use channel outlet · 287 m');
  assert.equal(hebrew('Use channel outlet · {distance} m', { distance: 287 }), 'בחירת המוצא בערוץ · 287 מ׳');
  assert.equal(hebrew('Mapzen / AWS Terrain Tiles'), 'Mapzen / AWS Terrain Tiles');
  assert.ok(hebrew('Elevation data').length > 0);
  assert.equal(english('AGANIM | Israel & Neighbors'), 'AGANIM | Israel & Neighbors');
  assert.equal(hebrew('AGANIM | Israel & Neighbors'), 'AGANIM | ישראל והסביבה');
  assert.equal(hebrew('Analysis {number}', { number: 3 }), 'ניתוח 3');
  assert.equal(hebrew('Name watershed {number}', { number: 2 }), 'מתן שם לאגן 2');
});

test('a downstream catchment contains every upstream cell', () => {
  const upstreamIndex = 12 * width + 16;
  const downstreamIndex = model.flow[model.flow[upstreamIndex]];
  const upstream = delineate(model, upstreamIndex);
  const downstream = delineate(model, downstreamIndex);
  assert.ok(downstream.count > upstream.count);
  upstream.mask.forEach((value, index) => { if (value) assert.equal(downstream.mask[index], 1); });
});

test('boundaries are closed GeoJSON rings and exports include drainage', () => {
  const result = delineate(model, 20 * width + 16);
  const collection = JSON.parse(JSON.stringify(exportCollection([result])));
  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features[0].geometry.type, 'MultiPolygon');
  for (const polygon of result.boundary.geometry.coordinates) for (const ring of polygon) assert.deepEqual(ring[0], ring.at(-1));
  assert.equal(collection.features[1].geometry.type, 'MultiLineString');
  assert.ok(result.maximum >= result.minimum);
});

test('edge-reaching watersheds are marked partial', () => {
  assert.equal(delineate(model, 31 * width + 16).partial, true);
});

test('area hydrology produces streams and terrain divides, and flags incomplete DEM coverage', async () => {
  const first = indexPoint(model, 0);
  const last = indexPoint(model, width * width - 1);
  const bounds = [first, last];
  const hydrology = await hydrologyWithinBounds(model, bounds, 1);
  assert.equal(hydrology.streams.properties.kind, 'streams');
  assert.equal(hydrology.divides.properties.kind, 'watershed_divides');
  assert.ok(hydrology.streams.geometry.coordinates.length > 0);
  assert.ok(hydrology.divides.geometry.coordinates.length > 0);
  assert.equal(hydrology.partial, false);
  assert.equal((await hydrologyWithinBounds(model, [[-85, -180], [85, 180]], 1)).partial, true);
});

test('profiles cross the chosen point and snapping does not change it', () => {
  const outlet = 12 * width + 16;
  const point = indexPoint(model, outlet);
  const first = makeProfile(model, point, 0, 500);
  const second = makeProfile(model, point, 90, 500);
  assert.deepEqual(first.samples[60].point, point);
  assert.deepEqual(second.samples[60].point, point);
  const original = [...point];
  snapPoint(model, outlet);
  assert.deepEqual(point, original);
});

test('terrain axis returns an endpoint-to-endpoint route and elevation profile metrics', () => {
  const start = indexPoint(model, 10 * width + 8);
  const end = indexPoint(model, 10 * width + 23);
  const axis = calculateTerrainAxis(model, start, end);
  assert.deepEqual(axis.path[0], start);
  assert.deepEqual(axis.path.at(-1), end);
  assert.equal(axis.samples.length, 121);
  assert.equal(axis.samples[0].point[0], start[0]);
  assert.equal(axis.samples.at(-1).point[1], end[1]);
  assert.ok(axis.length > 0);
  assert.ok(axis.ascent >= 0);
  assert.ok(axis.descent >= 0);
  assert.equal(axis.totalVariation, axis.ascent + axis.descent);
});

test('terrain axis routes around a steep ridge to minimize elevation change', () => {
  const width = 9;
  const height = 7;
  const elevations = new Float32Array(width * height);
  for (let row = 1; row < height - 1; row++) elevations[row * width + 4] = 1;
  const routeModel = { width, height, origin: [256, 256], resolution: 10, elevations };
  const start = indexPoint(routeModel, 3 * width + 1);
  const end = indexPoint(routeModel, 3 * width + 7);
  const axis = calculateTerrainAxis(routeModel, start, end);
  assert.equal(axis.ascent + axis.descent, 0);
  assert.ok(axis.length > Math.hypot(end[0] - start[0], end[1] - start[1]) * 111320 * Math.cos(start[0] * Math.PI / 180));
  assert.equal(axis.partial, true);
  assert.ok(axis.path.every(point => point[0] !== undefined));
});

test('persistent cache preserves typed DEM models and watershed geometry', async () => {
  setCacheEnabled(true);
  await clearCache();
  const result = delineate(model, 20 * width + 16);
  assert.equal(await writeCached('model:test', model, 'model', terrain.byteLength), true);
  assert.equal(await writeCached('watershed:test', result, 'watershed', 1024), true);
  const restoredModel = await readCached('model:test');
  assert.ok(restoredModel.elevations instanceof Float32Array);
  assert.deepEqual(restoredModel.flow, model.flow);
  assert.deepEqual((await readCached('watershed:test')).boundary, result.boundary);
  assert.equal((await cacheStats()).models, 1);
});

test('cache can be disabled, cleared, and bounded by least-recently-used eviction', async () => {
  await clearCache();
  await writeCached('first', { value: 1 }, 'tile', MAX_CACHE_BYTES * 0.6);
  await writeCached('second', { value: 2 }, 'tile', MAX_CACHE_BYTES * 0.6);
  assert.equal(await readCached('first'), null);
  assert.deepEqual(await readCached('second'), { value: 2 });
  assert.ok((await cacheStats()).bytes <= MAX_CACHE_BYTES);
  setCacheEnabled(false);
  assert.equal(await readCached('second'), null);
  assert.equal(await writeCached('disabled', {}, 'tile', 10), false);
  setCacheEnabled(true);
  assert.deepEqual(await readCached('second'), { value: 2 });
  await clearCache();
  assert.equal((await cacheStats()).bytes, 0);
});

test('repeated outlet analysis reuses the saved watershed exactly', async () => {
  await clearCache();
  const keyedModel = { ...model, key: 'synthetic-model' };
  const first = await delineateCached(keyedModel, 20 * width + 16);
  const repeated = await delineateCached(keyedModel, 20 * width + 16);
  assert.equal(first.cacheHit, false);
  assert.equal(repeated.cacheHit, true);
  assert.deepEqual(repeated.boundary, first.boundary);
  assert.deepEqual(repeated.channels, first.channels);
  assert.deepEqual(repeated.mask, first.mask);
  assert.throws(() => delineate(model, -1), /outside terrain coverage/);
  await clearCache();
});

test('unavailable browser storage does not prevent terrain computation', async () => {
  const original = globalThis.indexedDB;
  try {
    globalThis.indexedDB = undefined;
    assert.equal(await readCached('unavailable'), null);
    assert.equal(await writeCached('unavailable', {}, 'tile', 10), false);
    assert.equal((await cacheStats()).available, false);
    assert.ok((await delineateCached(model, 20 * width + 16)).count > 0);
  } finally { globalThis.indexedDB = original; }
  assert.equal(await writeCached('recovered', { value: 1 }, 'tile', 10), true);
  assert.deepEqual(await readCached('recovered'), { value: 1 });
  await clearCache();
});