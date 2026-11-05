import { loadModel, pointIndex, snapPoint, delineateCached } from './hydrology.js';
import { setCacheEnabled } from './cache.js';

self.onmessage = async ({ data: { id, type, ...options } }) => {
  try {
    setCacheEnabled(options.cacheEnabled);
    if (type === 'calculate') {
      const result = await delineateCached(options.model, options.outlet);
      self.postMessage({ id, value: { result } });
      return;
    }
    const model = options.model || await loadModel(...options.point, progress => self.postMessage({ id, progress, phase: progress === 1 ? 'calculating' : 'loading' }));
    let outlet = pointIndex(model, ...options.point);
    const proposed = snapPoint(model, outlet);
    const point = options.initial ? proposed.point : options.point;
    if (options.initial) outlet = proposed.index;
    self.postMessage({ id, progress: 1, phase: 'calculating' });
    const result = await delineateCached(model, outlet);
    self.postMessage({ id, value: { model: options.model ? null : model, result, point, proposed: options.initial ? null : proposed } });
  } catch (error) { self.postMessage({ id, error: error.message || 'Terrain analysis failed' }); }
};