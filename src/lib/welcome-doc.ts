import type { JSONContent } from "@tiptap/core";

// 首次启动种子数据里的欢迎文档（workspace.init 首次建库时写入）。
// 文档本身是一份「功能示例 + 使用说明」：首行 H1 即页面名（编辑区修改会反向同步），
// 第二行固定分割线，与编辑器结构锁定一致。
//
// 节点/标记形状必须与 EditorPage 注册的 schema 对齐，
// 由 welcome-doc.test.ts 用真实 TipTap schema 校验（防首次打开就报 Invalid content）。

export type WelcomeLang = "zh-CN" | "en-US";

const text = (t: string, marks?: JSONContent["marks"]): JSONContent =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const h2 = (t: string): JSONContent => ({ type: "heading", attrs: { level: 2 }, content: [text(t)] });
const h3 = (t: string): JSONContent => ({ type: "heading", attrs: { level: 3 }, content: [text(t)] });

const bullets = (items: string[]): JSONContent => ({
  type: "bulletList",
  content: items.map((i) => ({ type: "listItem", content: [p(text(i))] })),
});

const ordered = (items: string[]): JSONContent => ({
  type: "orderedList",
  content: items.map((i) => ({ type: "listItem", content: [p(text(i))] })),
});

const tasks = (items: { checked: boolean; label: string }[]): JSONContent => ({
  type: "taskList",
  content: items.map((i) => ({
    type: "taskItem",
    attrs: { checked: i.checked },
    content: [p(text(i.label))],
  })),
});

const quote = (t: string): JSONContent => ({ type: "blockquote", content: [p(text(t))] });

const code = (language: string, source: string): JSONContent => ({
  type: "codeBlock",
  attrs: { language },
  content: [text(source)],
});

const math = (tex: string): JSONContent => ({ type: "math", attrs: { tex } });

const callout = (emoji: string, t: string): JSONContent => ({
  type: "callout",
  attrs: { emoji, color: "blue" },
  content: [p(text(t))],
});

const toggle = (title: string, body: string): JSONContent => ({
  type: "toggle",
  attrs: { collapsed: false },
  content: [p(text(title)), p(text(body))],
});

/** 表格：rows[0] 为表头 */
const table = (rows: string[][]): JSONContent => ({
  type: "table",
  content: rows.map((row, ri) => ({
    type: "tableRow",
    content: row.map((cell) => ({
      type: ri === 0 ? "tableHeader" : "tableCell",
      content: [p(text(cell))],
    })),
  })),
});

export function welcomeDocTitle(lang: WelcomeLang): string {
  return lang === "zh-CN" ? "欢迎使用 TsFlowy" : "Welcome to TsFlowy";
}

export function buildWelcomeDoc(lang: WelcomeLang): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [text(welcomeDocTitle(lang))] },
      { type: "horizontalRule" },
      ...(lang === "zh-CN" ? zhBody() : enBody()),
    ],
  };
}

