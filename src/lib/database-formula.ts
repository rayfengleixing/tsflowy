import type { CellValue, DatabaseField } from "@/types/database";
import { parseFieldOptions } from "./database-values";

// 公式字段求值（纯函数，Vitest 单测）。
// 表达式语法：
//   - 字面量：数字、字符串（"..." 或 '...'）、true / false
//   - 字段引用：{字段名}
//   - 算术：+ - * / %（取模，除零→空），任一操作数非数值 → 该子式无效
//   - 幂：^（右结合，优先级高于一元负号：-2^2 = -4）
//   - 比较：= == != <> < <= > >=（两值可数值化则按数值比，否则按字符串比）→ 布尔
//   - 逻辑：AND OR NOT → 布尔（null 视为 false）
//   - 函数：IF(条件, 真值, 假值) 惰性求值；SUM/AVG/MIN/MAX(数值…) 忽略空值；
//           ROUND(x[, 位数])、ABS(x)；CONCAT(文本…)；
//           UPPER/LOWER/TRIM/LENGTH/CONTAINS/LEFT/RIGHT/MID(文本，CONTAINS 返回布尔)；
//           TODAY()、NOW()（本地 "YYYY-MM-DDTHH:mm:ss"）；YEAR/MONTH/DAY(日期)、
//           DAYS(d1, d2) = d1-d2 的整天数（按本地日历日，忽略时分秒）
//   - 日期值：接受 "YYYY-MM-DD"/ISO 字符串与 epoch 数字（|v|<1e11 按秒、否则按毫秒，同 database-query）
//   - 日期算术：日期字符串 ± 数字 = 按天平移（date+num 与 num+date 均可；纯日期串回写日期串，含时间的保留时分）
//   - 括号分组，优先级：OR < AND < NOT < 比较 < 加减 < 乘/除/模 < 一元负号 < 幂 < 调用/原子
// 无法反推/非法/除零/引用为空 → 返回 null（显示为空）。

