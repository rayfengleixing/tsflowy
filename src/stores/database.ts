import { create } from "zustand";
import type {
  CellValue,
  DatabaseField,
  DatabaseRow,
  DatabaseTrashRow,
  FieldOptions,
  FieldType,
} from "@/types/database";
import { databaseApi } from "@/lib/database";
import { onDatabaseChanged } from "@/lib/database-changed";
import { cellWriteTypeSafe, newSelectOption, parseFieldOptions, sameCellValue } from "@/lib/database-values";
import { renameFormulaRef } from "@/lib/database-formula";
import { newId, viewApi } from "@/lib/db";
import { useRelationStore } from "@/stores/relation";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { toast } from "sonner";
import { pruneFiltersByFields, type FilterMode, type FilterNode, type SortSpec } from "@/lib/database-query";
import { duplicateParentMap } from "@/lib/database-hierarchy";
import { patchViewConfig, readViewConfig } from "@/lib/view-config";
import type { View } from "@/types/models";

// 数据库视图的字段/行/单元格缓存（项目说明书 3 章 stores/database.ts）。
// 每个「数据库页」持有自己的实例（见 DatabasePage 的 Provider）：并排对照时
// 左右两栏各读各的字段/行/单元格，互不覆盖。useDatabaseStore 是全局默认实例，
// 供测试与未显式提供 Provider 的场景使用。

/** 删除后与 Rust 侧一致地把剩余行 position 压紧为 0..n-1（行号列按 position 显示，不跳号） */
function compactRowPositions(rows: DatabaseRow[]): DatabaseRow[] {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r, i) => (r.position === i ? r : { ...r, position: i }));
}

export interface DatabaseState {
  viewId: string | null;
  /** 当前视图行（写回 extra 配置用；viewId 保持原有语义不变） */
  view: View | null;
  fields: DatabaseField[];
  rows: DatabaseRow[];
  cells: Record<string, Record<string, CellValue>>;
  loading: boolean;

  // 排序/筛选（持久化到 views.extra）
  sorts: SortSpec[];
  filters: FilterNode[];
  filterMode: FilterMode;
  setSorts: (sorts: SortSpec[]) => void;
  setFilters: (filters: FilterNode[], mode: FilterMode) => void;

  load: (view: View) => Promise<void>;
  reload: () => Promise<void>;

  // 字段
  addField: (type: FieldType, name?: string) => Promise<DatabaseField | null>;
  renameField: (id: string, name: string) => Promise<void>;
  changeFieldType: (id: string, type: FieldType) => Promise<void>;
  /** 把最近一次改类型前留存的列值（连同类型与 options）还原回去 */
  restoreFieldValues: (id: string) => Promise<void>;
  removeField: (id: string) => Promise<void>;
  setFieldWidth: (id: string, width: number) => Promise<void>;
  toggleFieldHidden: (id: string) => Promise<void>;
  reorderFields: (orderedIds: string[]) => Promise<void>;
  updateFieldOptions: (id: string, options: FieldOptions) => Promise<void>;
  addSelectOption: (id: string, name: string) => Promise<string | null>;
  removeSelectOption: (id: string, optionId: string) => Promise<void>;

  // 行
  /** 新建行；parentId 非空即建在该行之下（表格层级，超深/成环由 Rust 侧拒绝） */
  addRow: (parentId?: string | null) => Promise<DatabaseRow | null>;
  /** 批量建行（TSV 粘贴）：一次 IPC 一个事务 */
  addRows: (count: number) => Promise<DatabaseRow[]>;
  /** 删一行 = 进回收站（可在「已删除的行」里恢复） */
  removeRow: (id: string) => Promise<void>;
  /** 批量删行（多选删除）：一次 IPC 一个事务，同样进回收站 */
  removeRows: (ids: string[]) => Promise<number>;
  /** 回收站内容：打开「已删除的行」面板时才拉，平时不占内存也不增加读库次数 */
  trash: DatabaseTrashRow[];
  loadTrash: () => Promise<void>;
  /** 从回收站恢复一行，成功后回到表格并刷新回收站列表 */
  restoreRow: (id: string) => Promise<void>;
  /** 彻底删除回收站里的一行 */
  purgeRow: (id: string) => Promise<void>;
  /** 清空本表回收站，返回彻底删除的行数 */
  purgeTrash: () => Promise<number>;
  /** 复制所选行：新建行并复制其单元格值（含公式引用之外的存储值），返回新行 */
  duplicateRows: (ids: string[]) => Promise<DatabaseRow[]>;
  reorderRows: (orderedIds: string[]) => Promise<void>;
  /** 改父行（null = 升到顶层）：层级是行的结构属性，不进单元格 */
  setRowParent: (rowId: string, parentId: string | null) => Promise<void>;

