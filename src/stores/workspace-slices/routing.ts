import type { Route, WorkspaceSliceCreator, WorkspaceState } from "./types";

export const createRoutingSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set) => ({
  route: "workspace",
  searchQuery: "",
  paletteOpen: false,

  setRoute: (route: Route) => set({ route }),

  openSearch: (query: string) => set({ route: "search", searchQuery: query, paletteOpen: false }),

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
});
