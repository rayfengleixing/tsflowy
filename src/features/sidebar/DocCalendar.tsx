import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, ChevronDown, ChevronUp } from "lucide-react";
import { viewApi } from "@/lib/db";
import { useWorkspaceStore } from "@/stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { viewIcon } from "@/components/view-icon";
import { t } from "@/lib/i18n";
import type { View } from "@/types/models";

const STORAGE_KEY = "tsflowy:ui:doc_calendar_expanded";

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

interface CalendarCell {
year: number;
month: number; // 1-12
day: number | null; // null = 占位
dateKey: string | null; // "YYYY-MM-DD"
}

/**
* 基于日期范围生成 6×7 月网格（与 board-calendar.ts 同形态逻辑，独立实现以避免对数据库 values 模块耦合）。
* 一周起始：周一（Chinese convention）。
*/
function buildMonthCells(year: number, month: number): CalendarCell[] {
const firstDay = new Date(year, month - 1, 1);
// 周一 = 0 → 通过 (dayOfWeek + 6) % 7 平移（Sun(0) → 6, Mon(1) → 0）
const leading = (firstDay.getDay() + 6) % 7;
const daysInMonth = new Date(year, month, 0).getDate();
const cells: CalendarCell[] = [];
for (let i = 0; i < leading; i++) cells.push({ year, month, day: null, dateKey: null });
for (let d = 1; d <= daysInMonth; d++) {
const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
cells.push({ year, month, day: d, dateKey: key });
}
// 补齐尾部直到 6 行 = 42 格
while (cells.length < 42) cells.push({ year, month, day: null, dateKey: null });
return cells;
}

/**
* 文档日历（Phase 4.4）：按 views.updated_at 将 document 视图聚合到月视图格子。
*
* 数据源：`viewApi.listByWorkspace(workspaceId)` → 仅挑 layout===document && !is_trash。
* 性能：workspace 页数量通常 < 10k，客户端聚合在毫秒级，无需额外 SQL。
*
* 交互：点击日期格展开当日文档列表；点击文档 → openView 打开；今日 badge 高亮。
*/
export function DocCalendar() {
const { currentWorkspaceId, openView, openDailyNote } = useWorkspaceStore(
useShallow((s) => ({ currentWorkspaceId: s.currentWorkspaceId, openView: s.openView, openDailyNote: s.openDailyNote })),
);

const computeToday = () => {
const d = new Date();
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const [today, setToday] = useState<string>(() => computeToday());

const [year, setYear] = useState<number>(new Date().getFullYear());
const [month, setMonth] = useState<number>(new Date().getMonth() + 1);
const [views, setViews] = useState<View[]>([]);
const [expandedDate, setExpandedDate] = useState<string | null>(null);
// P2#7：默认收起（localStorage 记忆）以减少 listByWorkspace 请求
const [expanded, setExpanded] = useState<boolean>(() => {
try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
});
const midnightTimer = useRef<number | null>(null);
const viewsLoadedRef = useRef(false);

// P2#6：零点刷新 today（最近下一次零点）
useEffect(() => {
const schedule = () => {
const now = new Date();
const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 100);
const wait = next.getTime() - now.getTime();
midnightTimer.current = window.setTimeout(() => {
setToday(computeToday());
// 同时跳到新月份（若今天跨了月）
setYear(next.getFullYear());
setMonth(next.getMonth() + 1);
schedule();
}, wait);
};
schedule();
return () => {
if (midnightTimer.current !== null) {
window.clearTimeout(midnightTimer.current);
midnightTimer.current = null;
}
};
}, []);

// P2#7：仅在 expanded=true 时拉取 views；currentWorkspaceId 变化后也只在展开下重载
useEffect(() => {
if (!currentWorkspaceId) { setViews([]); viewsLoadedRef.current = false; return; }
if (!expanded) { viewsLoadedRef.current = false; return; }
if (viewsLoadedRef.current) return;
viewsLoadedRef.current = true;
let alive = true;
void (async () => {
try {
const rows = await viewApi.listByWorkspace(currentWorkspaceId);
if (!alive) return;
const docs = rows.filter((v) => v.layout === "document" && v.is_trash === 0);
setViews(docs);
} catch (e) {
console.warn("DocCalendar list failed", e);
}
})();
return () => { alive = false; };
}, [currentWorkspaceId, expanded]);

// 用户手动展开时若尚未加载，立刻触发一次
const toggleExpanded = () => {
const next = !expanded;
setExpanded(next);
try { localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
if (next && !viewsLoadedRef.current && currentWorkspaceId) {
viewsLoadedRef.current = true;
viewApi.listByWorkspace(currentWorkspaceId)
.then((rows) => {
const docs = rows.filter((v) => v.layout === "document" && v.is_trash === 0);
setViews(docs);
})
.catch((e) => console.warn("DocCalendar list failed", e));
}
};

// 按月聚合文档（按 updated_at 日期 bucket）
const docsByDate = useMemo(() => {
const map = new Map<string, View[]>();
for (const v of views) {
if (!v.updated_at) continue;
const d = new Date(v.updated_at);
const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const arr = map.get(key) ?? [];
arr.push(v);
map.set(key, arr);
}
return map;
}, [views]);

const cells = useMemo(() => buildMonthCells(year, month), [year, month]);

const gotoPrev = () => {
if (month === 1) { setYear((y) => y - 1); setMonth(12); }
else setMonth((m) => m - 1);
};
const gotoNext = () => {
if (month === 12) { setYear((y) => y + 1); setMonth(1); }
else setMonth((m) => m + 1);
};

return (
<div className="border-t border-neutral-200 px-2 pb-2 pt-1.5">
{/* 折叠标题行：点击整行切换展开；右侧放"今日"按钮 + 展开箭头 */}
<div
role="button"
tabIndex={0}
onClick={toggleExpanded}
onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(); } }}
className="flex cursor-pointer items-center justify-between rounded-md px-1 py-1 hover:bg-neutral-100"
>
<div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
<CalendarDays className="h-3 w-3" />
<span>文档日历</span>
{expanded ? (
<ChevronUp className="h-3 w-3 text-neutral-400" />
) : (
<ChevronDown className="h-3 w-3 text-neutral-400" />
)}
</div>
{/* 未展开也提供一个直达"今日笔记"入口，不展开也能点 */}
<button
type="button"
onClick={(e) => { e.stopPropagation(); void openDailyNote(); }}
className="inline-flex h-5 items-center rounded bg-brand-50 px-1.5 text-[10px] font-medium text-brand-700 hover:bg-brand-100"
title={t("sidebar.tab.recent") + "(今日)"}
>
今日
</button>
</div>

