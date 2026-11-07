import { calculateTerrainAxis, loadModel, pointIndex, project, snapPoint, delineateCached, hydrologyWithinBounds, ZOOM } from './hydrology.js';
import { setCacheEnabled } from './cache.js';

self.onmessage = async ({ data: { id, type, ...options } }) => {
  try {
    setCacheEnabled(options.cacheEnabled);
    if (type === 'calculate') {
      const result = await delineateCached(options.model, options.outlet);
      self.postMessage({ id, value: { result } });
      return;
    }
    if (type === 'area-hydrology') {
      const model = options.model || await loadModel(...options.point, progress => self.postMessage({ id, progress, phase: progress === 1 ? 'calculating' : 'loading' }));
      self.postMessage({ id, progress: 1, phase: 'calculating' });
      const hydrology = await hydrologyWithinBounds(model, options.bounds);
      self.postMessage({ id, value: { hydrology } });
      return;
    }
    if (type === 'inspect-point') {
      const model = options.model || await loadModel(...options.point, progress => self.postMessage({ id, progress, phase: 'loading' }));
      const index = pointIndex(model, ...options.point);
      if (index < 0) throw new Error('Selected point is outside terrain coverage');
      const proposed = snapPoint(model, index);
      self.postMessage({ id, value: { model: options.model ? null : model, point: options.point, proposed } });
      return;
    }
    if (type === 'terrain-axis') {
      const midpoint = [(options.start[0] + options.end[0]) / 2, (options.start[1] + options.end[1]) / 2];
      const centerTile = project(...midpoint).map(pixel => Math.floor(pixel / 256));
      const endpointTiles = [options.start, options.end].map(point => project(...point).map(pixel => Math.floor(pixel / 256)));
      const radius = Math.max(...endpointTiles.flatMap(([x, y]) => [Math.abs(x - centerTile[0]), Math.abs(y - centerTile[1])]));
      const requiredWindow = Math.max(3, radius * 2 + 1);
      const firstWindow = Math.max(requiredWindow, options.model?.windowTiles || 3);
      if (firstWindow > 7) throw new Error('The selected endpoints are farther apart than the available terrain window supports.');
      const windowSizes = [3, 5, 7].filter(size => size >= firstWindow);
      let model = null;
      let axis = null;
      let expansionWarning = null;
      for (let attempt = 0; attempt < windowSizes.length; attempt++) {
        const windowTiles = windowSizes[attempt];
        let candidate = options.model?.windowTiles === windowTiles
          && pointIndex(options.model, ...options.start) >= 0
          && pointIndex(options.model, ...options.end) >= 0 ? options.model : null;
        if (!candidate) {
          try {
            candidate = await loadModel(...midpoint, progress => self.postMessage({ id, progress: (attempt + progress) / windowSizes.length * 0.7, phase: 'loading' }), windowTiles);
          } catch (error) {
            if (!axis) throw error;
            expansionWarning = 'Terrain coverage ended before the axis could be fully contained.';
            break;
          }
        }
        if (pointIndex(candidate, ...options.start) < 0 || pointIndex(candidate, ...options.end) < 0) throw new Error('One or both axis endpoints are outside the available elevation data.');
        self.postMessage({ id, progress: 0.72 + attempt / windowSizes.length * 0.25, phase: 'calculating' });
        axis = calculateTerrainAxis(candidate, options.start, options.end, progress => self.postMessage({ id, progress: 0.72 + attempt / windowSizes.length * 0.25 + progress * 0.2 / windowSizes.length, phase: 'calculating' }));
        model = candidate;
        if (!axis.partial) break;
        if (attempt === windowSizes.length - 1) expansionWarning = 'The axis still reaches the edge of the largest available terrain window.';
      }
      self.postMessage({ id, value: { model: options.model && model === options.model ? null : model, axis, expansionWarning } });
      return;
    }
    if (options.initial) {
      const windowSizes = [3, 5, 7].filter(size => size >= (options.model?.windowTiles || 3));
      if (!windowSizes.length) windowSizes.push(options.model.windowTiles);
      let model = null;
      let result = null;
      let proposed = null;
      let expansionWarning = null;
      for (let attempt = 0; attempt < windowSizes.length; attempt++) {
        const windowTiles = windowSizes[attempt];
        let candidate = options.model?.windowTiles === windowTiles ? options.model : null;
        if (!candidate) {
          try {
            candidate = await loadModel(...options.point, progress => self.postMessage({ id, progress: (attempt + progress) / windowSizes.length * 0.75, phase: 'loading' }), windowTiles);
          } catch (error) {
            if (!result) throw error;
            expansionWarning = 'Terrain coverage ended before the basin could be fully contained.';
            break;
          }
        }
        const selectedIndex = pointIndex(candidate, ...options.point);
        if (selectedIndex < 0) throw new Error('Selected point is outside terrain coverage');
        proposed = snapPoint(candidate, selectedIndex);
        self.postMessage({ id, progress: 0.75 + attempt / windowSizes.length * 0.2, phase: 'calculating' });
        result = await delineateCached(candidate, proposed.index);
        model = candidate;
        if (!result.partial) break;
        if (attempt === windowSizes.length - 1) expansionWarning = 'The basin still reaches the edge of the largest available terrain window.';
      }
      self.postMessage({ id, value: { model: options.model && model === options.model ? null : model, result, point: proposed.point, proposed, expansionWarning } });
      return;
    }
    const model = options.model || await loadModel(...options.point, progress => self.postMessage({ id, progress, phase: progress === 1 ? 'calculating' : 'loading' }));
    let outlet = pointIndex(model, ...options.point);
    const proposed = snapPoint(model, outlet);
    self.postMessage({ id, progress: 1, phase: 'calculating' });
    const result = await delineateCached(model, outlet);
    self.postMessage({ id, value: { model: options.model ? null : model, result, point: options.point, proposed } });
  } catch (error) { self.postMessage({ id, error: error.message || 'Terrain analysis failed' }); }
};