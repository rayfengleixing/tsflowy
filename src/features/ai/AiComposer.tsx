// AI 面板的输入区：多行输入、@ 引用工作区文件、图片附件、「优化提问」候选与发送/停止（从 AiPanel.tsx 原样搬出）。
// 输入框这只 ref 在宿主手里（从编辑器唤起要 focus、气泡「改提问」要 fillInput），所以 input / mention
// 两份状态与 textareaRef 由宿主传进来；附件、@ 候选、快捷键与发送逻辑全部自持，搬过来的 JSX 一字未改。
import { useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { ImagePlus, Send, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { viewIcon } from "@/components/view-icon";
import { useAiStore } from "@/stores/ai";
import { useWorkspaceStore } from "@/stores/workspace";
import { MAX_AI_IMAGES, aiErrorText, saveAiImageFile, type AiImageAttachment } from "@/lib/ai";
import { filesFromDataTransfer } from "@/lib/assets";
import { bestMentionScore, detectMentionQuery } from "@/lib/ai-mention";
import { flattenTree } from "@/lib/tree";
import { parseViewAliases } from "@/types/models";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ImageThumb, QuickButton } from "./AiParts";
import { AI_IMAGE_ACCEPT } from "./ai-utils";

/** 正在输入的 @ 引用：起点下标 + 查询词。宿主的 fillInput 也要清掉它，所以类型提到外面共用 */
export interface AiMention {
  start: number;
  query: string;
}

interface AiComposerProps {
  /** textarea 的 ref 归宿主：唤起时 focus、填回后把光标挪到末尾 */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  mention: AiMention | null;
  setMention: Dispatch<SetStateAction<AiMention | null>>;
  /** 发送后要把消息列表拉回底部跟随（宿主那份 pinned） */
  setPinned: Dispatch<SetStateAction<boolean>>;
  /** 采用「优化提问」候选：填回输入框并交出光标（实现留在宿主，气泡的「改提问」也用它） */
  fillInput: (text: string) => void;
}

export function AiComposer({
  textareaRef,
  input,
  setInput,
  mention,
  setMention,
  setPinned,
  fillInput,
}: AiComposerProps) {
  const streaming = useAiStore((s) => s.streaming);
  const send = useAiStore((s) => s.send);
  const stop = useAiStore((s) => s.stop);
  const resend = useAiStore((s) => s.resend);
  const editingId = useAiStore((s) => s.editingId);
  const cancelEdit = useAiStore((s) => s.cancelEdit);
  const promptIdeas = useAiStore((s) => s.promptIdeas);
  const clearPromptIdeas = useAiStore((s) => s.clearPromptIdeas);
  const refining = useAiStore((s) => s.refining);
  const refinePrompt = useAiStore((s) => s.refinePrompt);
  const pendingContext = useAiStore((s) => s.pendingContext);
  const setPendingContext = useAiStore((s) => s.setPendingContext);

  // 待发送的图片附件（assets/ 相对路径）；发送后随消息留在对话里
  const [attachments, setAttachments] = useState<AiImageAttachment[]>([]);

  const [mentionActive, setMentionActive] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tree = useWorkspaceStore((s) => s.tree);

  // @ 引用的候选文档：当前工作区树（排除行详情），按查询词模糊匹配打分取前 8
  const mentionItems = useMemo(() => {
    if (!mention) return [];
    return flattenTree(tree)
      .flatMap((v) => {
        try {
          if ((JSON.parse(v.extra) as { row_detail?: unknown }).row_detail) return [];
        } catch {
          /* extra 解析失败当作普通文档 */
        }
        // 标题与别名一起打分取最高：@ 缩写/旧名也能把这页带进候选
        const score = bestMentionScore([v.name, ...parseViewAliases(v.aliases)], mention.query);
        return score === null ? [] : [{ v, score }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.v);
  }, [mention, tree]);

  const submit = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    setInput("");
    setAttachments([]);
    setMention(null);
    setPinned(true);
    // 正在修改某条提问时，发送表示「改后重发」：替换那条提问并重跑它之后的回答
    // 没重新附图就沿用原提问的图片（传 undefined 表示不改）
    const images = attachments.length > 0 ? attachments : undefined;
    if (editingId) void resend(editingId, text, images);
    else void send(text, images);
  };

  // 图片附件：粘贴与选择框拿到的都是 File，先落进 assets/，会话与请求里只带相对路径
  const addImageFiles = async (files: File[]) => {
    const room = MAX_AI_IMAGES - attachments.length;
    if (room <= 0) {
      toast.error(t("ai.attachFull", { count: MAX_AI_IMAGES }));
      return;
    }
    const saved: AiImageAttachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        saved.push(await saveAiImageFile(file));
      } catch (e) {
        toast.error(aiErrorText(e));
      }
    }
    if (saved.length > 0) setAttachments((cur) => [...cur, ...saved].slice(0, MAX_AI_IMAGES));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromDataTransfer(e.clipboardData);
    // 纯文本粘贴不拦截，交回输入框默认行为
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  };

  const removeAttachment = (path: string) => setAttachments((cur) => cur.filter((i) => i.path !== path));

  const stopEdit = () => {
    cancelEdit();
    setInput("");
  };

  // 选中 @ 引用：把 @查询词 替换为 @文件名 （带一个尾随空格），并把光标移到其后
  const pickMention = (name: string) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const next = input.slice(0, mention.start) + "@" + name + " " + input.slice(caret);
    setInput(next);
    setMention(null);
    const pos = mention.start + name.length + 2;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    setMention(detectMentionQuery(value, e.target.selectionStart));
    setMentionActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 文件下拉打开时，方向键/回车/退出优先归下拉
    if (mention && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionActive((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionActive((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionItems[mentionActive]?.name ?? mentionItems[0].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // 输入区：Enter 发送、Shift+Enter 换行；输入 @ 引用工作区文件
  return (
    <div className="relative shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-700">
      {/* 改后重发：输入框内容对应一条既有提问，发送会替换它并重跑其后的回答 */}
      {editingId && (
        <div className="mb-1 flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-600 dark:bg-neutral-800 dark:text-amber-300">
          <span className="min-w-0 flex-1">{t("ai.editingBanner")}</span>
          <button className="shrink-0 underline hover:no-underline" onClick={stopEdit}>
            {t("ai.cancelMsgEdit")}
          </button>
        </div>
      )}
      {/* 「优化提问」的候选：点一条填回输入框 */}
      {promptIdeas.length > 0 && (
        <div className="mb-1 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700">
          <div className="flex items-center justify-between text-[11px] text-neutral-500">
            <span>{t("ai.refineCandidates")}</span>
            <button className="underline hover:no-underline" onClick={clearPromptIdeas}>
              {t("ai.clearPendingContext")}
            </button>
          </div>
          <div className="mt-1 space-y-1">
            {promptIdeas.map((idea, i) => (
              <button
                key={i}
                type="button"
                title={idea}
                className="block w-full truncate rounded border border-neutral-200 px-1.5 py-0.5 text-left text-[11px] text-neutral-600 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                onClick={() => {
                  fillInput(idea);
                  clearPromptIdeas();
                }}
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* 编辑器带入的选中内容：随本轮提问一起下发 */}
      {pendingContext && (
        <div className="mb-1 flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2 py-1 text-[11px] text-brand-700 dark:border-brand-600 dark:bg-neutral-800 dark:text-neutral-200">
          <span className="min-w-0 flex-1 truncate">{t("ai.pendingContext", { count: pendingContext.length })}</span>
          <button className="shrink-0 underline hover:no-underline" onClick={() => setPendingContext(null)}>
            {t("ai.clearPendingContext")}
          </button>
        </div>
      )}
      {/* 待发送的图片：缩略图 + 移除；发送后原样留在用户消息里 */}
      {attachments.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {attachments.map((img) => (
            <ImageThumb key={img.path} path={img.path} name={img.name} onRemove={() => removeAttachment(img.path)} />
          ))}
        </div>
      )}
      {mention && (
        <div className="absolute inset-x-2 bottom-full mb-1 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
          {mentionItems.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-neutral-400">{t("mention.empty")}</div>
          ) : (
            <div role="listbox" aria-label={t("ai.inputPlaceholder")} className="max-h-56 overflow-y-auto py-1">
              {mentionItems.map((v, i) => (
                <button
                  key={v.id}
                  type="button"
                  role="option"
                  aria-selected={i === mentionActive}
                  data-active={i === mentionActive}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]",
                    i === mentionActive
                      ? "bg-brand-100 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
                      : "text-neutral-600 dark:text-neutral-300",
                  )}
                  onMouseEnter={() => setMentionActive(i)}
                  onClick={() => pickMention(v.name)}
                >
                  <span className="text-base leading-none">{viewIcon(v)}</span>
                  <span className="min-w-0 flex-1 truncate">{v.name || t("common.untitled")}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={input}
        onChange={onInputChange}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        rows={3}
        aria-label={t("ai.inputPlaceholder")}
        placeholder={t("ai.inputPlaceholder")}
        className="w-full resize-none rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 outline-none focus:border-brand-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {/* 图片附件走隐藏的原生选择框：能拿到 File，体积/类型可在校验后再入库 */}
        <input
          ref={fileInputRef}
          type="file"
          accept={AI_IMAGE_ACCEPT}
          multiple
          aria-hidden="true"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) void addImageFiles(files);
          }}
        />
        <QuickButton
          icon={<ImagePlus className="h-3 w-3" />}
          label={t("ai.attachImage")}
          disabled={streaming || attachments.length >= MAX_AI_IMAGES}
          onClick={() => fileInputRef.current?.click()}
        />
        {/* 优化提问：让模型把输入框里这句改写成几条候选，不进对话 */}
        {!streaming && (
          <QuickButton
            icon={<Sparkles className="h-3 w-3" />}
            label={refining ? t("ai.refining") : t("ai.refine")}
            disabled={!input.trim() || refining}
            onClick={() => void refinePrompt(input)}
          />
        )}
        {streaming ? (
          <Button size="sm" variant="outline" onClick={stop}>
            <Square className="mr-1 h-3.5 w-3.5" />
            {t("ai.stop")}
          </Button>
        ) : (
          <Button size="sm" onClick={submit} disabled={!input.trim() && attachments.length === 0}>
            <Send className="mr-1 h-3.5 w-3.5" />
            {t("ai.send")}
          </Button>
        )}
      </div>
    </div>
  );
}
