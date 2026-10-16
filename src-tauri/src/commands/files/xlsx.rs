//! 最小 xlsx（Office Open XML 电子表格）写出器。
//!
//! 为什么不引 spreadsheet crate：`package.json` 与 `Cargo.toml` 都没有表格库依赖，
//! 而 SheetJS 的 npm 版有未修复的安全公告。xlsx 本质是一个固定部件集合的 zip，
//! 项目里已有 `zip` 依赖（备份归档在用），手写这 6 个部件即可零新增依赖产出一个
//! Excel/WPS/LibreOffice 都能直接打开的单表工作簿。
//!
//! 只写只读导出需要的东西：无共享字符串表（文本走 inlineStr）、无公式、单工作表，
//! 日期用 Excel 1900 序列号 + 自定义数字格式，因此能被 Excel 识别成真正的时间值参与排序。

use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;

use serde::Deserialize;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::ensure_dialog_authorized;

/// 列的数据种类：只影响样式（日期格式）与列宽，不参与值校验
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XlsxKind {
    Text,
    Number,
    Bool,
    Date,
    Datetime,
}

/// 一格的原值。`None`（JSON null）= 空格，写出时直接跳过该单元格。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum XlsxValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

pub type XlsxCell = Option<XlsxValue>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxColumn {
    pub header: String,
    pub kind: XlsxKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheet {
    pub name: String,
    pub columns: Vec<XlsxColumn>,
    pub rows: Vec<Vec<XlsxCell>>,
}

/// styles.xml 里预置的 cellXfs 下标（写出顺序即样式下标，别调换）
const STYLE_NORMAL: usize = 0;
const STYLE_HEADER: usize = 1;
const STYLE_DATE: usize = 2;
const STYLE_DATETIME: usize = 3;

/// 把单表工作簿打成 xlsx 字节（纯函数，可单测）
pub fn build_xlsx(sheet: &XlsxSheet) -> Result<Vec<u8>, String> {
    if sheet.columns.is_empty() {
        return Err("xlsx export needs at least one column".to_string());
    }
    let name = sanitize_sheet_name(&sheet.name);
    let last_ref = cell_ref(col_letter(sheet.columns.len()), sheet.rows.len() + 1);
    let parts: [(&str, String); 5] = [
        ("[Content_Types].xml", content_types_xml()),
        ("_rels/.rels", root_rels_xml()),
        ("xl/workbook.xml", workbook_xml(&name)),
        ("xl/_rels/workbook.xml.rels", workbook_rels_xml()),
        ("xl/styles.xml", styles_xml()),
    ];

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (path, xml) in parts {
        zip.start_file(path, options)
            .map_err(|e| format!("zip start {path} failed: {e}"))?;
        zip.write_all(xml.as_bytes())
            .map_err(|e| format!("zip write {path} failed: {e}"))?;
    }
    zip.start_file("xl/worksheets/sheet1.xml", options)
        .map_err(|e| format!("zip start sheet failed: {e}"))?;
    // 逐行拼接写入：大表整张字符串会双份占内存（XML + UTF-8 字节）
    let mut writer = zip;
    write_sheet_body(&mut writer, sheet, &last_ref)
        .map_err(|e| format!("zip write sheet failed: {e}"))?;
    Ok(writer
        .finish()
        .map_err(|e| format!("zip finish failed: {e}"))?
        .into_inner())
}

fn write_sheet_body<W: Write>(
    w: &mut W,
    sheet: &XlsxSheet,
    dimension_ref: &str,
) -> std::io::Result<()> {
    w.write_all(XML_DECL.as_bytes())?;
    w.write_all(
        b"<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
    )?;
    w.write_all(format!("<dimension ref=\"{dimension_ref}\"/>").as_bytes())?;
    w.write_all(
        b"<sheetViews><sheetView tabSelected=\"1\" workbookViewId=\"0\">\
           <pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>\
         </sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>",
    )?;
    for (i, col) in sheet.columns.iter().enumerate() {
        let letter = i + 1;
        w.write_all(
            format!(
                "<col min=\"{letter}\" max=\"{letter}\" width=\"{}\" customWidth=\"1\"/>",
                column_width(col)
            )
            .as_bytes(),
        )?;
    }
    w.write_all(b"<sheetData>")?;
    let header: String = sheet
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| text_cell(cell_ref(col_letter(i + 1), 1), STYLE_HEADER, &c.header))
        .collect();
    w.write_all(format!("<row r=\"1\">{header}</row>").as_bytes())?;
    for (r, row) in sheet.rows.iter().enumerate() {
        let mut buf = String::new();
        for (i, cell) in row.iter().take(sheet.columns.len()).enumerate() {
            let kind = sheet.columns[i].kind;
            if let Some(xml) = data_cell(cell_ref(col_letter(i + 1), r + 2), kind, cell) {
                buf.push_str(&xml);
            }
        }
        w.write_all(format!("<row r=\"{}\">{buf}</row>", r + 2).as_bytes())?;
    }
    w.write_all(b"</sheetData></worksheet>")
}