/** 求值结果类型（number / string / boolean / null）——与 CellValue 的标量部分一致 */
export type FormulaValue = number | string | boolean | null;

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; name: string }
  | { t: "neg"; arg: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "not"; arg: Node }
  | { t: "call"; name: string; args: Node[] };

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ref"; name: string }
  | { k: "ident"; v: string }
  | { k: "op"; v: string };

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "{") {
      const close = expr.indexOf("}", i);
      if (close === -1) return null;
      const name = expr.slice(i + 1, close).trim();
      if (!name) return null;
      tokens.push({ k: "ref", name });
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = expr.indexOf(ch, i + 1);
      if (close === -1) return null;
      tokens.push({ k: "str", v: expr.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push({ k: "num", v: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      tokens.push({ k: "ident", v: expr.slice(i, j) });
      i = j;
      continue;
    }
    // 多字符运算符优先匹配
    const two = expr.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "==") {
      tokens.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%^()<>=".includes(ch)) {
      tokens.push({ k: "op", v: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ k: "op", v: "," });
      i++;
      continue;
    }
    return null; // 非法字符
  }
  return tokens;
}

// ---------- 解析（tokens → AST）；任一环节非法返回 null ----------

function parse(tokens: Token[]): Node | null {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eat = (): Token | undefined => tokens[pos++];

  const parseOr = (): Node | null => {
    let left = parseAnd();
    while (left) {
      const tok = peek();
      if (tok?.k === "ident" && tok.v.toUpperCase() === "OR") {
        eat();
        const right = parseAnd();
        if (!right) return null;
        left = { t: "bin", op: "OR", l: left, r: right };
      } else break;
    }
    return left;
  };

  const parseAnd = (): Node | null => {
    let left = parseNot();
    while (left) {
      const tok = peek();
      if (tok?.k === "ident" && tok.v.toUpperCase() === "AND") {
        eat();
        const right = parseNot();
        if (!right) return null;
        left = { t: "bin", op: "AND", l: left, r: right };
      } else break;
    }
    return left;
  };

  const parseNot = (): Node | null => {
    const tok = peek();
    if (tok?.k === "ident" && tok.v.toUpperCase() === "NOT") {
      eat();
      const arg = parseNot();
      if (!arg) return null;
      return { t: "not", arg };
    }
    return parseCmp();
  };

  const parseCmp = (): Node | null => {
    const left = parseAdd();
    if (!left) return null;
    const tok = peek();
    if (tok?.k === "op" && ["=", "==", "!=", "<>", "<", ">", "<=", ">="].includes(tok.v)) {
      eat();
      const right = parseAdd();
      if (!right) return null;
      return { t: "bin", op: tok.v, l: left, r: right };
    }
    return left;
  };

  const parseAdd = (): Node | null => {
    let left = parseMul();
    while (left) {
      const tok = peek();
      if (tok?.k === "op" && (tok.v === "+" || tok.v === "-")) {
        eat();
        const right = parseMul();
        if (!right) return null;
        left = { t: "bin", op: tok.v, l: left, r: right };
      } else break;
    }
    return left;
  };

  const parseMul = (): Node | null => {
    let left = parseUnary();
    while (left) {
      const tok = peek();
      if (tok?.k === "op" && (tok.v === "*" || tok.v === "/" || tok.v === "%")) {
        eat();
        const right = parseUnary();
        if (!right) return null;
        left = { t: "bin", op: tok.v, l: left, r: right };
      } else break;
    }
    return left;
  };

  // ^ 高于一元负号且右结合：-2^2 = -(2^2)，2^3^2 = 2^(3^2)
  const parsePow = (): Node | null => {
    const base = parsePrimary();
    if (!base) return null;
    if (isOpTok("^")) {
      eat();
      const exp = parseUnary();
      if (!exp) return null;
      return { t: "bin", op: "^", l: base, r: exp };
    }
    return base;
  };

  const parseUnary = (): Node | null => {
    const tok = peek();
    if (tok?.k === "op" && tok.v === "-") {
      eat();
      const arg = parseUnary();
      if (!arg) return null;
      return { t: "neg", arg };
    }
    return parsePow();
  };

  const isOpTok = (v: string): boolean => {
    const t = peek();
    return t?.k === "op" && t.v === v;
  };

  const parseArgs = (): Node[] | null => {
    const args: Node[] = [];
    if (isOpTok(")")) return args; // 空参数列表
    for (;;) {
      const a = parseOr();
      if (!a) return null;
      args.push(a);
      if (isOpTok(",")) {
        eat();
        continue;
      }
      break;
    }
    return args;
  };

  const parsePrimary = (): Node | null => {
    const tok = peek();
    if (!tok) return null;
    if (tok.k === "num") {
      eat();
      return { t: "num", v: tok.v };
    }
    if (tok.k === "str") {
      eat();
      return { t: "str", v: tok.v };
    }
    if (tok.k === "ref") {
      eat();
      return { t: "ref", name: tok.name };
    }
    if (tok.k === "op" && tok.v === "(") {
      eat();
      const inner = parseOr();
      const close = eat();
      if (!inner || close?.k !== "op" || close.v !== ")") return null;
      return inner;
    }
    if (tok.k === "ident") {
      eat();
      const upper = tok.v.toUpperCase();
      if (upper === "TRUE") return { t: "bool", v: true };
      if (upper === "FALSE") return { t: "bool", v: false };
      // 后随 ( 才是函数调用
      if (isOpTok("(")) {
        eat();
        const args = parseArgs();
        const close = eat();
        if (args === null || close?.k !== "op" || close.v !== ")") return null;
        return { t: "call", name: upper, args };
      }
      return null; // 裸标识符且非布尔常量 → 非法
    }
    return null;
  };

  const root = parseOr();
  if (!root || pos !== tokens.length) return null;
  return root;
}

// ---------- 求值（AST → FormulaValue）----------

function toNum(v: FormulaValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function toBool(v: FormulaValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v.toLowerCase() !== "false" && v !== "0";
  return false;
}

/** 日期值 → Date：epoch 数字（|v|<1e11 按秒、否则按毫秒，同 database-query dayMs）、
 *  "YYYY-MM-DD" 前缀按本地日、其余字符串退化为 Date 构造；非法 → null */
function toDateValue(v: FormulaValue): Date | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m)
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
    );
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 日期值解析：字符串与 epoch 数字都接受，返回本地日历日分量 */
function toDateParts(v: FormulaValue): { y: number; mo: number; d: number } | null {
  const dt = toDateValue(v);
  if (!dt) return null;
  return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
}

/** 可参与日期平移的字符串：本身不是数值串（"5" + 2 仍按算术）且可按日期解析 */
function isDateLikeString(v: FormulaValue): v is string {
  return typeof v === "string" && toNum(v) === null && toDateValue(v) !== null;
}

