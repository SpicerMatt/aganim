export const EMPTY_ANALYSES = { items: [], activeId: null };

export function createWatershedAnalysis(result, { id, number, name = '', location, point, model, elapsedMs, origin }) {
  return { ...result, id, number, type: 'watershed', name, location, point: [...point], model, elapsedMs, origin };
}

export function analysesReducer(state, action) {
  switch (action.type) {
    case 'upsert': {
      const exists = state.items.some(item => item.id === action.analysis.id);
      const items = exists ? state.items.map(item => item.id === action.analysis.id ? action.analysis : item) : [...state.items, action.analysis];
      return { items, activeId: action.analysis.id };
    }
    case 'activate':
      return action.id === null || state.items.some(item => item.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'rename': {
      const name = action.name.trimStart().slice(0, 60);
      const items = state.items.map(item => item.id === action.id ? { ...item, name } : item);
      return state.items.some(item => item.id === action.id) ? { ...state, items } : state;
    }
    case 'remove': {
      const items = state.items.filter(item => item.id !== action.id);
      return { items, activeId: state.activeId === action.id ? items.at(-1)?.id ?? null : state.activeId };
    }
    case 'clear':
      return { items: [], activeId: null };
    default:
      return state;
  }
}