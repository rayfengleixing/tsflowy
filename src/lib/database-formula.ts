import type { CellValue, DatabaseField } from "@/types/database";
import { parseFieldOptions } from "./database-values";

// 公式字段求值（纯函数，Vitest 单测）。
// 表达式语法：
//   - 字面量：数字、字符串（"..." 或 '...'）、true / false
//   - 字段引用：{字段名}
//   - 算术：+ - * /（一元负号），任一操作数非数值 → 该子式无效
//   - 比较：= == != <> < <= > >=（两值可数值化则按数值比，否则按字符串比）→ 布尔
//   - 逻辑：AND OR NOT → 布尔（null 视为 false）
//   - 函数：IF(条件, 真值, 假值) 惰性求值；SUM/AVG/MIN/MAX(数值…) 忽略空值；
//           ROUND(x[, 位数])、ABS(x)；CONCAT(文本…)；TODAY()；YEAR/MONTH/DAY(日期)
//   - 括号分组，优先级：OR < AND < NOT < 比较 < 加减 < 乘除 < 一元 < 调用/原子
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
    if ("+-*/()<>=".includes(ch)) {
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
      if (tok?.k === "op" && (tok.v === "*" || tok.v === "/")) {
        eat();
        const right = parseUnary();
        if (!right) return null;
        left = { t: "bin", op: tok.v, l: left, r: right };
      } else break;
    }
    return left;
  };

  const parseUnary = (): Node | null => {
    const tok = peek();
    if (tok?.k === "op" && tok.v === "-") {
      eat();
      const arg = parseUnary();
      if (!arg) return null;
      return { t: "neg", arg };
    }
    return parsePrimary();
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

/** 日期值解析：优先 "YYYY-MM-DD" 前缀（本地），否则退化为 Date 构造 */
function toDateParts(v: FormulaValue): { y: number; mo: number; d: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return null;
  return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate() };
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
    case "TODAY": {
      const now = new Date();
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
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
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  const ast = parse(tokens);
  if (!ast) return null;
  return evalNode(ast, resolveRef);
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

/** 公式字段当前行的值：字段名 → 该行同字段值；解析失败/引用无效 → null。
 *  纯展示用途（Grid/行详情/CSV 导出），不落库。 */
export function computeFormula(
  field: DatabaseField,
  rowCells: Record<string, CellValue>,
  fields: DatabaseField[],
): FormulaValue {
  const opts = parseFieldOptions(field.options);
  if (opts.kind !== "formula" || !opts.formula.trim()) return null;
  const byName = new Map(fields.map((f) => [f.name, f]));
  return evalFormula(opts.formula, (name) => {
    const target = byName.get(name);
    if (!target || target.id === field.id) return null; // 引用自身/不存在 → 无效
    return cellToFormulaValue(rowCells[target.id] ?? null);
  });
}

/** 字段改名时同步改写公式里的 {旧名} 引用；只动引用，数字/运算符/其它引用原样保留。
 *  引用按名字解析（computeFormula 的 byName），不改写会让公式在改名后恒为空。 */
export function renameFormulaRef(formula: string, oldName: string, newName: string): string {
  return formula.replace(/\{([^}]*)\}/g, (whole, raw: string) => (raw.trim() === oldName ? `{${newName}}` : whole));
}
