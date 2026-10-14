import { persistNow, loadSidebarWidth, saveSidebarWidth } from "./persistence";
import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

export const createUiSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  expanded: new Set<string>(),
  sidebarWidth: loadSidebarWidth(),

  toggleExpand: (id: string) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    set({ expanded });
    persistNow(get);
  },

  expand: (id: string) => {
    if (!get().expanded.has(id)) {
      set({ expanded: new Set(get().expanded).add(id) });
      persistNow(get);
    }
  },

  setExpandedAll: (ids: Set<string>) => {
    set({ expanded: ids });
    persistNow(get);
  },

  setSidebarWidth: (w: number) => {
    set({ sidebarWidth: w });
    saveSidebarWidth(w);
  },
});