/** 日期字符串 ± N 天：纯日期串回写 "YYYY-MM-DD"，含时间的保留时分秒 */
function shiftDate(s: string, days: number): string | null {
  const dt = toDateValue(s);
  if (!dt) return null;
  const n = Math.trunc(days);
  const out = new Date(
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate() + n,
    dt.getHours(),
    dt.getMinutes(),
    dt.getSeconds(),
  );
  if (Number.isNaN(out.getTime())) return null;
  const dateStr = `${out.getFullYear()}-${pad2(out.getMonth() + 1)}-${pad2(out.getDate())}`;
  return /\dT\d{2}/.test(s)
    ? `${dateStr}T${pad2(out.getHours())}:${pad2(out.getMinutes())}:${pad2(out.getSeconds())}`
    : dateStr;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function compare(l: FormulaValue, r: FormulaValue, op: string): boolean | null {
  const nl = toNum(l);
  const nr = toNum(r);
  let lt: boolean;
  let eq: boolean;
  if (nl !== null && nr !== null) {
    lt = nl < nr;
    eq = nl === nr;
  } else {
    const sl = toStr(l);
    const sr = toStr(r);
    lt = sl < sr;
    eq = sl === sr;
  }
  switch (op) {
    case "=":
    case "==":
      return eq;
    case "!=":
    case "<>":
      return !eq;
    case "<":
      return lt;
    case ">":
      return !lt && !eq;
    case "<=":
      return lt || eq;
    case ">=":
      return !lt;
    default:
      return null;
  }
}

function callFn(name: string, evalArg: (n: Node) => FormulaValue, args: Node[]): FormulaValue {
  const nums = args
    .map(evalArg)
    .map(toNum)
    .filter((x): x is number => x !== null);
  switch (name) {
    case "IF": {
      if (args.length < 2) return null;
      const cond = toBool(evalArg(args[0]));
      return evalArg(cond ? args[1] : args.length > 2 ? args[2] : { t: "str", v: "" });
    }
    case "SUM":
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
    case "AVG":
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "MIN":
      return nums.length > 0 ? Math.min(...nums) : null;
    case "MAX":
      return nums.length > 0 ? Math.max(...nums) : null;
    case "ABS":
      return nums.length === 1 ? Math.abs(nums[0]) : null;
    case "ROUND": {
      if (nums.length < 1) return null;
      const v = nums[0];
      const d = nums.length >= 2 ? Math.trunc(nums[1]) : 0;
      const f = Math.pow(10, d);
      return Math.round(v * f) / f;
    }
    case "CONCAT":
      return args.map(evalArg).map(toStr).join("");
    case "UPPER":
    case "LOWER":
    case "TRIM":
    case "LENGTH": {
      if (args.length !== 1) return null;
      const s = toStr(evalArg(args[0]));
      if (name === "UPPER") return s.toUpperCase();
      if (name === "LOWER") return s.toLowerCase();
      if (name === "TRIM") return s.trim();
      return s.length;
    }
    case "CONTAINS": {
      if (args.length !== 2) return null;
      return toStr(evalArg(args[0])).includes(toStr(evalArg(args[1])));
    }
    case "LEFT":
    case "RIGHT": {
      if (args.length < 1 || args.length > 2) return null;
      const s = toStr(evalArg(args[0]));
      const n = args.length === 2 ? toNum(evalArg(args[1])) : 1;
      if (n === null) return null;
      const k = Math.min(Math.max(0, Math.trunc(n)), s.length);
      return name === "LEFT" ? s.slice(0, k) : s.slice(s.length - k);
    }
    case "MID": {
      if (args.length < 2 || args.length > 3) return null;
      const s = toStr(evalArg(args[0]));
      const start = toNum(evalArg(args[1]));
      if (start === null) return null;
      const from = Math.max(0, Math.trunc(start) - 1);
      if (args.length === 2) return s.slice(from);
      const len = toNum(evalArg(args[2]));
      if (len === null) return null;
      return s.slice(from, from + Math.max(0, Math.trunc(len)));
    }
    case "TODAY": {
      const now = new Date();
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    }
    case "NOW": {
      const now = new Date();
      return (
        `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
        `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
      );
    }
    case "DAYS": {
      if (args.length !== 2) return null;
      const a = toDateValue(evalArg(args[0]));
      const b = toDateValue(evalArg(args[1]));
      if (!a || !b) return null;
      const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
      const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
      return Math.round((da - db) / 86400000);
    }
    case "YEAR":
    case "MONTH":
    case "DAY": {
      if (args.length !== 1) return null;
      const parts = toDateParts(evalArg(args[0]));
      if (!parts) return null;
      return name === "YEAR" ? parts.y : name === "MONTH" ? parts.mo : parts.d;
    }
    default:
      return null; // 未知函数
  }
}

function evalNode(node: Node, resolveRef: (name: string) => FormulaValue): FormulaValue {
  switch (node.t) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "ref":
      return resolveRef(node.name);
    case "neg": {
      const v = toNum(evalNode(node.arg, resolveRef));
      return v === null ? null : -v;
    }
    case "not":
      return !toBool(evalNode(node.arg, resolveRef));
    case "bin": {
      const op = node.op;
      if (op === "AND") return toBool(evalNode(node.l, resolveRef)) && toBool(evalNode(node.r, resolveRef));
      if (op === "OR") return toBool(evalNode(node.l, resolveRef)) || toBool(evalNode(node.r, resolveRef));
      const l = evalNode(node.l, resolveRef);
      const r = evalNode(node.r, resolveRef);
      if (["=", "==", "!=", "<>", "<", ">", "<=", ">="].includes(op)) return compare(l, r, op);
      const nl = toNum(l);
      const nr = toNum(r);
      // 日期平移：日期串 ± 数字（数字侧 + 日期串仅限 +）
      if (op === "+" || op === "-") {
        if (nl === null && nr !== null && isDateLikeString(l)) return shiftDate(l, op === "+" ? nr : -nr);
        if (op === "+" && nl !== null && nr === null && isDateLikeString(r)) return shiftDate(r, nl);
      }
      if (nl === null || nr === null) return null;
      switch (op) {
        case "+":
          return nl + nr;
        case "-":
          return nl - nr;
        case "*":
          return nl * nr;
        case "/":
          return nr === 0 ? null : nl / nr;
        case "%":
          return nr === 0 ? null : nl % nr;
        case "^": {
          const v = Math.pow(nl, nr);
          return Number.isFinite(v) ? v : null;
        }
        default:
          return null;
      }
    }
    case "call":
      return callFn(node.name, (n) => evalNode(n, resolveRef), node.args);
  }
}