  // 单元格
  setCell: (rowId: string, fieldId: string, value: CellValue) => Promise<void>;
  /** 批量写单元格（TSV 粘贴）：一次 IPC 一个事务 */
  setCellsMany: (updates: { rowId: string; fieldId: string; value: CellValue }[]) => Promise<void>;

  // 行详情（右侧滑出面板）
  rowDetail: { row: DatabaseRow; view: View } | null;
  /** host：宿主页面视图（派生视图不带子节点，行详情文档一律挂在宿主下） */
  openRowDetail: (row: DatabaseRow, host: View) => Promise<void>;
  closeRowDetail: () => void;
}

// 并发 load/reload 只允许最新一次写入：快速切换视图时慢请求的旧数据不能盖住新视图
// （loadSeq 属于 store 实例，随工厂闭包各自持有）

/** 清除所有单元格对已删除选项的引用（单选置 null / 多选剔除该项）并逐行落库。
 *  字段设置弹窗与单元格下拉两条删除选项的路径共用，否则弹窗路径会留下悬空 id。 */
async function clearRemovedOptionRefs(
  set: (partial: Partial<DatabaseState>) => void,
  get: () => DatabaseState,
  fieldId: string,
  removed: string[],
) {
  const gone = new Set(removed);
  const prev = get().cells;
  const cells: Record<string, Record<string, CellValue>> = { ...prev };
  const changed: { rowId: string; value: CellValue }[] = [];
  for (const [rowId, prevRow] of Object.entries(prev)) {
    // 与 setCell 同理：行映射逐行浅拷贝，不复用旧 state 的行对象
    let rowCells = prevRow;
    let copied = false;
    const v = prevRow[fieldId];
    if (typeof v === "string" && gone.has(v)) {
      rowCells = { ...prevRow, [fieldId]: null };
      copied = true;
      changed.push({ rowId, value: null });
    } else if (Array.isArray(v) && v.some((x) => typeof x === "string" && gone.has(x))) {
      // 只清引用该选项字符串 id 的元素；附件等对象型数组项原样保留
      const next = v.filter((x) => typeof x !== "string" || !gone.has(x));
      rowCells = { ...prevRow, [fieldId]: next };
      copied = true;
      changed.push({ rowId, value: next });
    }
    if (copied) cells[rowId] = rowCells;
  }
  if (changed.length === 0) return;
  set({ cells });
  for (const c of changed) await databaseApi.setCell(c.rowId, fieldId, c.value);
}

/** 重名判定：忽略首尾空白与大小写（与公式引用的按名解析宽松度一致）；exceptId 排除被改名的字段自身 */
function hasDuplicateName(fields: DatabaseField[], name: string, exceptId: string | null): boolean {
  const key = name.trim().toLowerCase();
  return fields.some((f) => f.id !== exceptId && f.name.trim().toLowerCase() === key);
}

/**
 * 关联列选定/改指目标表：本列 options 与对端的反向关系列必须一起落库，所以走单命令事务，
 * 而不是「先写本列、再建对端列」两步——中间失败就留下指向对端、对端没有回指列的半配对。
 * 传进去的 reverseId 只在这次真的建了新列时才落库：返回值里的反向列 id 等于它 = 新建，否则是复用旧列。
 * 失败不做乐观更新：半配对的列在界面上看着正常、数据其实没写，比一条报错更难查。
 */
