import { viewApi } from "@/lib/db";
import { logger } from "@/lib/logger";
import { flattenTree } from "@/lib/tree";
import { parseViewTags } from "@/types/models";
import {
  TAG_META_KEY,
  canonicalTagName,
  omitTagColor,
  parseTagColors,
  renameTagColor,
  renameTagPath,
  tagMatchesFilter,
  type TagColorMap,
} from "@/lib/tags";
import { patchTreeView } from "./tree";
import type { WorkspaceSliceCreator, WorkspaceState } from "./types";

/** 把标签颜色表写回 app_settings（全局键，失败仅告警，不影响 UI） */
async function persistTagMeta(meta: TagColorMap): Promise<void> {
  try {
    await viewApi.setSetting(TAG_META_KEY, JSON.stringify(meta));
  } catch (e) {
    logger.warn("WorkspaceStore", "persist tag meta failed", e);
  }
}

export const createTagsSlice: WorkspaceSliceCreator<Partial<WorkspaceState>> = (set, get) => ({
  tagFilter: null,
  tagMeta: {},

  setTagFilter: (tag) => set({ tagFilter: tag }),

  loadTagMeta: async () => {
    try {
      const raw = await viewApi.getSetting(TAG_META_KEY);
      set({ tagMeta: parseTagColors(raw) });
    } catch (e) {
      logger.warn("WorkspaceStore", "load tag meta failed", e);
    }
  },

  setTagColor: async (tag, color) => {
    // 颜色键取规范形：树/面板里同一标签无论什么写法都取到同一份配置
    const key = canonicalTagName(tag) || tag;
    const tagMeta = { ...get().tagMeta, [key]: color };
    set({ tagMeta });
    await persistTagMeta(tagMeta);
  },

  renameTag: async (from, to) => {
    const name = canonicalTagName(to);
    if (!name || name === canonicalTagName(from)) return;
    // 先算出每个受影响页面的新标签（层级改名：命中 from 子树的标签整体换前缀；同页去重）
    const affected = flattenTree(get().tree)
      .map((v) => ({ id: v.id, tags: parseViewTags(v.tags) }))
      .filter((a) => a.tags.some((x) => tagMatchesFilter(x, from)))
      .map((a) => ({ id: a.id, tags: [...new Set(a.tags.map((x) => renameTagPath(x, from, name)))] }));
    for (const a of affected) await viewApi.setTags(a.id, a.tags);
    set((state) => {
      let tree = state.tree;
      for (const a of affected) tree = patchTreeView(tree, a.id, { tags: JSON.stringify(a.tags) });
      return {
        tree,
        tagMeta: renameTagColor(state.tagMeta, from, name),
        tagFilter: state.tagFilter ? renameTagPath(state.tagFilter, from, name) : state.tagFilter,
      };
    });
    await persistTagMeta(get().tagMeta);
  },

  deleteTag: async (tag) => {
    // 层级删除：整个子树（含自身）的标签一并移除
    const affected = flattenTree(get().tree)
      .map((v) => ({ id: v.id, tags: parseViewTags(v.tags) }))
      .filter((a) => a.tags.some((x) => tagMatchesFilter(x, tag)))
      .map((a) => ({ id: a.id, tags: a.tags.filter((x) => !tagMatchesFilter(x, tag)) }));
    for (const a of affected) await viewApi.setTags(a.id, a.tags);
    set((state) => {
      let tree = state.tree;
      for (const a of affected) tree = patchTreeView(tree, a.id, { tags: JSON.stringify(a.tags) });
      return {
        tree,
        tagMeta: omitTagColor(state.tagMeta, tag),
        tagFilter: state.tagFilter && tagMatchesFilter(state.tagFilter, tag) ? null : state.tagFilter,
      };
    });
    await persistTagMeta(get().tagMeta);
  },
});
