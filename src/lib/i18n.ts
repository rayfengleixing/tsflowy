// 极简 i18n（项目说明书 11 节：UI 文案走 zh-CN/en-US 两套；完整语言切换在 M6 设置页）
import { useSettingsStore } from "@/stores/settings";

const zh = {
  "sidebar.newSpace": "新建空间",
  "sidebar.search": "搜索…",
  "sidebar.searchSoon": "搜索功能将在 M3 里程碑提供",
  "sidebar.templatesSoon": "模板功能将在 M6 里程碑提供",
  "app.loading": "加载中…",
  "sidebar.newPage": "新建页面",
  "sidebar.templates": "模板",
  "sidebar.trash": "回收站",
  "sidebar.favorites": "收藏",
  "layout.document": "文档",
  "layout.grid": "表格",
  "layout.board": "看板",
  "layout.calendar": "日历",
  "tree.addSubpage": "新建子页面",
  "tree.rename": "重命名",
  "tree.favorite": "收藏",
  "tree.unfavorite": "取消收藏",
  "tree.delete": "删除",
  "tree.changeIcon": "更换图标",
  "tree.empty": "暂无页面，点击上方新建",
  "tree.confirmDeleteTitle": "删除页面",
  "tree.confirmDeleteDesc": "「{name}」及其子页面将被移入回收站，可随时恢复。",
  "workspace.rename": "重命名空间",
  "workspace.delete": "删除空间",
  "workspace.changeIcon": "更换图标",
  "workspace.confirmDeleteTitle": "删除空间",
  "workspace.confirmDeleteDesc": "「{name}」下的所有页面将被一并删除（先进入回收站），此操作需谨慎。",
  "tabs.newTab": "新建标签页",
  "trash.title": "回收站",
  "trash.restore": "恢复",
  "trash.purge": "彻底删除",
  "trash.purgeAll": "清空回收站",
  "trash.purgeAllDesc": "将彻底删除回收站内全部页面及其内容，无法恢复。",
  "trash.empty": "回收站是空的",
  "trash.deletedAt": "删除于 {date}",
  "content.empty": "选择或新建一个页面",
  "content.placeholder": "{layout} 布局将在 {milestone} 里程碑实现",
  "common.confirm": "确认",
  "common.cancel": "取消",
  "common.delete": "删除",
  "common.rename": "重命名",
  "common.untitled": "无标题页面",
  "error.db": "数据库操作失败：{message}",
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "sidebar.newSpace": "New Space",
  "sidebar.search": "Search…",
  "sidebar.searchSoon": "Search is coming in milestone M3",
  "sidebar.templatesSoon": "Templates are coming in milestone M6",
  "app.loading": "Loading…",
  "sidebar.newPage": "New Page",
  "sidebar.templates": "Templates",
  "sidebar.trash": "Trash",
  "sidebar.favorites": "Favorites",
  "layout.document": "Document",
  "layout.grid": "Grid",
  "layout.board": "Board",
  "layout.calendar": "Calendar",
  "tree.addSubpage": "New subpage",
  "tree.rename": "Rename",
  "tree.favorite": "Favorite",
  "tree.unfavorite": "Unfavorite",
  "tree.delete": "Delete",
  "tree.changeIcon": "Change icon",
  "tree.empty": "No pages yet, create one above",
  "tree.confirmDeleteTitle": "Delete page",
  "tree.confirmDeleteDesc": "「{name}」and its subpages will be moved to trash. You can restore them anytime.",
  "workspace.rename": "Rename space",
  "workspace.delete": "Delete space",
  "workspace.changeIcon": "Change icon",
  "workspace.confirmDeleteTitle": "Delete space",
  "workspace.confirmDeleteDesc": "All pages under 「{name}」will be moved to trash. Proceed with caution.",
  "tabs.newTab": "New tab",
  "trash.title": "Trash",
  "trash.restore": "Restore",
  "trash.purge": "Delete forever",
  "trash.purgeAll": "Empty trash",
  "trash.purgeAllDesc": "This will permanently delete all pages in trash. This cannot be undone.",
  "trash.empty": "Trash is empty",
  "trash.deletedAt": "Deleted at {date}",
  "content.empty": "Select or create a page",
  "content.placeholder": "{layout} will be implemented in milestone {milestone}",
  "common.confirm": "Confirm",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.rename": "Rename",
  "common.untitled": "Untitled",
  "error.db": "Database error: {message}",
};

const dicts: Record<string, Record<MessageKey, string>> = {
  "zh-CN": zh,
  "en-US": en,
};

/** 按当前语言取文案；支持 {placeholder} 插值 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const lang = useSettingsStore.getState().lang;
  let s = dicts[lang]?.[key] ?? zh[key];
  if (params) {
    for (const [k, val] of Object.entries(params)) {
      s = s.replace(`{${k}}`, String(val));
    }
  }
  return s;
}
