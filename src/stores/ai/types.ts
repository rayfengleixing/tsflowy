import {
  type AiUsageSummary,
  type AiConfig,
  type AiImageAttachment,
  type AiQuickActionDef,
  type AiUsage,
} from "@/lib/ai";
import { type AiEditRevert } from "@/lib/ai-editor";
import { type AiEditOp, type AiWriteCall } from "@/lib/ai-edit";
import { type UndoPlan } from "@/lib/ai-tools";
// AI 面板 store 的类型面：动作记录、消息、会话与整份 AiState 形状。

/**
 * 动作的落地状态：
 * pending 待用户确认 / applied 已写入 / rejected 已忽略 /
 * unavailable 没有可编辑文档、定位失败或执行报错 / malformed 指令块解析失败
 */
export type AiEditState = "pending" | "applied" | "rejected" | "unavailable" | "malformed";

/** 一条回复附带的动作（改文档 / 建页 / 改标题 / 加表行）及其落地情况 */
export interface AiActionRecord {
  tool: AiWriteCall["tool"] | "invalid";
  /** 动作本体；invalid 卡片为 null（格式有误，没有可执行的东西） */
  call: AiWriteCall | null;
  /** apply_edit 的作用范围；其余动作与解析失败时为 null */
  op: AiEditOp | null;
  summary: string;
  /** 建议写入的 Markdown 内容（建页时为页面正文） */
  content: string;
  /** 将被替换的原文（插入/新增类为空），用于落地前的 diff 预览 */
  before: string;
  state: AiEditState;
  undone?: boolean;
  /** 动作落点页名（跨页面编辑时界面要说明改了哪一页） */
  pageName?: string;
  /** 执行结果说明或失败原因 */
  detail?: string;
  /** 撤销句柄（含改前快照），仅当前编辑器实例内有效，不参与持久化 */
  revert?: AiEditRevert;
  /**
   * 页面/表数据写动作的逆操作计划：纯数据，随会话 JSON 落库，
   * 所以重启后这一张卡片仍然可以撤销（与 revert 是两套机制）。
   */
  undo?: UndoPlan;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 本条回复下发的动作及其落地结果（用于展示、确认与撤销） */
  actions?: AiActionRecord[];
  /** 用户消息附带的图片（assets/ 相对路径，发送时才内联成 base64） */
  images?: AiImageAttachment[];
  /** 回答评分：点赞 / 点踩，未评过为 undefined */
  rating?: "up" | "down";
  /** 回答被中断的标记：error=请求失败留下的半截，stopped=用户点停止；重试据此丢弃残响重发 */
  incomplete?: "error" | "stopped";
}
/** 快捷动作：前四个基于选中文本，continue 基于整页上下文（不需要选中） */
export type AiQuickAction = "summarize" | "translate" | "rewrite" | "explain" | "continue";
/** 会话累计 token 用量（服务商不回 usage 时整份为 0） */
export interface SessionUsage {
  prompt: number;
  completion: number;
}

/** 归档的历史会话（不含进行中的当前对话） */
export interface StoredSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiMessage[];
  /** 会话发起时所在的页面：历史会话的上下文是那一页，切换页面后不应混淆 */
  pageId?: string | null;
  pageTitle?: string | null;
  /** 会话累计 token 用量：切回历史会话时据此恢复底部的用量条 */
  usage?: SessionUsage;
  /** 归档位：归档后不进日常历史列表，但仍可检索、可还原，且不受会话条数上限裁剪 */
  archived?: boolean;
}
export interface AiState {
  open: boolean;
  width: number;
  messages: AiMessage[];
  /** 归档的历史会话（不含进行中的当前对话） */
  sessions: StoredSession[];
  activeSessionId: string;
  /** 推理型模型的思考过程（仅展示，不参与回填/复制） */
  reasoning: string;
  streaming: boolean;
  /** agent 循环里正在本机执行只读检索（模型已回答完上一轮，下一轮请求还没发出） */
  retrieving: boolean;
  error: string | null;
  /** 上一条错误的归类码（auth / rate_limit / quota / timeout / network / server / context_length / cancelled） */
  errorCode: string | null;
  /** 当前会话发起时所在的页面（历史会话据此标注上下文来源） */
  sessionPageId: string | null;
  sessionPageTitle: string | null;
  /** 历史会话是否已从库里加载过（避免重复拉取） */
  sessionsLoaded: boolean;
  /** 最近一轮的 token 用量（服务商不返回时保持 null） */
  usage: AiUsage | null;
  /** 本会话累计用量，只在服务商返回用量时累加 */
  usageTotal: { prompt: number; completion: number; total: number };
  /** 库中全部会话的 token 累计（库不可用时为 null，界面隐藏用量条） */
  usageSummary: AiUsageSummary | null;
  config: AiConfig | null;
  configLoaded: boolean;
  /**
   * 从编辑器（浮动工具栏 / 斜杠菜单）带入的选中内容。
   * 只随下一轮提问生效，发完即清空——作为 system 上下文下发，不占用用户消息正文。
   */
  pendingContext: string | null;
  /** 输入框聚焦请求计数：从编辑器唤起面板时递增，面板据此把光标交给输入框 */
  focusTick: number;
  /** 正在「改后重发」的那条用户消息 id；null 表示下一次发送是普通提问 */
  editingId: string | null;
  /** 「优化提问」给出的改写候选（点一条填入输入框） */
  promptIdeas: string[];
  /** 正在向模型请求提问改写 */
  refining: boolean;

