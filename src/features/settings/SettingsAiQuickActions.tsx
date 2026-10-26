// AI 设置里的「自定义快捷指令」编辑区：名称/作用范围/提示词。
// 从 SettingsAi.tsx 原样搬出（逐行零改动，含新增、改字段、删除三个动作）。
// 增删都回到父级的 saveAi：快捷指令是整份配置里的一个数组，局部保存会把它重置。
import type { Dispatch, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AiQuickActionDef } from "@/lib/ai";
import { t } from "@/lib/i18n";
import { AI_TEXT_INPUT, type AiFormState } from "./settings-parts";

interface Props {
  aiForm: AiFormState;
  setAiForm: Dispatch<SetStateAction<AiFormState>>;
  saveAi: (partial?: Partial<AiFormState>) => void;
  saveAiQuietly: (partial?: Partial<AiFormState>) => void;
}

/** 自定义快捷指令增删改 */
export function SettingsAiQuickActions({ aiForm, setAiForm, saveAi, saveAiQuietly }: Props) {
  // — 自定义快捷指令 —
  const addQuickAction = () => {
    const action: AiQuickActionDef = {
      id: `q${Date.now().toString(36)}`,
      name: t("settings.aiActionDefaultName"),
      prompt: "",
      scope: "selection",
    };
    saveAi({ quickActions: [...aiForm.quickActions, action] });
  };
  const updateQuickAction = (id: string, patch: Partial<AiQuickActionDef>) => {
    saveAi({ quickActions: aiForm.quickActions.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };
  const removeQuickAction = (id: string) => {
    saveAi({ quickActions: aiForm.quickActions.filter((a) => a.id !== id) });
  };

  return (
    <>
      {/* 自定义快捷指令 */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-sm font-medium text-neutral-800">{t("settings.aiActions")}</p>
          <Button size="sm" variant="outline" onClick={addQuickAction}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("settings.aiAddAction")}
          </Button>
        </div>
        {aiForm.quickActions.length === 0 ? (
          <p className="text-[11px] text-neutral-500">{t("settings.aiActionsEmpty")}</p>
        ) : (
          <div className="space-y-1.5">
            {aiForm.quickActions.map((a) => (
              <div key={a.id} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
                <div className="flex items-center gap-1.5">
                  <input
                    value={a.name}
                    onChange={(e) =>
                      setAiForm((f) => ({
                        ...f,
                        quickActions: f.quickActions.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)),
                      }))
                    }
                    onBlur={() => saveAiQuietly()}
                    placeholder={t("settings.aiActionName")}
                    className={`${AI_TEXT_INPUT} w-24`}
                  />
                  <select
                    value={a.scope}
                    onChange={(e) => updateQuickAction(a.id, { scope: e.target.value as AiQuickActionDef["scope"] })}
                    className={`${AI_TEXT_INPUT} w-28`}
                  >
                    <option value="selection">{t("settings.aiScopeSelection")}</option>
                    <option value="page">{t("settings.aiScopePage")}</option>
                    <option value="none">{t("settings.aiScopeNone")}</option>
                  </select>
                  <button
                    className="shrink-0 rounded p-1 text-neutral-400 hover:text-red-500"
                    title={t("settings.aiRemoveAction")}
                    onClick={() => removeQuickAction(a.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  rows={2}
                  value={a.prompt}
                  onChange={(e) =>
                    setAiForm((f) => ({
                      ...f,
                      quickActions: f.quickActions.map((x) => (x.id === a.id ? { ...x, prompt: e.target.value } : x)),
                    }))
                  }
                  onBlur={() => saveAiQuietly()}
                  placeholder={t("settings.aiActionPromptPlaceholder")}
                  className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1 text-[12px] text-neutral-800 outline-none focus:border-brand-500"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