function zhBody(): JSONContent[] {
  return [
    p(
      text(
        "TsFlowy 是一款本地优先的桌面笔记与知识管理应用：文档写作、数据库（表格 / 看板 / 日历）、全局搜索都在这里完成。数据全部保存在你自己的电脑上，无需账号，也不依赖网络。",
      ),
    ),
    callout(
      "👋",
      "这篇文档本身就是一份示例，你可以随意编辑、删掉或把它当作模板。下面按功能分区介绍，并给出可以直接上手的操作。",
    ),

    h2("编辑器：把内容写舒服"),
    p(
      text("在编辑区输入 "),
      text("/", [{ type: "code" }]),
      text(
        " 可以呼出斜杠菜单，插入标题、列表、表格、代码块、图片、数据库等任意内容块；菜单里还有表情和目录入口；选中文字会出现浮动工具栏。",
      ),
    ),
    p(
      text("文字格式示例："),
      text("加粗", [{ type: "bold" }]),
      text("、"),
      text("斜体", [{ type: "italic" }]),
      text("、"),
      text("下划线", [{ type: "underline" }]),
      text("、"),
      text("删除线", [{ type: "strike" }]),
      text("、"),
      text("高亮", [{ type: "highlight" }]),
      text("、"),
      text("彩色文字", [{ type: "textStyle", attrs: { color: "#2563eb" } }]),
      text("，以及链接："),
      text("TsFlowy 项目主页", [{ type: "link", attrs: { href: "https://github.com/rayfengleixing/tsflowy" } }]),
      text("。"),
    ),

    h3("列表与任务"),
    bullets([
      "标题分三级（这篇文档里就有），块左侧的拖拽手柄可以把任意内容块拖去别处。",
      "无序列表、有序列表、任务清单都可以输入语法自动转换，或用 / 菜单插入。",
      "图片支持上传 / 粘贴 / 拖拽插入，双击放大（灯箱），菜单里的「多图相册」可以把多张图并排展示；附件单击即用系统默认程序打开。",
    ]),
    tasks([
      { checked: true, label: "试一下勾选这个任务" },
      { checked: false, label: "取消勾选，再勾选它" },
      { checked: false, label: "按 / 插入一个新块" },
    ]),
    ordered([
      "点击侧边栏「新建页面」创建文档或数据库",
      "输入 / 唤起菜单，插入你需要的块",
      "不用担心保存——每次改动都会自动写入本地",
    ]),

    h3("引用、代码与公式"),
    quote("好的工具应该让记录和整理都不费力。"),
    code("ts", 'const app = "TsFlowy";\nconsole.log(`${app}：本地优先的笔记应用`);'),
    math("e^{i\\pi} + 1 = 0"),

    h3("表格与折叠块"),
    toggle(
      "点左侧箭头展开 / 收起",
      "折叠块适合收纳次要内容——比如这段说明。表格、代码块、提示块等都可以在同一篇文档里混排；顶部提示框的 emoji 图标可以点开替换，正文里也能随时插入表情 😀。",
    ),

    h2("数据库：表格、看板、日历"),
    p(
      text(
        "在侧边栏点「新建页面」→ 选择「表格」即可创建一张数据库表。同一张表可以有多个视图：表格适合批量整理，看板适合按状态推进，日历适合按日期安排——每个视图各自保存筛选、排序和分组，互不影响。",
      ),
    ),
    bullets([
      "字段支持文本、数字、日期、单选、多选、复选框、URL、电话、邮箱，以及自动维护的创建时间 / 最后编辑时间。",
      "还有三种进阶字段：关联（引用其他表的一行或多行）、公式（用 {字段名} 组合计算，如 {单价} * {数量}）、汇总（把本行关联到的行里的数值求和 / 平均 / 计数）。",
      "表格视图可以按字段分组并显示小计，底部合计行可选汇总函数（求和 / 平均 / 计数等）。",
      "看板视图按单选字段分列，卡片上显示哪些字段由你决定。",
      "日历视图按日期字段铺排事项。",
    ]),
    p(text("在文档里用 / 菜单的「数据库表」还能把一张表嵌入当前页，就地预览。")),
    p(
      text(
        "上手建议：新建一个数据库页面，在表格视图里加几行数据，再点顶部的 + 新建一个看板视图，就能看到同一份数据的另一种排布。",
      ),
    ),

    h2("页面组织：标签、收藏、子页面、并排、历史"),
    bullets([
      "标签：编辑页面标签时用「/」分层（如 工作/项目A）；侧边栏「标签」页可以改颜色、重命名、删除，点标签即可筛选页面树。",
      "收藏：把常用页面收藏后，会汇总在侧边栏顶部的收藏区。",
      "子页面：在页面行右侧用「+」新建子页面，父页面正文最上方会自动列出子页面的双链列表，改名 / 移动 / 删除都会自动同步。",
      "并排对照：右键页面「在右侧打开（并排对照）」，两个页面左右并排；可拖动中间分隔条调整宽度，也可以左右互换。",
      "历史版本：右键「历史版本」可以查看编辑过程中自动保存的快照并一键恢复（恢复前会先备份当前内容）。",
      "删除的页面进入回收站保留 30 天，期间可随时恢复，或彻底删除。",
    ]),

    h2("每日笔记"),
    p(
      text(
        "侧边栏的「今日笔记」按钮会打开当天的笔记。每日笔记按「年 / 月 / 月-日 星期」分级收在同一个目录页下（如 每日笔记/2026/10/10-02 周五），每天一篇独立文档——搜索、标签、导出、备份都和普通页面一样。",
      ),
    ),
    p(
      text(
        "在「设置 → 每日笔记」里可以改目录页名称、新建笔记的模板（支持 # 小标题、- [ ] 待办、{{date}} 等占位符），以及是否在启动时自动打开今天的笔记。",
      ),
    ),

    h2("搜索与提及"),
    bullets([
      "全局搜索（Ctrl+Shift+F）覆盖页面标题、正文与数据库单元格，命中行可以直接定位。",
      "命令面板（Ctrl+K）快速跳转到任意页面，也能新建页面或打开今日笔记。",
      "输入 @ 可以提及任意页面：悬停预览、点击跳转，页面底部会列出引用它的反向链接。",
      "长文档可以在右侧打开大纲（H1–H3）快速跳转；/ 菜单的「目录」块则把目录直接嵌进正文。",
    ]),

    h2("导出、备份与设置"),
    bullets([
      "标签栏的导出菜单可以把当前页导出为 Markdown、长图或 PDF；数据库支持 CSV 导入导出。",
      "支持导入 Markdown 文件夹：按目录结构批量建页。",
      "设置里可以导出 / 导入完整备份（数据库 + 附件），也可以把数据目录迁移到自定义位置。",
      "主题支持浅色 / 深色 / 跟随系统，界面可切换中文 / English。",
    ]),

    h2("快捷键"),
    table([
      ["快捷键", "作用"],
      ["/", "插入内容块"],
      ["@", "提及页面"],
      ["Ctrl+K", "命令面板"],
      ["Ctrl+Shift+F", "全局搜索"],
      ["Ctrl+S", "立即保存"],
      ["Ctrl+B / I / U", "加粗 / 斜体 / 下划线"],
      ["Ctrl+T", "插入表格"],
    ]),

    h2("数据保存在哪里"),
    p(
      text(
        "所有数据默认保存在本机 %APPDATA%\\com.tsflowy.app 目录（appflowy.db 数据库 + assets 附件），不会上传到任何服务器。需要备份或迁移时，在设置中一键操作即可。",
      ),
    ),
    p(text("就从这篇文档开始吧——把它改成你想记的第一条内容，或者删掉它，新建属于你自己的页面。")),
  ];
}