  toggle: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setWidth: (w: number) => void;
  loadConfig: () => Promise<void>;
  /** 从库中恢复历史会话（库不可用时回退 localStorage），只在首次打开面板时执行一次 */
  loadSessions: () => Promise<void>;
  /** 历史面板当前展示的普通会话条数窗口（归档不受窗口限制） */
  sessionsShown: number;
  /** 「加载更多」：放大显示窗口，一步 MAX_SESSIONS 条 */
  loadMoreSessions: () => void;
  setConfig: (c: AiConfig) => void;
  /** 设置/清除下一条提问要附带的选中内容 */
  setPendingContext: (text: string | null) => void;
  send: (text: string, images?: AiImageAttachment[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
  retry: () => Promise<void>;
  quickAction: (kind: AiQuickAction) => Promise<void>;
  /** 归档当前对话并开始新会话 */
  newChat: () => void;
  /** 切换到历史会话（当前对话有内容时先归档） */
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /** 重命名历史会话（当前对话的标题由首条提问决定，不参与） */
  renameSession: (id: string, title: string) => void;
  /** 归档 / 取消归档历史会话 */
  setSessionArchived: (id: string, archived: boolean) => void;
  /** 给一条回答打分，再点同向取消 */
  rateMessage: (messageId: string, rating: "up" | "down") => void;
  /** 撤销某条回复里某个动作造成的改动（表/页面按逆操作计划，文档按编辑器快照） */
  undoAction: (messageId: string, index: number) => Promise<void>;
  /** 执行待确认的动作（设置开启「改前确认」后由用户触发） */
  applyAction: (messageId: string, index: number) => Promise<void>;
  /** 忽略待确认的动作 */
  rejectAction: (messageId: string, index: number) => void;
  /** 切换模型档位（会持久化到配置） */
  switchProfile: (id: string) => Promise<void>;
  /** 切换上下文范围（full / page_only / off，会持久化到配置） */
  setCtxScope: (scope: string) => Promise<void>;
  /** 执行用户在设置里自定义的快捷指令 */
  runQuickAction: (action: AiQuickActionDef) => Promise<void>;
  /** 从上一条被中断的回答接着往下生成 */
  continueGenerate: () => Promise<void>;
  /** 从某条回答重新生成：丢掉它与它之后的消息，用同一个问题再问一次 */
  regenerate: (messageId: string) => Promise<void>;
  /** 改后重发：替换某条提问、丢掉它之后的消息并重新生成 */
  resend: (messageId: string, text: string, images?: AiImageAttachment[]) => Promise<void>;
  /** 把某条提问标记为待修改（面板据此把它填回输入框） */
  startEdit: (messageId: string) => void;
  cancelEdit: () => void;
  /** 从某条消息处分支：当前对话原样归档，之前的内容成为一个新会话 */
  branchFrom: (messageId: string) => void;
  /** 把一条回答另存为文档页面 */
  saveMessageAsPage: (messageId: string) => Promise<void>;
  /** 把一条回答导出成 Markdown 文件 */
  exportMessage: (messageId: string) => Promise<void>;
  /** 让模型把一句提问改写成几条候选 */
  refinePrompt: (text: string) => Promise<void>;
  clearPromptIdeas: () => void;
}
