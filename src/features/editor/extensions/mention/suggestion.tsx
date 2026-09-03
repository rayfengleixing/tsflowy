import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { MentionOptions } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import { viewIcon } from "@/components/view-icon";
import { useWorkspaceStore } from "@/stores/workspace";
import { flattenTree } from "@/lib/tree";
import type { View } from "@/types/models";
import { t } from "@/lib/i18n";

// —— 数据类型（@tiptap/extension-mention 自定义 item）——
export interface MentionItem {
  id: string;       // viewId
  label: string;    // 页面名
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

  useEffect(() => setActive(0), [query, items]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const len = Math.max(items.length, 1);
      if (event.key === "ArrowDown") {
        setActive((a) => (a + 1) % len);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((a) => (a - 1 + items.length) % len);
        return true;
      }
      if (event.key === "Enter") {
        if (items[active]) {
          command(items[active]);
          return true;
        }
        return false;
      }
      return false;
    },
    [items, active, command],
  );

  useImperativeHandle(ref, () => ({ onKeyDown }));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[12.5px] text-neutral-500 shadow-lg">
        {t("mention.empty")}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-[320px] w-[280px] overflow-y-auto rounded-lg border border-neutral-300 bg-white py-1 shadow-lg"
    >
      {items.map((it, i) => (
        <button
          key={it.id}
          data-active={i === active}
          className={
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] " +
            (i === active ? "bg-brand-100 text-neutral-800" : "text-neutral-600")
          }
          onMouseEnter={() => setActive(i)}
          onClick={() => command(it)}
        >
          <span className="flex w-5 shrink-0 items-center justify-center text-base leading-none">
            {it.view ? viewIcon(it.view) : "📄"}
          </span>
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

// —— @tiptap/extension-mention suggestion 配置 ——
// 经验 507464：items 必须恒返回数组；空态时 MentionList 已 return 独立空盒子（上下键逻辑不会被触发，len=max(0,1)=1 实际无项可选也不会 command）
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
        console.error("mention.items failed", e);
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
