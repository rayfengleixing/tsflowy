import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { ChevronDown, ChevronUp, Replace, ReplaceAll, Search, X } from "lucide-react";
import { toast } from "sonner";
import {
  clearFind,
  getFindState,
  gotoFindMatch,
  replaceActiveMatch,
  replaceAllMatches,
  setFindQuery,
} from "./extensions/find-replace";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** 文档内查找替换条（Ctrl+F 打开；Enter 下一个 / Shift+Enter 上一个 / Esc 关闭） */
export function FindReplaceBar(props: { editor: Editor; onClose: () => void }) {
  const { editor, onClose } = props;
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [info, setInfo] = useState<{ total: number; active: number }>({ total: 0, active: -1 });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 查询词变化 → 交给插件重算并跳到首个命中
  useEffect(() => {
    setFindQuery(editor, query);
  }, [editor, query]);

  // 事务驱动计数：编辑文档/移动活动项都会刷新 n/m
  useEffect(() => {
    const sync = () => {
      const st = getFindState(editor);
      const total = st?.matches.length ?? 0;
      const active = st?.active ?? -1;
      setInfo((prev) => (prev.total === total && prev.active === active ? prev : { total, active }));
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  const close = () => {
    clearFind(editor);
    onClose();
  };

  const onReplace = () => {
    if (query.trim() === "") return;
    replaceActiveMatch(editor, replacement);
  };

  const onReplaceAll = () => {
    if (query.trim() === "") return;
    const n = replaceAllMatches(editor, replacement);
    if (n > 0) toast.success(t("find.replaced", { count: String(n) }));
  };

  return (
    <div
      data-testid="find-bar"
      aria-label={t("find.title")}
      className="absolute right-4 top-2 z-40 w-[420px] max-w-[calc(100%-2rem)] rounded-lg border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <Search className="ml-1 h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <input
          ref={inputRef}
          className="h-7 min-w-0 flex-1 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-900"
          placeholder={t("find.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              gotoFindMatch(editor, info.active + (e.shiftKey ? -1 : 1));
            }
          }}
        />
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
          {info.total === 0 ? (query ? t("find.noResult") : "") : `${info.active + 1}/${info.total}`}
        </span>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-40 dark:hover:bg-neutral-800"
          title={t("find.prev")}
          disabled={info.total === 0}
          onClick={() => gotoFindMatch(editor, info.active - 1)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 disabled:opacity-40 dark:hover:bg-neutral-800"
          title={t("find.next")}
          disabled={info.total === 0}
          onClick={() => gotoFindMatch(editor, info.active + 1)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded",
            showReplace
              ? "bg-brand-100 text-brand-600"
              : "text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800",
          )}
          title={t("find.replace")}
          onClick={() => setShowReplace((v) => !v)}
        >
          <Replace className="h-3.5 w-3.5" />
        </button>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800"
          onClick={close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          <Replace className="ml-1 h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-neutral-300 px-2 text-[12px] outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-900"
            placeholder={t("find.replacePlaceholder")}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onReplace();
              }
            }}
          />
          <button
            className="flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[12px] text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
            title={t("find.replace")}
            disabled={info.total === 0}
            onClick={onReplace}
          >
            <Replace className="h-3.5 w-3.5" />
            {t("find.replace")}
          </button>
          <button
            className="flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[12px] text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
            title={t("find.replaceAll")}
            disabled={info.total === 0}
            onClick={onReplaceAll}
          >
            <ReplaceAll className="h-3.5 w-3.5" />
            {t("find.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