async function pairRelationTarget(
  set: (partial: Partial<DatabaseState>) => void,
  get: () => DatabaseState,
  field: DatabaseField,
  targetViewId: string,
) {
  const reverseId = newId();
  let out: Awaited<ReturnType<typeof databaseApi.pairRelationTarget>>;
  try {
    out = await databaseApi.pairRelationTarget(field.id, targetViewId, reverseId, field.name);
  } catch (err) {
    logger.error("relation.pair", err);
    toast.error(t("field.pairFailed", { message: String(err) }));
    return;
  }
  set({ fields: get().fields.map((f) => (f.id === field.id ? out.relation_field : f)) });
  // 目标表多了一条（或换了）反向列：它在 relation 缓存里的快照要重拉，否则对端看不到新列
  const targetHost = parseFieldOptions(out.relation_field.options);
  if (targetHost.kind === "relation" && targetHost.target_view_id) {
    useRelationStore.getState().invalidate([targetHost.target_view_id]);
  }
  if (out.reverse_field_id === reverseId) toast.success(t("field.reverseCreated", { name: field.name }));
}

export type DatabaseStore = ReturnType<typeof createDatabaseStore>;

/**
 * 把一份 store 实例接到「外部改库」通知上：AI 的写动作直接调 databaseApi 落数据，
 * 界面这侧没有任何操作会触发重取，不接就会出现「点了应用、表格却没变」。
 * 由页面挂载时订阅、卸载时解绑：写在 store 工厂里的话，StrictMode 的二次挂载会把它解掉且不再接回。
 */
export function bindDatabaseChanges(store: DatabaseStore): () => void {
  return onDatabaseChanged((hosts) => {
    const state = store.getState();
    const view = state.view;
    // 派生视图的数据挂在宿主上，按宿主 id 比对
    if (!view || !hosts.includes(view.source_id ?? view.id)) return;
    state.reload().catch((e: unknown) => logger.warn("database.external-reload", e));
  });
}

