import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { MentionOptions } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import { FileText, Table2 } from "lucide-react";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import { viewApi } from "@/lib/db";
import { databaseApi } from "@/lib/database";
import { newSelectOption } from "@/lib/database-values";
import { useSettingsStore } from "@/stores/settings";
import type { View } from "@/types/models";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";

// —— 数据类型（@tiptap/extension-mention 自定义 item）——
export interface MentionItem {
  id: string; // viewId
  label: string; // 页面名
  view?: View;
}

// —— 提及下拉列表组件（Suggestion.render 里由 ReactRenderer 挂载）——
interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
  query: string;
  ref?: Ref<MentionListHandle>;
}

interface MentionListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export function MentionList(props: MentionListProps) {
  const { items, command, query, ref } = props;
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 搜索框值（显示当前 query，用户也可在其中输入来补充搜索）
  const [searchText, setSearchText] = useState(query);

  useEffect(() => setSearchText(query), [query]);

  // 客户端二次过滤（基于 searchText）
  const filteredItems = searchText.trim()
    ? items.filter((it) => it.label.toLowerCase().includes(searchText.toLowerCase()))
    : items;

  // 是否显示"新建"选项：列表为空且搜索词非空
  const showCreate = filteredItems.length === 0 && searchText.trim().length > 0;

  // 所有可选项（已有项 + 新建项）
  const allOptions = [...filteredItems];
  if (showCreate) {
    allOptions.push(
      { id: "__create_doc__", label: searchText.trim() },
      { id: "__create_table__", label: searchText.trim() },
    );
  }

  useEffect(() => setActive(0), [searchText, items, showCreate]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const len = Math.max(allOptions.length, 1);
      if (event.key === "ArrowDown") {
        setActive((a) => (a + 1) % len);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((a) => (a - 1 + allOptions.length) % len);
        return true;
      }
      if (event.key === "Enter") {
        if (allOptions[active]) {
          handleSelect(allOptions[active]);
          return true;
        }
        return false;
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allOptions, active],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const handleCreateDoc = async (name: string) => {
    try {
      const ws = useWorkspaceStore.getState();
      const wsId = ws.currentWorkspaceId;
      if (!wsId) return;
      // 1. 创建视图（不走 store.createView 避免 reload 导致 editor 失效）
      const newView = await viewApi.create({ workspace_id: wsId, parent_id: null, name, layout: "document" });
      // 2. 先插入 mention 节点（此时 editor 还活着）
      command({ id: newView.id, label: name, view: newView });
      // 3. 再 reload 更新目录树
      await ws.reload();
    } catch (e) {
      logger.error("create doc from mention failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const handleCreateTable = async (name: string) => {
    try {
      const ws = useWorkspaceStore.getState();
      const wsId = ws.currentWorkspaceId;
      const lang = useSettingsStore.getState().lang;
      if (!wsId) return;
      // 1. 创建 grid 视图
      const newView = await viewApi.create({ workspace_id: wsId, parent_id: null, name, layout: "grid" });
      // 2. 预置默认字段（名称/日期/单选 + 两个选项 + 一行空行）
      await databaseApi.createField(newView.id, "text", lang === "zh-CN" ? "名称" : "Name");
      await databaseApi.createField(newView.id, "date", lang === "zh-CN" ? "日期" : "Date");
      const select = await databaseApi.createField(newView.id, "single_select", lang === "zh-CN" ? "单选" : "Select");
      await databaseApi.updateFieldOptions(select.id, {
        kind: "select",
        options: [
          newSelectOption(lang === "zh-CN" ? "选项 1" : "Option 1"),
          newSelectOption(lang === "zh-CN" ? "选项 2" : "Option 2"),
        ],
      });
      await databaseApi.createRow(newView.id);
      // 3. 先插入 mention 节点（此时 editor 还活着）
      command({ id: newView.id, label: name, view: newView });
      // 4. 再 reload 更新目录树
      await ws.reload();
    } catch (e) {
      logger.error("create table from mention failed", e);
      toast.error(t("error.db", { message: String(e) }));
    }
  };

  const handleSelect = (item: MentionItem) => {
    if (item.id === "__create_doc__") {
      void handleCreateDoc(item.label);
    } else if (item.id === "__create_table__") {
      void handleCreateTable(item.label);
    } else {
      command(item);
    }
  };

  return (
    <div className="w-[280px] rounded-lg border border-neutral-300 bg-white shadow-lg">
      {/* 搜索框 */}
      <div className="border-b border-neutral-200 px-2 py-1.5">
        <input
          autoFocus
          className="w-full bg-transparent text-[13px] text-neutral-700 outline-none placeholder:text-neutral-400"
          placeholder={t("mention.search")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              if (allOptions[active]) handleSelect(allOptions[active]);
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              onKeyDown(new KeyboardEvent("keydown", { key: e.key }));
            }
          }}
        />
      </div>

      {/* 列表 */}
      {allOptions.length === 0 ? (
        <div className="px-3 py-2 text-[12.5px] text-neutral-400">{t("mention.empty")}</div>
      ) : (
        <div ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
          {allOptions.map((it, i) => {
            const isCreateDoc = it.id === "__create_doc__";
            const isCreateTable = it.id === "__create_table__";
            return (
              <button
                key={it.id}
                data-active={i === active}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] " +
                  (i === active ? "bg-brand-100 text-neutral-800" : "text-neutral-600")
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => handleSelect(it)}
              >
                <span className="flex w-5 shrink-0 items-center justify-center">
                  {isCreateDoc ? (
                    <FileText className="h-4 w-4 text-brand-500" />
                  ) : isCreateTable ? (
                    <Table2 className="h-4 w-4 text-brand-500" />
                  ) : (
                    <span className="text-base leading-none">{it.view ? viewIcon(it.view) : "📄"}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {isCreateDoc
                    ? t("mention.createDoc", { name: it.label })
                    : isCreateTable
                      ? t("mention.createTable", { name: it.label })
                      : it.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// —— @tiptap/extension-mention suggestion 配置 ——
export function buildMentionSuggestion(): MentionOptions["suggestion"] {
  return {
    items: ({ query }): MentionItem[] => {
      try {
        const state = useWorkspaceStore.getState();
        const list: View[] = flattenTree(state.tree);
        const filtered = list.filter((v) => {
          try {
            const extra = JSON.parse(v.extra ?? "{}");
            if (extra.row_detail) return false;
          } catch {
            // ignore
          }
          if (!query.trim()) return true;
          const q = query.toLowerCase();
          return v.name.toLowerCase().includes(q);
        });
        return filtered.slice(0, 10).map((v) => ({
          id: v.id,
          label: v.name || t("common.untitled"),
          view: v,
        }));
      } catch (e) {
        logger.error("mention.items failed", e);
        return [];
      }
    },
    render: () => {
      let component: ReactRenderer<MentionListHandle> | null = null;
      let unmount: (() => void) | null = null;
      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props: {
              items: props.items,
              command: props.command,
              query: props.query,
            },
            editor: props.editor,
          });
          unmount = props.mount(component.element);
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            command: props.command,
            query: props.query,
          });
        },
        onExit: () => {
          unmount?.();
          component?.destroy();
          component = null;
          unmount = null;
        },
        onKeyDown: ({ event }) => {
          if (event.key === "Escape") return true;
          return component?.ref?.onKeyDown(event) ?? false;
        },
      };
    },
  };
}