{expanded && (
<>
{/* 标题栏 / 月份导航 */}
<div className="my-1.5 flex items-center justify-end gap-1 text-[12px] text-neutral-700">
<button
type="button"
onClick={gotoPrev}
className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
aria-label="上个月"
>
<ChevronLeft className="h-3.5 w-3.5" />
</button>
<span className="min-w-[64px] text-center font-medium tabular-nums">
{year}年{month}月
</span>
<button
type="button"
onClick={gotoNext}
className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
aria-label="下个月"
>
<ChevronRight className="h-3.5 w-3.5" />
</button>
</div>

{/* 星期表头 */}
<div className="mb-0.5 grid grid-cols-7 gap-0.5 text-center text-[10px] text-neutral-400">
{WEEK_LABELS.map((w) => <div key={w} className="py-0.5">{w}</div>)}
</div>

{/* 日期格 */}
<div className="grid grid-cols-7 gap-0.5">
{cells.map((c, i) => {
if (!c.day || !c.dateKey) {
return <div key={`${c.year}-${c.month}-${i}`} className="h-[24px]" />;
}
const docs = docsByDate.get(c.dateKey) ?? [];
const count = docs.length;
const isToday = c.dateKey === today;
const cellOpen = expandedDate === c.dateKey;
return (
<div key={c.dateKey} className="relative">
<button
type="button"
onClick={() => {
setExpandedDate(cellOpen ? null : c.dateKey!);
if (count === 0) void openDailyNote(new Date(c.year, c.month - 1, c.day!));
}}
className={[
"flex h-[24px] w-full items-center justify-center rounded text-[10px] tabular-nums transition",
isToday
? "bg-brand-500 text-white font-semibold"
: count > 0
? "bg-brand-50 text-brand-700 font-medium hover:bg-brand-100"
: "text-neutral-500 hover:bg-neutral-100",
].join(" ")}
>
{c.day}
</button>
{count > 0 && (
<span
className="pointer-events-none absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-brand-500"
title={`${count} 篇文档`}
/>
)}
{cellOpen && count > 0 && (
<div className="absolute left-0 right-0 z-30 mt-0.5 max-h-40 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg">
<ul className="divide-y divide-neutral-100">
{docs
.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
.map((v) => (
<li key={v.id}>
<button
type="button"
onClick={() => { openView(v.id); setExpandedDate(null); }}
className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-neutral-100"
>
<span className="flex w-4 shrink-0 items-center justify-center text-neutral-500">
{viewIcon(v)}
</span>
<span className="truncate text-[11px] text-neutral-700">
{v.name || "(Untitled)"}
</span>
</button>
</li>
))}
</ul>
</div>
)}
</div>
);
})}
</div>
</>
)}
</div>
);
}