/** 求值表达式；引用值通过 resolveRef 回调获取（返回 null 视为该引用为空）。
 *  非法表达式 → null。 */
export function evalFormula(expr: string, resolveRef: (name: string) => FormulaValue): FormulaValue {
  const ast = parseCached(expr);
  if (!ast) return null;
  return evalNode(ast, resolveRef);
}

// tokenize/parse 是纯函数：同一表达式在多行/多单元格渲染中反复出现，
// 缓存 AST 后逐格求值不再重复词法/语法分析（大表格渲染的主要开销之一）。
const astCache = new Map<string, Node | null>();

function parseCached(expr: string): Node | null {
  if (astCache.has(expr)) return astCache.get(expr) ?? null;
  const tokens = tokenize(expr);
  const ast = tokens && tokens.length > 0 ? parse(tokens) : null;
  if (astCache.size > 256) astCache.clear();
  astCache.set(expr, ast);
  return ast;
}

/** 语法校验结果：undefined=合法；"lexer"=非法字符/未闭合的引号或大括号；"syntax"=结构不合法 */
export type FormulaSyntaxIssue = "lexer" | "syntax";

/** 保存前/失焦时的公式语法校验（只查语法，函数名/参数错误要到求值才暴露）。
 *  空表达式返回 undefined（视为未填写，不报错）。 */
export function validateFormula(expr: string): FormulaSyntaxIssue | undefined {
  if (!expr.trim()) return undefined;
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return "lexer";
  return parse(tokens) ? undefined : "syntax";
}

/** 单元格值 → 公式里的引用值：数组（多选/关联/附件）转文本串参与字符串运算，
 *  其余标量原样返回（number/boolean/string），null/undefined → null。 */
function cellToFormulaValue(v: CellValue): FormulaValue {
  if (v === null) return null;
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === "object" ? String(x.name) : String(x))).join(", ");
  }
  return v;
}

/** 环依赖（A={B}、B={A}）的公式字段显示值 */
export const FORMULA_CYCLE = "#CYCLE";

