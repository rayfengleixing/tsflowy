import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

export const createUiSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  expanded: new Set<string>(),
  sidebarWidth: 240,

  toggleExpand: (id: string) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    set({ expanded });
  },

  expand: (id: string) => {
    if (!get().expanded.has(id)) {
      set({ expanded: new Set(get().expanded).add(id) });
    }
  },

  setExpandedAll: (ids: Set<string>) => set({ expanded: ids }),

  setSidebarWidth: (w: number) => set({ sidebarWidth: w }),
});
