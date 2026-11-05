let worker;
let sequence = 0;
const pending = new Map();

export function terrainTask(type, options, onProgress = () => {}) {
  if (!worker) {
    worker = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id);
      if (!task) return;
      if (data.progress !== undefined) { task.onProgress(data.progress, data.phase); return; }
      pending.delete(data.id);
      if (data.error) task.reject(new Error(data.error));
      else task.resolve(data.value);
    };
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(new Error('Background terrain worker failed. Retry the analysis.'));
      pending.clear(); worker.terminate(); worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, ...options });
  });
}