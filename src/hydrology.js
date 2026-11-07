import { contours } from 'd3-contour';
import { readCached, writeCached } from './cache.js';

export const SOURCE = 'Mapzen / AWS Terrain Tiles';
export const ZOOM = 12;
const TILE = 256;
const OFFSETS = [[-1,-1], [0,-1], [1,-1], [-1,0], [1,0], [-1,1], [0,1], [1,1]];

export function project(lat, lng, zoom = ZOOM) {
  const scale = TILE * 2 ** zoom;
  const sine = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * scale, (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale];
}

export function unproject(x, y, zoom = ZOOM) {
  const scale = TILE * 2 ** zoom;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI, x / scale * 360 - 180];
}

class MinHeap {
  items = [];
  push(item) {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent][0] <= item[0]) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1][0] < this.items[child][0]) child++;
        if (this.items[child][0] >= last[0]) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

export function buildModel(elevations, width, height, origin = [0, 0], latitude = 30.83) {
  const size = width * height;
  const filled = Float64Array.from(elevations);
  const visited = new Uint8Array(size);
  const heap = new MinHeap();
  const seed = index => {
    if (visited[index]) return;
    visited[index] = 1;
    heap.push([filled[index], index]);
  };
  for (let column = 0; column < width; column++) { seed(column); seed((height - 1) * width + column); }
  for (let row = 0; row < height; row++) { seed(row * width); seed(row * width + width - 1); }
  while (heap.items.length) {
    const [level, index] = heap.pop();
    const column = index % width;
    const row = Math.floor(index / width);
    for (const [dx, dy] of OFFSETS) {
      const nextX = column + dx;
      const nextY = row + dy;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const next = nextY * width + nextX;
      if (visited[next]) continue;
      visited[next] = 1;
      filled[next] = Math.max(filled[next], level + 0.001);
      heap.push([filled[next], next]);
    }
  }
  const flow = new Int32Array(size).fill(-1);
  const firstChild = new Int32Array(size).fill(-1);
  const nextSibling = new Int32Array(size).fill(-1);
  const incoming = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    const column = index % width;
    const row = Math.floor(index / width);
    let bestSlope = 0;
    for (const [dx, dy] of OFFSETS) {
      const nextX = column + dx;
      const nextY = row + dy;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const next = nextY * width + nextX;
      const slope = (filled[index] - filled[next]) / Math.hypot(dx, dy);
      if (slope > bestSlope) { bestSlope = slope; flow[index] = next; }
    }
    const next = flow[index];
    if (next >= 0) {
      incoming[next]++;
      nextSibling[index] = firstChild[next];
      firstChild[next] = index;
    }
  }
  const accumulation = new Uint32Array(size).fill(1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < size; index++) if (!incoming[index]) queue[tail++] = index;
  while (head < tail) {
    const index = queue[head++];
    const next = flow[index];
    if (next >= 0) {
      accumulation[next] += accumulation[index];
      if (--incoming[next] === 0) queue[tail++] = next;
    }
  }
  const resolution = Math.cos(latitude * Math.PI / 180) * 40075016.686 / (TILE * 2 ** ZOOM);
  return { elevations, width, height, origin, resolution, flow, firstChild, nextSibling, accumulation };
}

