// 检索词法层：FTS5 / LIKE 的转义、查询串切分成检索项、由项拼出 MATCH 表达式
// （从 search.rs 原样搬入，逻辑未改）。查询侧（query.rs）与跨路去重（父模块）共用这些。

/// 单个词/精确短语的 FTS5 转义：包成短语查询，内部双引号翻倍，杜绝语法错误/注入，
/// 也让 `AND`/`NOT`/`*` 这类操作符按字面匹配（多词 AND 与排除由 parse_query_terms 表达）。
/// （原 search.ts escapeFts，下沉到 Rust——JS 侧不再持有）。
pub fn escape_fts(input: &str) -> String {
    format!("\"{}\"", input.replace('"', "\"\""))
}

/// 解析后的一个检索项：`text` 是去引号的词或短语，`excluded` 来自 `-` 前缀。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueryTerm {
    pub text: String,
    pub excluded: bool,
}

/// 把关键词串切成检索项：空白分词，`"..."` 为精确短语，`-` 前缀为排除项。
///
/// 每个词独立成项（拼起来由 fts_expr 用 AND 连接），否则「项目 计划」会被当成一个短语，
/// 命中不了两词分散的文档。引号内不再嵌套引号：遇到下一个 `"` 即结束（未闭合则到结尾），
/// 与 JS 侧 parseSearchQuery 的切分规则一致。
pub(crate) fn parse_query_terms(input: &str) -> Vec<QueryTerm> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        // `-词` / `-"短语"`：单独一个 `-`（后面紧跟空白）不是项，直接丢弃
        let excluded = chars[i] == '-';
        if excluded {
            i += 1;
        }
        let quoted = i < chars.len() && chars[i] == '"';
        if quoted {
            i += 1;
        }
        let start = i;
        while i < chars.len() {
            let c = chars[i];
            if quoted {
                if c == '"' {
                    break;
                }
            } else if c.is_whitespace() || c == '"' {
                break;
            }
            i += 1;
        }
        let text: String = chars[start..i].iter().collect();
        if quoted && i < chars.len() {
            i += 1; // 跳过闭合引号
        }
        if !text.is_empty() {
            out.push(QueryTerm { text, excluded });
        }
    }
    out
}

/// 检索项里的正向词（排除项之外的部分），供兜底与短路判断复用。
pub(crate) fn positive_terms(terms: &[QueryTerm]) -> Vec<&str> {
    terms
        .iter()
        .filter(|t| !t.excluded)
        .map(|t| t.text.as_str())
        .collect()
}

/// 由检索项拼 FTS5 的 MATCH 表达式：正向项 AND 组合，排除项逐个 NOT 上去。
///
/// 括号是必须的：FTS5 的 `NOT` 右结合，`a AND b NOT c` 会被解析成 `a AND (b NOT c)`，
/// 与「先求交再排除」的意图不同。
/// 返回 None 表示没有正向项——FTS5 不接受整条查询只有排除项（裸 NOT 是语法错误）。
pub(crate) fn fts_expr(terms: &[QueryTerm]) -> Option<String> {
    let positive: Vec<String> = positive_terms(terms).into_iter().map(escape_fts).collect();
    if positive.is_empty() {
        return None;
    }
    let mut expr = positive.join(" AND ");
    for t in terms.iter().filter(|t| t.excluded) {
        expr = format!("({expr}) NOT ({})", escape_fts(&t.text));
    }
    Some(expr)
}

/// SQL LIKE 模式转义（配合 ESCAPE '\'）
/// （原 search.ts likePattern，下沉到 Rust）。
pub fn like_pattern(input: &str) -> String {
    let escaped: String = input
        .chars()
        .map(|c| {
            if c == '\\' || c == '%' || c == '_' {
                format!("\\{c}")
            } else {
                c.to_string()
            }
        })
        .collect();
    format!("%{escaped}%")
}
