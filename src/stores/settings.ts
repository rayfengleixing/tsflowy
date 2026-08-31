import { create } from "zustand";

interface SettingsState {
  lang: "zh-CN" | "en-US";
  setLang: (lang: "zh-CN" | "en-US") => void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  lang: "zh-CN",
  setLang: (lang) => set({ lang }),
}));