/** 新建一个数据库 store 实例：每个数据库页（DatabasePage）持有一份，并排时互不干扰 */
export function createDatabaseStore() {
  // 并发 load/reload 只允许最新一次写入：本实例内快速切换视图时慢请求的旧数据不能盖住新视图
  let loadSeq = 0;

  return create<DatabaseState>()((setRaw, get) => {
    // 字段/行/单元格的任何变化都可能被其它库的关联/汇总/反向关系列读到：
    // 统一在写入口失效本库在 relation 缓存里的快照（派生视图的数据挂在宿主上，按宿主 id 失效），
    // 否则对端会一直显示首次拉取时的旧数据。
    const set: typeof setRaw = (partial) => {
      const prev = get();
      setRaw(partial);
      const next = get();
      if (next.fields !== prev.fields || next.rows !== prev.rows || next.cells !== prev.cells) {
        const view = next.view;
        useRelationStore.getState().invalidate(view ? [view.source_id ?? view.id] : undefined);
      }
    };
    return {
      viewId: null,
      view: null,
      fields: [],
      rows: [],
      cells: {},
      trash: [],
      loading: false,
      sorts: [],
      filters: [],
      filterMode: "and",
      rowDetail: null,

      setSorts: (sorts) => {
        set({ sorts });
        const view = get().view;
        if (view) patchViewConfig(view, { sorts });
      },
      setFilters: (filters, filterMode) => {
        set({ filters, filterMode });
        const view = get().view;
        if (view) patchViewConfig(view, { filters, filterMode });
      },

      load: async (view) => {
        const viewId = view.id;
        if (get().viewId === viewId && get().fields.length > 0) return;
        const seq = ++loadSeq;
        const cfg = readViewConfig(view);
        set({
          loading: true,
          view,
          viewId,
          trash: [],
          sorts: cfg.sorts ?? [],
          filters: cfg.filters ?? [],
          filterMode: cfg.filterMode ?? "and",
        });
        try {
          const [fields, rows, cells] = await Promise.all([
            databaseApi.listFields(viewId),
            databaseApi.listRows(viewId),
            databaseApi.loadCells(viewId),
          ]);
          // 等待期间已切到别的视图（viewId 变了）或有更新的请求 → 丢弃本次结果，不碰 loading
          if (seq !== loadSeq || get().viewId !== viewId) return;
          set({ fields, rows, cells, loading: false });
          // 自愈：extra 里可能残留已删除字段的排序/筛选引用（旧版 removeField 未持久化清理），
          // 悬空引用会让排序条显示条目但表头无箭头、数据也不排序。按现有字段过滤并回写。
          const ids = new Set(fields.map((f) => f.id));
          const cur = get();
          const nextSorts = cur.sorts.filter((s) => ids.has(s.field_id));
          const nextFilters = pruneFiltersByFields(cur.filters, ids);
          if (nextSorts.length !== cur.sorts.length || nextFilters.length !== cur.filters.length) {
            set({ sorts: nextSorts, filters: nextFilters });
            patchViewConfig(view, { sorts: nextSorts, filters: nextFilters });
          }
        } catch (e) {
          if (seq === loadSeq) {
            logger.error("database.load", e);
            toast.error(t("error.db", { message: String(e) }));
            set({ loading: false });
          }
          throw e;
        }
      },

      reload: async () => {
        const viewId = get().viewId;
        if (!viewId) return;
        const seq = ++loadSeq;
        const [fields, rows, cells] = await Promise.all([
          databaseApi.listFields(viewId),
          databaseApi.listRows(viewId),
          databaseApi.loadCells(viewId),
        ]);
        if (seq !== loadSeq || get().viewId !== viewId) return;
        set({ fields, rows, cells });
      },

      addField: async (type, name) => {
        const viewId = get().viewId;
        if (!viewId) return null;
        // 公式以 {字段名} 引用字段，同名会让引用二义（求值时第一个胜出）：建档时就拦下
        const trimmed = name?.trim();
        if (trimmed && hasDuplicateName(get().fields, trimmed, null)) {
          toast.error(t("field.nameDuplicate", { name: trimmed }));
          return null;
        }
        const field = await databaseApi.createField(viewId, type, name);
        set({ fields: [...get().fields, field] });
        return field;
      },

      renameField: async (id, name) => {
        const trimmed = name.trim();
        // 空白名直接丢弃：持久层入口校验会拒空，UI 侧不该把报错抛给用户
        if (!trimmed) return;
        if (hasDuplicateName(get().fields, trimmed, id)) {
          toast.error(t("field.nameDuplicate", { name: trimmed }));
          return;
        }
        const before = get().fields.find((f) => f.id === id);
        await databaseApi.renameField(id, trimmed);
        set({ fields: get().fields.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) });
        if (!before || before.name === trimmed) return;
        // 公式以 {字段名} 引用：不同步改写的话，重命名会让引用该字段的公式全部变空
        const formulas = get().fields.filter((f) => f.id !== id && parseFieldOptions(f.options).kind === "formula");
        for (const f of formulas) {
          const opts = parseFieldOptions(f.options);
          if (opts.kind !== "formula") continue;
          const next = renameFormulaRef(opts.formula, before.name, trimmed);
          if (next === opts.formula) continue;
          await get().updateFieldOptions(f.id, { ...opts, formula: next });
        }
      },

      changeFieldType: async (id, type) => {
        const field = get().fields.find((f) => f.id === id);
        if (!field || field.field_type === type) return; // 同类型重选：不清列、不重置选项
        const preserved = await databaseApi.changeFieldType(id, type);
        await get().reload();
        if (preserved <= 0) return;
        // 整列被清空这件事当场看不出来（只是变的一片空），所以要出声并给一键退路：
        // 后端按字段留存最近一次改类型前的取值与定义，撤销即原样换回
        toast.message(t("field.typeClearedKeep", { name: field.name, n: String(preserved) }), {
          duration: 8000,
          action: {
            label: t("field.undoTypeChange"),
            onClick: () => void get().restoreFieldValues(id),
          },
        });
      },

      restoreFieldValues: async (id) => {
        const name = get().fields.find((f) => f.id === id)?.name ?? "";
        try {
          const restored = await databaseApi.restoreFieldValues(id);
          await get().reload();
          toast.success(t("field.typeChangeRestored", { name, n: String(restored) }));
        } catch (e) {
          logger.error("restore field values failed", e);
          toast.error(t("error.db", { message: String(e) }));
        }
      },

      removeField: async (id) => {
        await databaseApi.deleteField(id);
        set({ fields: get().fields.filter((f) => f.id !== id) });
        // 清理本地单元格缓存与排序/筛选引用
        const cells = { ...get().cells };
        for (const rowId of Object.keys(cells)) {
          const { [id]: _removed, ...rest } = cells[rowId];
          cells[rowId] = rest;
        }
        const sorts = get().sorts.filter((s) => s.field_id !== id);
        const filters = pruneFiltersByFields(get().filters, new Set(get().fields.map((f) => f.id)));
        set({ cells, sorts, filters });
        // 必须同步回写 extra：只改内存的话，重开页面仍会读回已删字段的排序/筛选（悬空引用）
        const view = get().view;
        if (view) patchViewConfig(view, { sorts, filters });
      },

      setFieldWidth: async (id, width) => {
        await databaseApi.setFieldWidth(id, width);
        set({ fields: get().fields.map((f) => (f.id === id ? { ...f, width } : f)) });
      },

      toggleFieldHidden: async (id) => {
        const field = get().fields.find((f) => f.id === id);
        if (!field) return;
        await databaseApi.setFieldHidden(id, field.is_hidden === 0);
        set({ fields: get().fields.map((f) => (f.id === id ? { ...f, is_hidden: f.is_hidden === 0 ? 1 : 0 } : f)) });
      },

      reorderFields: async (orderedIds) => {
        const viewId = get().viewId;
        if (!viewId) return;
        await databaseApi.reorderFields(viewId, orderedIds);
        const byId = new Map(get().fields.map((f) => [f.id, f]));
        set({
          fields: orderedIds.flatMap((id, i) => {
            const field = byId.get(id);
            return field ? [{ ...field, position: i }] : [];
          }),
        });
      },

      updateFieldOptions: async (id, options) => {
        const before = get().fields.find((f) => f.id === id);
        // 关联列的所有 options 保存都改走配对命令：它写的就是同一份 options（外加 paired_field_id），
        // 绕过去单独保存会把配对信息静默抹掉，下次改目标表就会重复建列。
        if (before?.field_type === "relation" && options.kind === "relation" && options.target_view_id) {
          await pairRelationTarget(set, get, before, options.target_view_id);
          return;
        }
        await databaseApi.updateFieldOptions(id, options);
        set({ fields: get().fields.map((f) => (f.id === id ? { ...f, options: JSON.stringify(options) } : f)) });
        if (!before) return;
        const prev = parseFieldOptions(before.options);
        if (prev.kind !== "select" || options.kind !== "select") return;
        const kept = new Set(options.options.map((o) => o.id));
        const removed = prev.options.filter((o) => !kept.has(o.id)).map((o) => o.id);
        if (removed.length > 0) await clearRemovedOptionRefs(set, get, id, removed);
      },

      addSelectOption: async (id, name) => {
        const field = get().fields.find((f) => f.id === id);
        if (!field) return null;
        const opts = parseFieldOptions(field.options);
        if (opts.kind !== "select") return null;
        // 状态字段新建的选项（粘贴 / 筛选输入等）默认落在「待办」阶段
        const option = newSelectOption(name, field.field_type === "status" ? "todo" : undefined);
        const next: FieldOptions = { ...opts, options: [...opts.options, option] };
        await databaseApi.updateFieldOptions(id, next);
        set({ fields: get().fields.map((f) => (f.id === id ? { ...f, options: JSON.stringify(next) } : f)) });
        return option.id;
      },

      /** 删除选项：从字段 options 移除（单元格清理统一由 updateFieldOptions 完成） */
      removeSelectOption: async (id, optionId) => {
        const field = get().fields.find((f) => f.id === id);
        if (!field) return;
        const opts = parseFieldOptions(field.options);
        if (opts.kind !== "select") return;
        await get().updateFieldOptions(id, { ...opts, options: opts.options.filter((o) => o.id !== optionId) });
      },

      addRow: async (parentId) => {
        const viewId = get().viewId;
        if (!viewId) return null;
        const row = await databaseApi.createRow(viewId, parentId ?? null);
        set({ rows: [...get().rows, row] });
        return row;
      },

      addRows: async (count) => {
        const viewId = get().viewId;
        if (!viewId || count <= 0) return [];
        const created = await databaseApi.createRows(viewId, count);
        set({ rows: [...get().rows, ...created] });
        return created;
      },

      removeRow: async (id) => {
        await databaseApi.deleteRow(id);
        set({ rows: compactRowPositions(get().rows.filter((r) => r.id !== id)) });
      },

      removeRows: async (ids) => {
        if (ids.length === 0) return 0;
        const gone = new Set(ids);
        const n = await databaseApi.deleteRows(ids);
        const cells = Object.fromEntries(Object.entries(get().cells).filter(([rowId]) => !gone.has(rowId)));
        set({ rows: compactRowPositions(get().rows.filter((r) => !gone.has(r.id))), cells });
        return n;
      },

      loadTrash: async () => {
        const viewId = get().viewId;
        if (!viewId) return;
        set({ trash: await databaseApi.listTrash(viewId) });
      },

      restoreRow: async (id) => {
        await databaseApi.restoreRow(id);
        // 整表重拉：恢复行的单元格、行号都在后端算，前端不自己拼（避免与 compact 规则跑偏）
        await get().reload();
        await get().loadTrash();
      },

      purgeRow: async (id) => {
        await databaseApi.purgeRow(id);
        set({ trash: get().trash.filter((r) => r.id !== id) });
      },

      purgeTrash: async () => {
        const viewId = get().viewId;
        if (!viewId) return 0;
        const n = await databaseApi.purgeTrash(viewId);
        set({ trash: [] });
        return n;
      },

      duplicateRows: async (ids) => {
        const viewId = get().viewId;
        if (!viewId || ids.length === 0) return [];
        // 新行顺序按当前表格行序（store 顺序 = position 顺序，与选择顺序无关）
        const src = new Set(ids);
        const ordered = get().rows.filter((r) => src.has(r.id));
        if (ordered.length === 0) return [];
        const created = await databaseApi.createRows(viewId, ordered.length);
        // 逐行搬运存储值：新行 id 与源行 id 一一对应
        const updates: { rowId: string; fieldId: string; value: CellValue }[] = [];
        for (let i = 0; i < ordered.length; i++) {
          const rowCells = get().cells[ordered[i].id] ?? {};
          for (const [fieldId, value] of Object.entries(rowCells)) {
            updates.push({ rowId: created[i].id, fieldId, value });
          }
        }
        if (updates.length > 0) {
          await databaseApi.setCellsMany(updates);
          const cells = { ...get().cells };
          for (const u of updates) {
            cells[u.rowId] = { ...(cells[u.rowId] ?? {}), [u.fieldId]: u.value };
          }
          set({ cells });
        }
        // 父子关系跟着复制走：同批里复制出来的父行换成新父行，父行没被勾选的仍挂原父行下。
        // 单条挂接失败只让那一个副本留在顶层，不该毁掉整次复制（值已经搬完了）
        const parents = duplicateParentMap(
          get().rows,
          ordered.map((r) => r.id),
          created.map((r) => r.id),
        );
        const newRows = [...created];
        for (let i = 0; i < newRows.length; i++) {
          const parentId = parents[i];
          if (!parentId) continue;
          try {
            await databaseApi.setRowParent(newRows[i].id, parentId);
            newRows[i] = { ...newRows[i], parent_id: parentId };
          } catch (e) {
            logger.error("duplicate row parent failed", e);
          }
        }
        set({ rows: [...get().rows, ...newRows] });
        return newRows;
      },

      reorderRows: async (orderedIds) => {
        const viewId = get().viewId;
        if (!viewId) return;
        await databaseApi.reorderRows(viewId, orderedIds);
        const byId = new Map(get().rows.map((r) => [r.id, r]));
        set({
          rows: orderedIds.flatMap((id, i) => {
            const row = byId.get(id);
            return row ? [{ ...row, position: i }] : [];
          }),
        });
      },

      setRowParent: async (rowId, parentId) => {
        await databaseApi.setRowParent(rowId, parentId);
        // 行映射整体换新：原地改旧 state 的行对象会让按引用比较的记忆化消费方漏掉更新
        const rows = get().rows.map((r) => (r.id === rowId ? { ...r, parent_id: parentId } : r));
        const detail = get().rowDetail;
        const updated = rows.find((r) => r.id === rowId);
        set({
          rows,
          // 详情面板读的是 rowDetail.row，这份也要跟着换，否则改完父行面板上还挂着旧的
          rowDetail: detail && updated && detail.row.id === rowId ? { ...detail, row: updated } : detail,
        });
      },

      setCell: async (rowId, fieldId, value) => {
        // 同值提交直接跳过：点开单元格再点出去不该产生一次 IPC + 关系快照失效
        const prev = get().cells;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
        if (sameCellValue(prev[rowId]?.[fieldId] ?? null, value)) return;
        // 值形态与字段类型对不上就不落库：读的时候才会炸，写进来才是病灶
        const field = get().fields.find((f) => f.id === fieldId);
        if (!cellWriteTypeSafe(field, value)) {
          logger.warn("cell write rejected: value type mismatch", fieldId, field?.field_type);
          toast.error(t("cell.typeMismatch", { field: field?.name ?? fieldId }));
          return;
        }
        await databaseApi.setCell(rowId, fieldId, value);
        // 行映射整体换新：原地改旧 state 的行对象会让按引用比较的记忆化消费方漏掉更新
        set({ cells: { ...prev, [rowId]: { ...(prev[rowId] ?? {}), [fieldId]: value } } });
      },

      setCellsMany: async (updates) => {
        const cur = get().cells;
        const effective = updates.filter((u) => {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cells 为按行稀疏映射，无单元格的行没有条目（运行时可能 undefined）
          return !sameCellValue(cur[u.rowId]?.[u.fieldId] ?? null, u.value);
        });
        if (effective.length === 0) return;
        // 批量写入（粘贴 / 批量改值）里只剔除类型不符的那几格，其余照常落库
        const fields = get().fields;
        const accepted = effective.filter((u) =>
          cellWriteTypeSafe(
            fields.find((f) => f.id === u.fieldId),
            u.value,
          ),
        );
        const skipped = effective.length - accepted.length;
        if (skipped > 0) {
          logger.warn("cell writes rejected: value type mismatch", skipped);
          toast.error(t("cell.typeMismatchSkipped", { count: String(skipped) }));
        }
        if (accepted.length === 0) return;
        await databaseApi.setCellsMany(accepted);
        const cells = { ...cur };
        for (const u of accepted) {
          // 逐行浅拷贝后替换：不原地改上一份 state 里的对象
          const rowCells = { ...(cells[u.rowId] ?? {}) };
          rowCells[u.fieldId] = u.value;
          cells[u.rowId] = rowCells;
        }
        set({ cells });
      },

      openRowDetail: async (row, host) => {
        try {
          // 用最新行数据（document_id 可能已被之前会话更新，store 里是旧副本）
          const fresh = await databaseApi.getRow(row.id);
          if (!fresh) throw new Error("row missing: " + row.id);
          row = fresh;
          if (!row.document_id) {
            // 首次打开：创建行详情文档 view（extra 标记 row_detail，说明书 12 节风险 7）
            const name = t("row.detailName", { n: row.position + 1 });
            const view = await viewApi.create({
              workspace_id: host.workspace_id,
              parent_id: host.id,
              name,
              layout: "document",
              extra: JSON.stringify({ row_detail: true }),
            });
            await databaseApi.setRowDocumentId(row.id, view.id);
            // 同步 store 里的行（document_id 绑定）
            const bound = { ...row, document_id: view.id };
            set({ rows: get().rows.map((r) => (r.id === bound.id ? bound : r)), rowDetail: { row: bound, view } });
          } else {
            // 已有文档：从库中读回 view（含名称等）
            const view = await viewApi.get(row.document_id);
            if (!view) throw new Error("row detail view missing: " + row.document_id);
            set({ rowDetail: { row, view } });
          }
        } catch (e) {
          logger.error("open row detail failed", e);
          toast.error(t("error.db", { message: String(e) }));
        }
      },

      closeRowDetail: () => set({ rowDetail: null }),
    };
  });
}

/** 全局默认实例：测试与未显式提供 Provider 的场景使用 */
export const useDatabaseStore = createDatabaseStore();