/** 收集表达式引用的字段名（AST 里的 ref 节点；非法表达式 → 空） */
function formulaRefNames(expr: string): Set<string> {
  const names = new Set<string>();
  const walk = (node: Node) => {
    switch (node.t) {
      case "ref":
        names.add(node.name);
        break;
      case "neg":
      case "not":
        walk(node.arg);
        break;
      case "bin":
        walk(node.l);
        walk(node.r);
        break;
      case "call":
        for (const a of node.args) walk(a);
        break;
    }
  };
  const ast = parseCached(expr);
  if (ast) walk(ast);
  return names;
}

/**
 * 一行内所有公式字段的值（fieldId → 值），按依赖顺序求值：
 * 公式引用另一个公式字段时取的是**对方的计算值**（旧实现读对方存储格——恒为空，
 * 公式串公式静默失效）。互相引用的字段构成环 → 成员标记 FORMULA_CYCLE，
 * 不会无限递归也不会静默变空。无公式字段时返回空 Map。
 */
export function computeRowFormulas(
  rowCells: Record<string, CellValue>,
  fields: DatabaseField[],
): Map<string, FormulaValue> {
  const values = new Map<string, FormulaValue>();
  const exprs = new Map<string, string>();
  for (const f of fields) {
    if (f.field_type !== "formula") continue;
    const opts = parseFieldOptions(f.options);
    if (opts.kind === "formula" && opts.formula.trim()) exprs.set(f.id, opts.formula);
  }
  if (exprs.size === 0) return values;

  const byName = new Map<string, DatabaseField>();
  for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);

  // 公式字段间的依赖边（自引用不建边——保持旧行为：按空值参与运算）
  const deps = new Map<string, string[]>();
  for (const [id, expr] of exprs) {
    const ds = new Set<string>();
    for (const name of formulaRefNames(expr)) {
      const t = byName.get(name);
      if (t && t.id !== id && exprs.has(t.id)) ds.add(t.id);
    }
    deps.set(id, [...ds]);
  }

  // 环判定：依赖能绕回自己的字段是环成员（下游引用环的字段不算环）。
  // 自引用已在建边时排除，这里找到的都是长度 ≥2 的互引环。
  const onCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const reachesStart = (ids: string[]): boolean => {
      for (const id of ids) {
        if (id === start) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        if (reachesStart(deps.get(id) ?? [])) return true;
      }
      return false;
    };
    return reachesStart(deps.get(start) ?? []);
  };
  const evaluate = (id: string) => {
    const expr = exprs.get(id);
    if (expr === undefined) return;
    values.set(
      id,
      evalFormula(expr, (name) => {
        const t = byName.get(name);
        if (!t || t.id === id) return null; // 引用自身/不存在 → 无效
        if (exprs.has(t.id)) return values.get(t.id) ?? null; // 环成员=#CYCLE；其余按拓扑序已有值
        return cellToFormulaValue(rowCells[t.id] ?? null);
      }),
    );
  };

  for (const id of exprs.keys()) {
    if (onCycle(id)) values.set(id, FORMULA_CYCLE);
  }
  // 其余字段按依赖就绪顺序求值
  const todo = [...exprs.keys()].filter((id) => !values.has(id));
  let progressed = true;
  while (todo.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < todo.length;) {
      const id = todo[i];
      if ((deps.get(id) ?? []).every((d) => values.has(d))) {
        evaluate(id);
        todo.splice(i, 1);
        progressed = true;
      } else {
        i++;
      }
    }
  }
  // 理论上到不了这里（环依赖已预置值）；出现即图有 bug，宁可标错也不留空洞
  for (const id of todo) values.set(id, FORMULA_CYCLE);
  return values;
}

/** 公式字段当前行的值：字段名 → 该行同字段值；解析失败/引用无效 → null，环依赖 → FORMULA_CYCLE。
 *  纯展示用途（Grid/行详情/CSV 导出），不落库。
 *  整行/整表批量场景请直接用 computeRowFormulas（每行只建一次依赖图）。 */
export function computeFormula(
  field: DatabaseField,
  rowCells: Record<string, CellValue>,
  fields: DatabaseField[],
): FormulaValue {
  if (field.field_type !== "formula") return null;
  return computeRowFormulas(rowCells, fields).get(field.id) ?? null;
}

/** 字段改名时同步改写公式里的 {旧名} 引用；只动引用，数字/运算符/其它引用原样保留。
 *  引用按名字解析（computeFormula 的 byName），不改写会让公式在改名后恒为空。 */
export function renameFormulaRef(formula: string, oldName: string, newName: string): string {
  return formula.replace(/\{([^}]*)\}/g, (whole, raw: string) => (raw.trim() === oldName ? `{${newName}}` : whole));
}