export async function loadModel(lat, lng, onProgress = () => {}, windowTiles = 3) {
  if (!Number.isInteger(windowTiles) || windowTiles < 3 || windowTiles % 2 === 0) throw new RangeError('Terrain window must use an odd number of tiles, at least 3');
  const [pixelX, pixelY] = project(lat, lng);
  const radius = Math.floor(windowTiles / 2);
  const tileX = Math.floor(pixelX / TILE) - radius;
  const tileY = Math.floor(pixelY / TILE) - radius;
  const key = windowTiles === 3 ? `model:${ZOOM}:${tileX}:${tileY}` : `model:${ZOOM}:${tileX}:${tileY}:${windowTiles}`;
  const tileCount = windowTiles * windowTiles;
  const cached = await readCached(key);
  if (cached) { onProgress(1); return { ...cached, windowTiles, cache: { source: 'local', saved: true, tilesLocal: tileCount, tilesDownloaded: 0 } }; }
  const width = TILE * windowTiles;
  const elevations = new Float32Array(width * width);
  let completed = 0;
  let tilesLocal = 0;
  await Promise.all(Array.from({ length: tileCount }, async (_, tileIndex) => {
    const column = tileIndex % windowTiles;
    const row = Math.floor(tileIndex / windowTiles);
    const tileKey = `tile:${ZOOM}:${tileX + column}:${tileY + row}`;
    let tile = await readCached(tileKey);
    if (tile) tilesLocal++;
    else {
      const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${tileX + column}/${tileY + row}.png`, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error('DEM download failed');
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE, TILE) : document.createElement('canvas');
      canvas.width = TILE;
      canvas.height = TILE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, TILE, TILE).data;
      tile = new Float32Array(TILE * TILE);
      for (let index = 0; index < TILE * TILE; index++) {
        if (pixels[index * 4 + 3] === 0) { bitmap.close(); throw new Error('DEM coverage unavailable'); }
        tile[index] = pixels[index * 4] * 256 + pixels[index * 4 + 1] + pixels[index * 4 + 2] / 256 - 32768;
      }
      bitmap.close();
      await writeCached(tileKey, tile, 'tile', tile.byteLength);
    }
    for (let tileRow = 0; tileRow < TILE; tileRow++) elevations.set(tile.subarray(tileRow * TILE, (tileRow + 1) * TILE), (row * TILE + tileRow) * width + column * TILE);
    onProgress(++completed / tileCount);
  }));
  const centerLatitude = unproject((tileX + windowTiles / 2) * TILE, (tileY + windowTiles / 2) * TILE)[0];
  const model = { ...buildModel(elevations, width, width, [tileX * TILE, tileY * TILE], centerLatitude), key, windowTiles };
  const bytes = Object.values(model).reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 256);
  const saved = await writeCached(key, model, 'model', bytes);
  return { ...model, cache: { source: tilesLocal === tileCount ? 'local tiles' : 'download', saved, tilesLocal, tilesDownloaded: tileCount - tilesLocal } };
}

export function pointIndex(model, lat, lng) {
  const [pixelX, pixelY] = project(lat, lng);
  const column = Math.floor(pixelX - model.origin[0]);
  const row = Math.floor(pixelY - model.origin[1]);
  return column >= 0 && row >= 0 && column < model.width && row < model.height ? row * model.width + column : -1;
}

export function indexPoint(model, index) {
  return unproject(model.origin[0] + index % model.width + 0.5, model.origin[1] + Math.floor(index / model.width) + 0.5);
}

export function calculateTerrainAxis(model, startPoint, endPoint, onProgress = () => {}) {
  const start = pointIndex(model, ...startPoint);
  const end = pointIndex(model, ...endPoint);
  if (start < 0 || end < 0) throw new RangeError('Axis endpoints must be inside the loaded terrain');
  if (start === end) throw new RangeError('Axis endpoints must be different');

  const size = model.width * model.height;
  const distances = new Float64Array(size).fill(Infinity);
  const previous = new Int32Array(size).fill(-1);
  const settled = new Uint8Array(size);
  const queue = new MinHeap();
  const targetColumn = end % model.width;
  const targetRow = Math.floor(end / model.width);
  const distanceWeight = 1e-8;
  const heuristic = index => Math.hypot(index % model.width - targetColumn, Math.floor(index / model.width) - targetRow) * model.resolution * distanceWeight;
  distances[start] = 0;
  queue.push([heuristic(start), start, 0]);
  let visited = 0;

  while (queue.items.length) {
    const [, index, costAtInsert] = queue.pop();
    if (settled[index] || costAtInsert !== distances[index]) continue;
    if (index === end) break;
    settled[index] = 1;
    visited++;
    const column = index % model.width;
    const row = Math.floor(index / model.width);
    for (const [dx, dy] of OFFSETS) {
      const nextX = column + dx;
      const nextY = row + dy;
      if (nextX < 0 || nextY < 0 || nextX >= model.width || nextY >= model.height) continue;
      const next = nextY * model.width + nextX;
      if (settled[next]) continue;
      const horizontal = Math.hypot(dx, dy) * model.resolution;
      const elevationChange = Math.abs(model.elevations[next] - model.elevations[index]);
      const nextCost = costAtInsert + elevationChange + horizontal * distanceWeight;
      if (nextCost >= distances[next]) continue;
      distances[next] = nextCost;
      previous[next] = index;
      queue.push([nextCost + heuristic(next), next, nextCost]);
    }
    if ((visited & 8191) === 0) onProgress(visited / size);
  }
  if (start !== end && previous[end] < 0) throw new Error('No terrain route connects the selected endpoints');

  const indices = [];
  for (let index = end; index !== -1; index = previous[index]) {
    indices.push(index);
    if (index === start) break;
  }
  if (indices.at(-1) !== start) throw new Error('Could not reconstruct the terrain route');
  indices.reverse();

  const path = indices.map(index => indexPoint(model, index));
  const cumulative = new Float64Array(indices.length);
  let ascent = 0;
  let descent = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let partial = false;
  for (let index = 0; index < indices.length; index++) {
    const cell = indices[index];
    const column = cell % model.width;
    const row = Math.floor(cell / model.width);
    const elevation = model.elevations[cell];
    minimum = Math.min(minimum, elevation);
    maximum = Math.max(maximum, elevation);
    if (column === 0 || row === 0 || column === model.width - 1 || row === model.height - 1) partial = true;
    if (index === 0) continue;
    const previousCell = indices[index - 1];
    const previousElevation = model.elevations[previousCell];
    const change = elevation - previousElevation;
    if (change > 0) ascent += change;
    else descent -= change;
    const distance = Math.hypot(column - previousCell % model.width, row - Math.floor(previousCell / model.width)) * model.resolution;
    cumulative[index] = cumulative[index - 1] + distance;
  }

  const length = cumulative.at(-1) || 0;
  let segment = 0;
  const samples = Array.from({ length: 121 }, (_, sampleIndex) => {
    const distance = length * sampleIndex / 120;
    while (segment < cumulative.length - 2 && cumulative[segment + 1] < distance) segment++;
    const span = cumulative[segment + 1] - cumulative[segment];
    const fraction = span > 0 ? (distance - cumulative[segment]) / span : 0;
    const first = indices[segment];
    const second = indices[Math.min(segment + 1, indices.length - 1)];
    const firstPoint = indexPoint(model, first);
    const secondPoint = indexPoint(model, second);
    return {
      distance,
      elevation: model.elevations[first] + (model.elevations[second] - model.elevations[first]) * fraction,
      point: [firstPoint[0] + (secondPoint[0] - firstPoint[0]) * fraction, firstPoint[1] + (secondPoint[1] - firstPoint[1]) * fraction],
    };
  });
  const north = (path.at(-1)[0] - path[0][0]) * 111320;
  const east = (path.at(-1)[1] - path[0][1]) * 111320 * Math.cos(path[0][0] * Math.PI / 180);
  const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  return { path, samples, length, ascent, descent, minimum, maximum, totalVariation: ascent + descent, bearing, partial, visited };
}

export function calculateTerrainAxisThroughPoints(model, waypoints, onProgress = () => {}) {
  if (waypoints.length < 2) throw new RangeError('A movement axis needs at least two waypoints');
  const segments = [];
  for (let index = 0; index < waypoints.length - 1; index++) {
    segments.push(calculateTerrainAxis(model, waypoints[index], waypoints[index + 1], progress => onProgress((index + progress) / (waypoints.length - 1))));
    onProgress((index + 1) / (waypoints.length - 1));
  }

  const path = [];
  const rawSamples = [];
  let length = 0;
  let ascent = 0;
  let descent = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let visited = 0;
  for (const [segmentIndex, segment] of segments.entries()) {
    path.push(...segment.path.slice(segmentIndex ? 1 : 0));
    rawSamples.push(...segment.samples.slice(segmentIndex ? 1 : 0).map(sample => ({ ...sample, distance: sample.distance + length })));
    length += segment.length;
    ascent += segment.ascent;
    descent += segment.descent;
    minimum = Math.min(minimum, segment.minimum);
    maximum = Math.max(maximum, segment.maximum);
    visited += segment.visited;
  }

  let sampleIndex = 0;
  const samples = Array.from({ length: 121 }, (_, index) => {
    const distance = length * index / 120;
    while (sampleIndex < rawSamples.length - 2 && rawSamples[sampleIndex + 1].distance < distance) sampleIndex++;
    const first = rawSamples[sampleIndex];
    const second = rawSamples[Math.min(sampleIndex + 1, rawSamples.length - 1)];
    const fraction = second.distance > first.distance ? (distance - first.distance) / (second.distance - first.distance) : 0;
    return {
      distance,
      elevation: first.elevation + (second.elevation - first.elevation) * fraction,
      point: [first.point[0] + (second.point[0] - first.point[0]) * fraction, first.point[1] + (second.point[1] - first.point[1]) * fraction],
    };
  });
  const north = (path.at(-1)[0] - path[0][0]) * 111320;
  const east = (path.at(-1)[1] - path[0][1]) * 111320 * Math.cos(path[0][0] * Math.PI / 180);
  const bearing = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  return { path, samples, length, ascent, descent, minimum, maximum, totalVariation: ascent + descent, bearing, partial: segments.some(segment => segment.partial), visited };
}

export function routeViewshed(model, routeSamples, radiusMeters, onProgress = () => {}, observerHeight = 1.7, targetHeight = 1.5) {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) throw new RangeError('Viewshed radius must be positive');
  const targets = [];
  const sampleStride = Math.max(1, Math.ceil(routeSamples.length / 61));
  for (let index = 0; index < routeSamples.length; index += sampleStride) {
    const sample = routeSamples[index];
    const cell = pointIndex(model, ...sample.point);
    if (cell >= 0) targets.push({ cell, column: cell % model.width, row: Math.floor(cell / model.width) });
  }
  const lastSample = routeSamples.at(-1);
  const lastCell = lastSample && pointIndex(model, ...lastSample.point);
  if (lastCell >= 0 && targets.at(-1)?.cell !== lastCell) targets.push({ cell: lastCell, column: lastCell % model.width, row: Math.floor(lastCell / model.width) });
  if (!targets.length) throw new RangeError('The route has no samples inside terrain coverage');

  const radiusCells = Math.ceil(radiusMeters / model.resolution);
  const rawMinColumn = Math.min(...targets.map(target => target.column)) - radiusCells;
  const rawMaxColumn = Math.max(...targets.map(target => target.column)) + radiusCells;
  const rawMinRow = Math.min(...targets.map(target => target.row)) - radiusCells;
  const rawMaxRow = Math.max(...targets.map(target => target.row)) + radiusCells;
  const minColumn = Math.max(0, rawMinColumn);
  const maxColumn = Math.min(model.width - 1, rawMaxColumn);
  const minRow = Math.max(0, rawMinRow);
  const maxRow = Math.min(model.height - 1, rawMaxRow);
  const radiusSquared = radiusCells ** 2;
  const targetBins = new Map();
  for (const target of targets) {
    const key = `${Math.floor(target.column / radiusCells)}:${Math.floor(target.row / radiusCells)}`;
    const bin = targetBins.get(key) || [];
    bin.push(target);
    targetBins.set(key, bin);
  }
  const mask = new Uint8Array(model.width * model.height);
  let visibleCells = 0;
  let candidateCells = 0;
  const rowCount = maxRow - minRow + 1;

  for (let row = minRow; row <= maxRow; row++) {
    if ((row & 15) === 0) onProgress((row - minRow) / rowCount);
    for (let column = minColumn; column <= maxColumn; column++) {
      const binColumn = Math.floor(column / radiusCells);
      const binRow = Math.floor(row / radiusCells);
      const nearbyTargets = [];
      for (let targetBinRow = binRow - 1; targetBinRow <= binRow + 1; targetBinRow++) {
        for (let targetBinColumn = binColumn - 1; targetBinColumn <= binColumn + 1; targetBinColumn++) {
          const bin = targetBins.get(`${targetBinColumn}:${targetBinRow}`);
          if (!bin) continue;
          for (const target of bin) {
            const distance = (column - target.column) ** 2 + (row - target.row) ** 2;
            if (distance <= radiusSquared) nearbyTargets.push({ target, distance });
          }
        }
      }
      if (!nearbyTargets.length) continue;
      nearbyTargets.sort((first, second) => first.distance - second.distance);
      candidateCells++;
      const sourceIndex = row * model.width + column;
      const sourceElevation = model.elevations[sourceIndex] + observerHeight;
      let visible = false;
      for (const { target } of nearbyTargets) {
        const dx = target.column - column;
        const dy = target.row - row;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        const destinationElevation = model.elevations[target.cell] + targetHeight;
        let blocked = false;
        for (let step = 1; step < steps; step++) {
          const x = Math.round(column + dx * step / steps);
          const y = Math.round(row + dy * step / steps);
          const terrainIndex = y * model.width + x;
          const sightElevation = sourceElevation + (destinationElevation - sourceElevation) * step / steps;
          if (model.elevations[terrainIndex] > sightElevation + 0.5) { blocked = true; break; }
        }
        if (!blocked) { visible = true; break; }
      }
      if (visible) { mask[sourceIndex] = 1; visibleCells++; }
    }
  }
  onProgress(1);
  return {
    mask,
    width: model.width,
    height: model.height,
    origin: model.origin,
    visibleCells,
    candidateCells,
    radiusMeters,
    partial: rawMinColumn < 0 || rawMaxColumn >= model.width || rawMinRow < 0 || rawMaxRow >= model.height,
  };
}

function networkWithinBounds(model, bounds, threshold, kind) {
  const [first, second] = bounds;
  const south = Math.min(first[0], second[0]);
  const north = Math.max(first[0], second[0]);
  const west = Math.min(first[1], second[1]);
  const east = Math.max(first[1], second[1]);
  const selected = new Uint8Array(model.flow.length);
  const incoming = new Uint8Array(model.flow.length);
  for (let index = 0; index < selected.length; index++) {
    if (model.accumulation[index] < threshold) continue;
    const [lat, lng] = indexPoint(model, index);
    if (lat >= south && lat <= north && lng >= west && lng <= east) selected[index] = 1;
  }
  for (let index = 0; index < selected.length; index++) {
    const next = model.flow[index];
    if (selected[index] && next >= 0 && selected[next]) incoming[next]++;
  }
  const visited = new Uint8Array(model.flow.length);
  const lines = [];
  for (let start = 0; start < selected.length; start++) {
    if (!selected[start] || visited[start] || incoming[start] === 1) continue;
    const path = [start];
    visited[start] = 1;
    let current = start;
    while (model.flow[current] >= 0) {
      const next = model.flow[current];
      if (!selected[next]) break;
      path.push(next);
      if (incoming[next] !== 1 || visited[next]) break;
      visited[next] = 1;
      current = next;
    }
    if (path.length > 1) lines.push(path.map(index => indexPoint(model, index).reverse()));
  }
  for (let start = 0; start < selected.length; start++) {
    if (!selected[start] || visited[start]) continue;
    const path = [start];
    visited[start] = 1;
    let current = start;
    while (model.flow[current] >= 0 && selected[model.flow[current]] && !visited[model.flow[current]]) {
      current = model.flow[current];
      visited[current] = 1;
      path.push(current);
    }
    if (path.length > 1) lines.push(path.map(index => indexPoint(model, index).reverse()));
  }
  return { type: 'Feature', properties: { kind, source: SOURCE, min_accumulation_cells: threshold }, geometry: { type: 'MultiLineString', coordinates: lines } };
}

export async function hydrologyWithinBounds(model, bounds, threshold = 120) {
  let dividesModel = null;
  const inverseKey = model.key ? `inverse-flow:${model.key}` : null;
  if (inverseKey) dividesModel = await readCached(inverseKey);
  if (!dividesModel) {
    const inverted = Float32Array.from(model.elevations, elevation => -elevation);
    const inverse = buildModel(inverted, model.width, model.height, model.origin);
    dividesModel = { flow: inverse.flow, accumulation: inverse.accumulation, width: inverse.width, height: inverse.height, origin: inverse.origin, resolution: model.resolution };
    if (inverseKey) {
      const bytes = dividesModel.flow.byteLength + dividesModel.accumulation.byteLength + 128;
      await writeCached(inverseKey, dividesModel, 'model', bytes);
    }
  }
  return {
    streams: networkWithinBounds(model, bounds, threshold, 'streams'),
    divides: networkWithinBounds(dividesModel, bounds, threshold, 'watershed_divides'),
    partial: bounds.some(([lat, lng]) => pointIndex(model, lat, lng) < 0),
    resolution: model.resolution,
  };
}

export function snapPoint(model, index, radius = 650) {
  const cellRadius = Math.ceil(radius / model.resolution);
  const column = index % model.width;
  const row = Math.floor(index / model.width);
  let best = index;
  let score = 0;
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const nextX = column + dx;
      const nextY = row + dy;
      const distance = Math.hypot(dx, dy) * model.resolution;
      if (distance > radius || nextX < 0 || nextY < 0 || nextX >= model.width || nextY >= model.height) continue;
      const next = nextY * model.width + nextX;
      const candidate = model.accumulation[next] / (1 + distance / 90);
      if (model.accumulation[next] > 160 && candidate > score) { best = next; score = candidate; }
    }
  }
  const distance = Math.hypot(best % model.width - column, Math.floor(best / model.width) - row) * model.resolution;
  return { index: best, point: indexPoint(model, best), distance };
}

export function delineate(model, outlet) {
  if (!Number.isInteger(outlet) || outlet < 0 || outlet >= model.width * model.height) throw new RangeError('Outlet is outside terrain coverage');
  const { width, height } = model;
  const mask = new Uint8Array(width * height);
  const stack = [outlet];
  let count = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let partial = false;
  while (stack.length) {
    const index = stack.pop();
    mask[index] = 1;
    count++;
    minimum = Math.min(minimum, model.elevations[index]);
    maximum = Math.max(maximum, model.elevations[index]);
    const column = index % width;
    const row = Math.floor(index / width);
    if (column === 0 || row === 0 || column === width - 1 || row === height - 1) partial = true;
    for (let child = model.firstChild[index]; child >= 0; child = model.nextSibling[child]) stack.push(child);
  }
  const shape = contours().size([width, height]).thresholds([0.5])(mask)[0];
  const coordinates = shape.coordinates.map(polygon => polygon.map(ring => ring.map(([column, row]) => {
    const [lat, lng] = unproject(model.origin[0] + column, model.origin[1] + row);
    return [lng, lat];
  })));
  const channels = [];
  const threshold = Math.max(50, Math.min(350, Math.round(count / 70)));
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || model.accumulation[index] < threshold) continue;
    const next = model.flow[index];
    if (next >= 0 && mask[next]) channels.push([indexPoint(model, index).reverse(), indexPoint(model, next).reverse()]);
  }
  const downstream = [];
  for (let index = outlet; index >= 0 && downstream.length < width * height; index = model.flow[index]) downstream.push(indexPoint(model, index).reverse());
  return { outlet, mask, count, area: count * model.resolution ** 2 / 1e6, minimum, maximum, relief: maximum - minimum, partial,
    boundary: { type: 'Feature', properties: { kind: 'watershed', source: SOURCE, resolution_m: model.resolution, area_km2: count * model.resolution ** 2 / 1e6, partial }, geometry: { type: 'MultiPolygon', coordinates } },
    channels: { type: 'Feature', properties: { kind: 'drainage', source: SOURCE }, geometry: { type: 'MultiLineString', coordinates: channels } },
    downstream: { type: 'Feature', properties: { kind: 'downstream', partial: true }, geometry: { type: 'LineString', coordinates: downstream.length > 1 ? downstream : [downstream[0], downstream[0]] } }
  };
}

export async function delineateCached(model, outlet) {
  const key = model.key ? `watershed:${model.key}:${outlet}` : null;
  const cached = key ? await readCached(key) : null;
  if (cached) return { ...cached, cacheHit: true };
  const result = delineate(model, outlet);
  if (key) {
    const bytes = result.mask.byteLength + JSON.stringify([result.boundary, result.channels, result.downstream]).length * 2 + 512;
    await writeCached(key, result, 'watershed', bytes);
  }
  return { ...result, cacheHit: false };
}

export function makeProfile(model, point, bearing = 0, length = 5000) {
  const radians = bearing * Math.PI / 180;
  const samples = Array.from({ length: 121 }, (_, index) => {
    const offset = (index / 120 - 0.5) * length;
    const lat = point[0] + Math.cos(radians) * offset / 111320;
    const lng = point[1] + Math.sin(radians) * offset / (111320 * Math.cos(point[0] * Math.PI / 180));
    const cell = pointIndex(model, lat, lng);
    return { distance: index / 120 * length, elevation: cell < 0 ? null : model.elevations[cell], point: [lat, lng] };
  });
  return { bearing, length, samples };
}

export function exportCollection(results) {
  return { type: 'FeatureCollection', features: results.flatMap((result, index) => [result.boundary, result.channels, result.downstream].map(feature => ({ ...feature, properties: { ...feature.properties, watershed: index + 1, ...(result.id ? { analysis_id: result.id, analysis_number: result.number, analysis_name: result.name?.trim() || null, analysis_type: result.type } : {}) } }))) };
}