/// 一格 → OOXML；空值返回 None（Excel 接受稀疏单元格，无需写空标签）
fn data_cell(reference: String, kind: XlsxKind, cell: &XlsxCell) -> Option<String> {
    match cell {
        None => None,
        Some(XlsxValue::Bool(v)) => Some(format!(
            "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
            if *v { 1 } else { 0 }
        )),
        // 数字列只可能收到数值；日期列的值走下面的 Text 分支转成序列号
        Some(XlsxValue::Number(v)) if v.is_finite() => {
            Some(format!("<c r=\"{reference}\"><v>{v}</v></c>"))
        }
        Some(XlsxValue::Number(_)) => None,
        Some(XlsxValue::Text(text)) => match kind {
            XlsxKind::Date | XlsxKind::Datetime => excel_serial(text, kind == XlsxKind::Datetime)
                .map(|serial| {
                    let style = if kind == XlsxKind::Datetime {
                        STYLE_DATETIME
                    } else {
                        STYLE_DATE
                    };
                    format!("<c r=\"{reference}\" s=\"{style}\"><v>{serial}</v></c>")
                })
                .or_else(|| Some(text_cell(reference, STYLE_NORMAL, text))),
            _ => Some(text_cell(reference, STYLE_NORMAL, text)),
        },
    }
}

fn text_cell(reference: String, style: usize, text: &str) -> String {
    format!(
        "<c r=\"{reference}\" s=\"{style}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        xml_escape(text)
    )
}

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

fn content_types_xml() -> String {
    format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
         <Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\
         <Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\
         </Types>"
    )
}

fn root_rels_xml() -> String {
    format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
         </Relationships>"
    )
}

fn workbook_xml(name: &str) -> String {
    format!(
        "{XML_DECL}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
         <sheets><sheet name=\"{name}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
        name = xml_escape(name)
    )
}

fn workbook_rels_xml() -> String {
    format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>\
         </Relationships>"
    )
}

/// 4 个 xf（下标见 STYLE_*）：普通 / 表头加粗 / 日期 / 日期时间。
/// fills 第二项 gray125 与 borders 空项是 Excel 的硬性要求，缺了会判文件损坏。
fn styles_xml() -> String {
    format!(
        "{XML_DECL}<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
         <numFmts count=\"2\"><numFmt numFmtId=\"165\" formatCode=\"yyyy\\-mm\\-dd\"/>\
         <numFmt numFmtId=\"166\" formatCode=\"yyyy\\-mm\\-dd\\ hh:mm\"/></numFmts>\
         <fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>\
         <font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>\
         <fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>\
         <borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
         <cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
         <cellXfs count=\"4\">\
         <xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>\
         <xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>\
         <xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>\
         <xf numFmtId=\"166\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>\
         </cellXfs>\
         <cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>\
         </styleSheet>"
    )
}

fn column_width(column: &XlsxColumn) -> f64 {
    let base: f64 = match column.kind {
        XlsxKind::Text => 26.0,
        XlsxKind::Number => 14.0,
        XlsxKind::Bool => 8.0,
        XlsxKind::Date => 12.0,
        XlsxKind::Datetime => 18.0,
    };
    // 表头比默认宽度长时撑开，最宽 60 防止一列吃掉整屏
    let header = (column.header.chars().count() as f64) + 2.0;
    base.max(header).min(60.0)
}

