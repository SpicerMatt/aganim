import { loadModel, pointIndex, snapPoint, delineateCached, hydrologyWithinBounds } from './hydrology.js';
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