function enBody(): JSONContent[] {
  return [
    p(
      text(
        "TsFlowy is a local-first desktop app for notes and knowledge management: documents, databases (table / board / calendar) and global search, all in one place. Everything is stored on your own computer — no account, no cloud required.",
      ),
    ),
    callout(
      "👋",
      "This document is a living example. Feel free to edit it, delete it, or use it as a template. Each section below covers one area of the app with quick hands-on steps.",
    ),

    h2("Editor: writing made comfortable"),
    p(
      text("Type "),
      text("/", [{ type: "code" }]),
      text(
        " to open the slash menu and insert headings, lists, tables, code blocks, images, databases and more — it also has emoji and an outline block. Select text to reveal the floating toolbar.",
      ),
    ),
    p(
      text("Text styles: "),
      text("bold", [{ type: "bold" }]),
      text(", "),
      text("italic", [{ type: "italic" }]),
      text(", "),
      text("underline", [{ type: "underline" }]),
      text(", "),
      text("strikethrough", [{ type: "strike" }]),
      text(", "),
      text("highlight", [{ type: "highlight" }]),
      text(", "),
      text("colored text", [{ type: "textStyle", attrs: { color: "#2563eb" } }]),
      text(", and links such as the "),
      text("TsFlowy repository", [{ type: "link", attrs: { href: "https://github.com/rayfengleixing/tsflowy" } }]),
      text("."),
    ),

    h3("Lists and tasks"),
    bullets([
      "Headings come in three levels — this document uses them.",
      "Bullet lists, numbered lists and to-dos all convert from typed syntax, or insert them from the slash menu.",
      "Drag the handle on the left of any block to move it around; images upload / paste / drag in, and double-click opens a lightbox. Attachments open with their default app on a single click.",
    ]),
    tasks([
      { checked: true, label: "Try checking this task off" },
      { checked: false, label: "Uncheck it and check it again" },
      { checked: false, label: "Press / to insert a new block" },
    ]),
    ordered([
      "Create a document or database from the sidebar",
      "Type / to open the menu and insert the blocks you need",
      "No need to worry about saving — every change lands on disk automatically",
    ]),

    h3("Quotes, code and math"),
    quote("A good tool should make capturing and organizing effortless."),
    code("ts", 'const app = "TsFlowy";\nconsole.log(`${app} — notes, made simple`);'),
    math("e^{i\\pi} + 1 = 0"),

    h3("Toggles and tables"),
    toggle(
      "Click the arrow to collapse or expand",
      "Toggles are handy for secondary details — like this note. Tables, code blocks and callouts can all live in the same document; the emoji on the callout above can be swapped with a click, and you can drop an emoji anywhere 😀.",
    ),

    h2("Databases: table, board, calendar"),
    p(
      text(
        "Create a database from the sidebar's new-page menu (the grid layout). One database can have several views: tables for bulk editing, boards for tracking status, calendars for scheduling — each view keeps its own filters, sorts and grouping.",
      ),
    ),
    bullets([
      "Fields: text, number, date, single select, multi select, checkbox, URL, phone, email, plus auto-maintained created / last-edited time.",
      "Three advanced field types: Relation (link rows in another table), Formula (combine fields like {Unit price} * {Quantity}) and Rollup (sum / average / count a number across the related rows).",
      "Table view groups by any field with subtotals, and the footer row offers per-column aggregates.",
      "Board view splits by a single-select field, and you choose which fields appear on cards.",
      "Calendar view lays items out by a date field.",
    ]),
    p(text("You can also embed a database in a document from the / menu — it shows a live preview right in the page.")),
    p(
      text(
        "Try it: create a database page, add a few rows in the table view, then click + at the top to add a board view — same data, a different layout.",
      ),
    ),

    h2("Organizing pages: tags, favorites, sub-pages, split view, history"),
    bullets([
      "Tags: use 「/」 to nest them (like Work/Project A). The Tags panel in the sidebar lets you recolor, rename and delete tags, and clicking a tag filters the page tree.",
      "Favorites: star the pages you use often — they collect in the Favorites section at the top of the sidebar.",
      "Sub-pages: create one with the + on a page row. The parent page then shows a live double-link list of its sub-pages at the very top, kept in sync as they are renamed, moved or deleted.",
      "Split view: right-click a page and choose Open on the right to view two pages side by side. Drag the divider to resize, or swap the panes.",
      "History: right-click a page to browse auto-saved snapshots and restore one — your current content is backed up first.",
      "Deleted pages stay in the trash for 30 days — restore them any time, or delete them for good.",
    ]),

    h2("Daily notes"),
    p(
      text(
        "The Today's note button in the sidebar opens the note for today. Daily notes live under one folder, grouped by year / month / day (for example Daily notes/2026/10/10-02 Fri) with one document per day — search, tags, export and backup all work just like any other page.",
      ),
    ),
    p(
      text(
        "Settings → Daily notes lets you change the folder page name, the template for new notes (supports # headings, - [ ] to-dos and {{date}} placeholders) and whether today's note opens automatically on startup.",
      ),
    ),

    h2("Search and mentions"),
    bullets([
      "Global search (Ctrl+Shift+F) covers page titles, body text and database cells, and jumps straight to the matching row.",
      "The command palette (Ctrl+K) jumps to any page, and can also create a page or open today's note.",
      "Type @ to mention a page: hover to preview, click to open; backlinks are listed at the bottom of the page.",
      "For long documents, use the outline panel (H1–H3) on the right, or insert an 'Outline' block from the / menu for an in-page table of contents.",
    ]),

    h2("Export, backup and settings"),
    bullets([
      "The export menu in the tab bar exports the current page as Markdown, a long image, or PDF; databases support CSV import / export.",
      "Markdown folders can be imported as a page tree in one go.",
      "Settings can export / import a full backup (database + assets) and move the data directory anywhere.",
      "Themes: light / dark / system. The interface speaks Chinese and English.",
    ]),

    h2("Keyboard shortcuts"),
    table([
      ["Shortcut", "Action"],
      ["/", "Insert a block"],
      ["@", "Mention a page"],
      ["Ctrl+K", "Command palette"],
      ["Ctrl+Shift+F", "Global search"],
      ["Ctrl+S", "Save now"],
      ["Ctrl+B / I / U", "Bold / italic / underline"],
      ["Ctrl+T", "Insert a table"],
    ]),

    h2("Where your data lives"),
    p(
      text(
        "Everything is stored locally in %APPDATA%\\com.tsflowy.app (appflowy.db plus the assets folder). Nothing is uploaded anywhere. Use Settings to back up or move it.",
      ),
    ),
    p(text("Start right here — rewrite this page as your first note, or delete it and create your own.")),
  ];
}