/// A1 列名（1-based）：1→A、26→Z、27→AA
fn col_letter(index: usize) -> String {
    let mut n = index;
    let mut out = String::new();
    while n > 0 {
        n -= 1;
        out.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    out
}

fn cell_ref(column: String, row: usize) -> String {
    format!("{column}{row}")
}

/// Excel 1900 序列号：把「墙上时间」文本转成天数 + 一天中的比例。
/// 接受 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM[:SS]`、`YYYY-MM-DD HH:MM[:SS]`；秒与时区后缀忽略到分。
/// 时间字段在本机存的是 UTC ISO，前端已按展示口径折成墙上时间再传过来，这里不再做时区换算。
fn excel_serial(text: &str, with_time: bool) -> Option<f64> {
    let text = text.trim().trim_end_matches('Z').trim_end_matches('z');
    let (date_part, time_part) = match text.find(['T', ' ']) {
        Some(i) => (&text[..i], Some(text[i + 1..].trim())),
        None => (text, None),
    };
    let mut date = date_part.split('-');
    let year: i64 = date.next()?.trim().parse().ok()?;
    let month: i64 = date.next()?.trim().parse().ok()?;
    let day: i64 = date.next()?.trim().parse().ok()?;
    if date.next().is_some()
        || !(1900..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let mut seconds = 0.0;
    if with_time {
        let time = time_part.filter(|t| !t.is_empty())?;
        let mut hms = time.split(':');
        let hour: i64 = hms.next()?.trim().parse().ok()?;
        let minute: i64 = hms.next().unwrap_or("0").trim().parse().ok()?;
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
            return None;
        }
        seconds = hour as f64 * 3600.0 + minute as f64 * 60.0;
    } else if time_part.is_some() {
        return None;
    }
    // 1970-01-01 = Excel 序列号 25569（含 Excel 的 1900 闰年 bug，日期在此之后不受影响）
    Some(days_from_civil(year, month, day) as f64 + 25569.0 + seconds / 86400.0)
}

/// Howard Hinnant 的 civil-from-days 逆运算：公历日期 → Unix 天数（1970-01-01 = 0）
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// XML 文本节点转义；顺带剔除 XML 1.0 不允许出现的控制字符（0x00-0x08 等），
/// 否则 Excel 会直接把整个工作簿判为损坏。
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\t' | '\n' | '\r' => out.push(ch),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// Excel 的 sheet 名限制：≤31 字符、不能含 `: \ / ? * [ ]`、不能以首尾单引号包裹、不能空
fn sanitize_sheet_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']'))
        .filter(|c| *c != '\'' && *c != '"')
        .take(31)
        .collect();
    if cleaned.is_empty() {
        return "Sheet1".to_string();
    }
    cleaned
}

/// 导出当前表为 xlsx：路径来自文件对话框（同 CSV 导出），字节由 `build_xlsx` 现算。
/// 逐行拼 XML + 压缩是同步 CPU/IO 工作，放 blocking 线程池，避免卡住 WebView 主线程。
#[tauri::command]
pub async fn export_xlsx(
    app: tauri::AppHandle,
    path: String,
    sheet: XlsxSheet,
) -> Result<(), String> {
    ensure_dialog_authorized(&app, &path)?;
    let target = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || build_xlsx(&sheet))
        .await
        .map_err(|e| format!("xlsx task failed: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(Path::new(&target), bytes).map_err(|e| format!("failed to write {target}: {e}"))
    })
    .await
    .map_err(|e| format!("write task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn sheet(columns: Vec<XlsxColumn>, rows: Vec<Vec<XlsxCell>>) -> XlsxSheet {
        XlsxSheet {
            name: "任务表".to_string(),
            columns,
            rows,
        }
    }

    fn part(bytes: &[u8], name: &str) -> String {
        let mut zip = ZipArchive::new(Cursor::new(bytes.to_vec())).expect("zip opens");
        let mut buf = String::new();
        zip.by_name(name)
            .unwrap_or_else(|_| panic!("missing part {name}"))
            .read_to_string(&mut buf)
            .expect("part reads as utf-8");
        buf
    }

    #[test]
    fn col_letter_wraps_past_z() {
        assert_eq!(col_letter(1), "A");
        assert_eq!(col_letter(26), "Z");
        assert_eq!(col_letter(27), "AA");
        assert_eq!(col_letter(52), "AZ");
        assert_eq!(col_letter(53), "BA");
    }

    #[test]
    fn sheet_name_is_sanitized() {
        assert_eq!(sanitize_sheet_name("a/b:c*d?e[1]"), "abcde1");
        assert_eq!(sanitize_sheet_name("   "), "Sheet1");
        assert_eq!(sanitize_sheet_name("'quoted'"), "quoted");
        assert_eq!(sanitize_sheet_name(&"长".repeat(40)).chars().count(), 31);
    }

    #[test]
    fn date_text_becomes_excel_serial() {
        // 2026-01-01 的 Excel 序列号 = 46023（Unix 天数 20454 + 25569）
        assert_eq!(excel_serial("2026-01-01", false), Some(46023.0));
        assert_eq!(excel_serial("1970-01-01", false), Some(25569.0));
        assert_eq!(excel_serial("2000-02-29", false), Some(36585.0));
        // 半天 = 12:00
        assert_eq!(excel_serial("2026-01-01 12:00", true), Some(46023.5));
        // 秒不参与：展示格式只到分，序列按 6:30 计
        let expected = 46023.0 + (6.0 * 3600.0 + 30.0 * 60.0) / 86400.0;
        assert_eq!(excel_serial("2026-01-01T06:30:15", true), Some(expected));
        // date 列里带时间 → 认不出来，按文本写
        assert_eq!(excel_serial("2026-01-01 06:30", false), None);
        assert_eq!(excel_serial("2026-13-01", false), None);
        assert_eq!(excel_serial("not a date", false), None);
        assert_eq!(excel_serial("", false), None);
    }

    #[test]
    fn escapes_markup_and_drops_illegal_controls() {
        assert_eq!(xml_escape("a<b>&c\"d'"), "a&lt;b&gt;&amp;c\"d'");
        assert_eq!(xml_escape("tab\there\n换行"), "tab\there\n换行");
        assert_eq!(xml_escape("铃\u{7}声"), "铃声");
    }

    #[test]
    fn writes_all_parts_and_cell_types() {
        let bytes = build_xlsx(&sheet(
            vec![
                XlsxColumn {
                    header: "标题".to_string(),
                    kind: XlsxKind::Text,
                },
                XlsxColumn {
                    header: "工时".to_string(),
                    kind: XlsxKind::Number,
                },
                XlsxColumn {
                    header: "完成".to_string(),
                    kind: XlsxKind::Bool,
                },
                XlsxColumn {
                    header: "截止".to_string(),
                    kind: XlsxKind::Date,
                },
            ],
            vec![
                vec![
                    Some(XlsxValue::Text("<转义>&测试".to_string())),
                    Some(XlsxValue::Number(4.5)),
                    Some(XlsxValue::Bool(true)),
                    Some(XlsxValue::Text("2026-01-01".to_string())),
                ],
                // 空单元格、以及日期列里的脏文本（保留为文本而不是丢掉）
                vec![
                    None,
                    None,
                    Some(XlsxValue::Bool(false)),
                    Some(XlsxValue::Text("待定".to_string())),
                ],
            ],
        ))
        .expect("builds");

        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
            "xl/worksheets/sheet1.xml",
        ] {
            assert!(!part(&bytes, name).is_empty(), "{name} present");
        }
        assert!(part(&bytes, "xl/workbook.xml").contains("name=\"任务表\""));

        let xml = part(&bytes, "xl/worksheets/sheet1.xml");
        assert!(xml.contains("<row r=\"1\">"));
        assert!(xml.contains("<c r=\"A2\" s=\"0\" t=\"inlineStr\"><is><t xml:space=\"preserve\">&lt;转义&gt;&amp;测试</t></is></c>"));
        assert!(xml.contains("<c r=\"B2\"><v>4.5</v></c>"));
        assert!(xml.contains("<c r=\"C2\" t=\"b\"><v>1</v></c>"));
        assert!(xml.contains("<c r=\"D2\" s=\"2\"><v>46023</v></c>"));
        // 第二行：A/B 空值不写标签，D 落回文本
        assert!(xml.contains(
            "<row r=\"3\"><c r=\"C3\" t=\"b\"><v>0</v></c><c r=\"D3\" s=\"0\" t=\"inlineStr\">"
        ));
        assert_eq!(xml.matches("<row ").count(), 3);
    }

    #[test]
    fn rejects_sheet_without_columns() {
        assert!(build_xlsx(&sheet(Vec::new(), Vec::new())).is_err());
    }
}
