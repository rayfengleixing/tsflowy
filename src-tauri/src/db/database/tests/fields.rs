// 字段域用例（从 tests/mod.rs 原样搬入，断言未改）。
// tests/mod.rs 已 `use super::*` 把 database 的领域函数带进来，这里只需要再取同目录的共享辅助。
use super::*;

#[test]
fn create_field_defaults_match_legacy_js_shape() {
    let conn = setup();
    let f = create_field(&conn, "v1", "f1", "text", None).unwrap();
    assert_eq!(f.name, "text"); // name 缺省 = 类型名
    assert_eq!(f.width, 180);
    assert_eq!(f.is_hidden, 0);
    assert_eq!(f.position, 0);
    assert_eq!(f.options, r#"{"kind":"none"}"#);

    let f2 = create_field(&conn, "v1", "f2", "single_select", Some("状态")).unwrap();
    assert_eq!(f2.name, "状态");
    assert_eq!(f2.position, 1);
    assert_eq!(f2.options, r#"{"kind":"select","options":[]}"#);
}

#[test]
fn default_options_per_type() {
    assert_eq!(
        default_options_json("number"),
        r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
    );
    assert_eq!(
        default_options_json("date"),
        r#"{"include_time":false,"kind":"date"}"#
    );
    assert_eq!(
        default_options_json("multi_select"),
        r#"{"kind":"select","options":[]}"#
    );
    assert_eq!(default_options_json("checkbox"), r#"{"kind":"none"}"#);
    assert_eq!(
        default_options_json("relation"),
        r#"{"kind":"relation","target_view_id":""}"#
    );
    assert_eq!(
        default_options_json("rollup"),
        r#"{"fn":"count","kind":"rollup","relation_field_id":"","target_field_id":""}"#
    );
    assert_eq!(
        default_options_json("reverse_relation"),
        r#"{"kind":"reverse_relation","source_field_id":"","source_view_id":""}"#
    );
    assert_eq!(default_options_json("attachment"), r#"{"kind":"none"}"#);
}

/// 读契约文件（前端测试读同一份），返回 types 数组与触发器时间戳列表
#[test]
fn default_options_match_shared_contract() {
    let (entries, _) = read_contract();
    assert!(!entries.is_empty(), "契约里一个类型都没有，测试就形同虚设");
    for entry in &entries {
        let field_type = entry["type"].as_str().expect("每项要有 type");
        let want = &entry["defaultOptions"];
        let got: serde_json::Value = serde_json::from_str(&default_options_json(field_type))
            .expect("默认 options 应是合法 JSON");
        assert_eq!(
            got,
            want.clone(),
            "{field_type} 的默认 options 与契约不一致"
        );
    }
}

/// 复制视图时跳过源单元格的类型清单，必须与契约（及前端认知）一致
#[test]
fn trigger_managed_timestamps_match_shared_contract() {
    let (_, timestamps) = read_contract();
    let expected: Vec<String> = TRIGGER_MANAGED_TIMESTAMPS
        .iter()
        .map(|t| t.to_string())
        .collect();
    assert_eq!(
        timestamps, expected,
        "views::crud 跳过的时间戳列与契约不一致"
    );
}

#[test]
fn field_update_ops() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", Some("名")).unwrap();

    rename_field(&conn, "f1", "新名").unwrap();
    set_field_width(&conn, "f1", 240).unwrap();
    set_field_hidden(&conn, "f1", true).unwrap();
    update_field_options(&conn, "f1", r#"{"kind":"number"}"#).unwrap();

    let fs = list_fields(&conn, "v1").unwrap();
    assert_eq!(fs.len(), 1);
    assert_eq!(fs[0].name, "新名");
    assert_eq!(fs[0].width, 240);
    assert_eq!(fs[0].is_hidden, 1);
    assert_eq!(fs[0].options, r#"{"kind":"number"}"#);
}

#[test]
fn rename_field_of_missing_id_errors() {
    // 悬空/跨视图 field_id 不能静默 no-op：前端会带着旧名乐观更新，公式连锁整条走空
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    let err = rename_field(&conn, "ghost", "幽灵").unwrap_err();
    assert!(err.contains("ghost"), "报错需带上缺失的字段 id：{err}");
    // 真实字段不受影响
    assert_eq!(list_fields(&conn, "v1").unwrap()[0].name, "text");
}

#[test]
fn reorder_fields_assigns_final_positions() {
    let conn = setup();
    for id in ["f1", "f2", "f3"] {
        create_field(&conn, "v1", id, "text", None).unwrap();
    }
    reorder_fields(&conn, "v1", &["f3", "f1", "f2"]).unwrap();
    let fs = list_fields(&conn, "v1").unwrap();
    let order: Vec<&str> = fs.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(order, vec!["f3", "f1", "f2"]);
    let positions: Vec<i64> = fs.iter().map(|f| f.position).collect();
    assert_eq!(positions, vec![0, 1, 2]);
}

#[test]
fn change_field_type_resets_options_and_clears_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""hello""#).unwrap();

    change_field_type(&conn, "f1", "number").unwrap();

    let f = &list_fields(&conn, "v1").unwrap()[0];
    assert_eq!(f.field_type, "number");
    assert_eq!(
        f.options,
        r#"{"currency":"CNY","format":"decimal","kind":"number","precision":2}"#
    );
    let f1_cells = cells_of(&conn, "f1");
    assert_eq!(f1_cells.len(), 1); // 行还在，单元格没被删
    assert_eq!(f1_cells[0].value, "null");
}

/// 改类型不再是一去无回头的清空：旧值连同字段定义留着，撤销能原样换回
#[test]
fn change_field_type_snapshot_restores_values_and_definition() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    create_row(&conn, "v1", "r2", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""甲""#).unwrap();
    set_cell(&conn, "r2", "f1", r#""乙""#).unwrap();
    let definition_before = list_fields(&conn, "v1").unwrap()[0].clone();

    assert_eq!(change_field_type(&conn, "f1", "number").unwrap(), 2);
    let cleared: Vec<String> = cells_of(&conn, "f1").into_iter().map(|c| c.value).collect();
    assert_eq!(cleared, vec!["null".to_string(), "null".to_string()]);

    assert_eq!(restore_field_values(&conn, "f1").unwrap(), 2);
    let back = &list_fields(&conn, "v1").unwrap()[0];
    assert_eq!(
        back.field_type, definition_before.field_type,
        "类型要换回去"
    );
    assert_eq!(
        back.options, definition_before.options,
        "options 也要换回去"
    );
    let values: Vec<String> = cells_of(&conn, "f1").into_iter().map(|c| c.value).collect();
    assert_eq!(values, vec![r#""甲""#.to_string(), r#""乙""#.to_string()]);

    // 还原即消费：快照没了，再点撤销不该把同一份旧值反复盖回来
    assert!(restore_field_values(&conn, "f1").is_err());
}

/// 连续改类型时，空列不该把上一次留存的旧值顶掉（A 有值→B 空→C：还能拿回 A）
#[test]
fn change_field_type_keeps_earlier_snapshot_when_column_is_empty() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""别丢""#).unwrap();

    assert_eq!(change_field_type(&conn, "f1", "number").unwrap(), 1);
    // 这一列现在全是 null，再改一次类型没什么可留存
    assert_eq!(change_field_type(&conn, "f1", "single_select").unwrap(), 0);
    assert_eq!(restore_field_values(&conn, "f1").unwrap(), 1);
    let f = &list_fields(&conn, "v1").unwrap()[0];
    assert_eq!(f.field_type, "text", "还原回的是最初有值时的类型");
    assert_eq!(cells_of(&conn, "f1")[0].value, r#""别丢""#);
}

#[test]
fn restore_field_values_skips_rows_deleted_after_the_snapshot() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    create_row(&conn, "v1", "r2", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""留""#).unwrap();
    set_cell(&conn, "r2", "f1", r#""没""#).unwrap();
    change_field_type(&conn, "f1", "number").unwrap();
    // 期间删掉一行：那一格的取值没有归属的行，插回去会撞 cells.row_id 的外键
    purge_rows(&conn, &["r2".to_string()]).unwrap();

    assert_eq!(restore_field_values(&conn, "f1").unwrap(), 1);
    let values: Vec<(String, String)> = cells_of(&conn, "f1")
        .into_iter()
        .map(|c| (c.row_id, c.value))
        .collect();
    assert_eq!(values, vec![("r1".to_string(), r#""留""#.to_string())]);
}

#[test]
fn change_field_type_same_type_is_noop() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""hello""#).unwrap();
    let options_before = list_fields(&conn, "v1").unwrap()[0].options.clone();

    change_field_type(&conn, "f1", "text").unwrap();

    let f = &list_fields(&conn, "v1").unwrap()[0];
    assert_eq!(f.field_type, "text");
    assert_eq!(f.options, options_before); // 选项未被重置
    assert_eq!(cells_of(&conn, "f1")[0].value, r#""hello""#); // 数据未清空
}

#[test]
fn delete_field_cascades_cells() {
    let conn = setup();
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_row(&conn, "v1", "r1", None).unwrap();
    set_cell(&conn, "r1", "f1", r#""x""#).unwrap();

    delete_field(&conn, "f1").unwrap();
    assert!(list_fields(&conn, "v1").unwrap().is_empty());
    assert!(load_cells(&conn, "v1").unwrap().is_empty());
}

// ---------- 关联列自动配对反向列 ----------

#[test]
fn pair_relation_creates_reverse_column_on_target() {
    let conn = setup();
    add_view(&conn, "v2", "对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();

    let out = pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

    assert_eq!(out.reverse_field_id, "rv1");
    assert_eq!(
        out.relation_field.options,
        options_of(&conn, "f1").to_string()
    );
    let rel = options_of(&conn, "f1");
    assert_eq!(rel["kind"], "relation");
    assert_eq!(rel["target_view_id"], "v2");
    assert_eq!(rel["paired_field_id"], "rv1");
    // 反向列落在目标表上，类型与配置都要能直接被反向关系渲染认账
    assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
    let rev = options_of(&conn, "rv1");
    assert_eq!(rev["kind"], "reverse_relation");
    assert_eq!(rev["source_view_id"], "v1");
    assert_eq!(rev["source_field_id"], "f1");
    let rev_type: String = conn
        .query_row(
            "SELECT field_type FROM database_fields WHERE id = 'rv1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rev_type, "reverse_relation");
    assert_eq!(count_fields(&conn, "v2"), 1);
}

#[test]
fn pair_relation_reuses_untouched_reverse_column() {
    let conn = setup();
    add_view(&conn, "v2", "对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
    pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

    // 反复打开字段设置（或同一次会话里再保存一遍）不该在对端堆出同义列
    let out = pair_relation_field(&conn, "f1", "v2", "rv2", "反向").unwrap();
    assert_eq!(out.reverse_field_id, "rv1");
    assert_eq!(options_of(&conn, "f1")["paired_field_id"], "rv1");
    assert_eq!(count_fields(&conn, "v2"), 1);
    assert_eq!(view_of_field(&conn, "rv2"), None);
}

#[test]
fn pair_retarget_drops_the_zombie_reverse_column() {
    let conn = setup();
    add_view(&conn, "v2", "旧对端", None);
    add_view(&conn, "v3", "新对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
    pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();

    let out = pair_relation_field(&conn, "f1", "v3", "rv2", "反向").unwrap();

    assert_eq!(out.reverse_field_id, "rv2");
    assert_eq!(view_of_field(&conn, "rv1"), None, "改指后旧反向列已失效");
    assert_eq!(count_fields(&conn, "v2"), 0);
    assert_eq!(view_of_field(&conn, "rv2").as_deref(), Some("v3"));
    assert_eq!(options_of(&conn, "f1")["target_view_id"], "v3");
}

#[test]
fn pair_retarget_keeps_a_customized_reverse_column() {
    let conn = setup();
    add_view(&conn, "v2", "旧对端", None);
    add_view(&conn, "v3", "新对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
    pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
    // 用户改了这条反向列的配置（这里改成指向另一个来源字段）：它已经是用户的数据，不能删
    update_field_options(
        &conn,
        "rv1",
        r#"{"kind":"reverse_relation","source_view_id":"v1","source_field_id":"other"}"#,
    )
    .unwrap();

    let out = pair_relation_field(&conn, "f1", "v3", "rv2", "反向").unwrap();

    assert_eq!(out.reverse_field_id, "rv2");
    assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
}

#[test]
fn pair_relation_rejects_bad_targets() {
    let conn = setup();
    add_view(&conn, "v2", "对端", None);
    create_field(&conn, "v1", "f1", "text", None).unwrap();
    create_field(&conn, "v1", "f2", "relation", None).unwrap();

    let not_relation = pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap_err();
    assert!(not_relation.contains("不是关联列"), "{not_relation}");
    let missing = pair_relation_field(&conn, "f2", "v9", "rv1", "反向").unwrap_err();
    assert!(missing.contains("不存在"), "{missing}");
    let empty = pair_relation_field(&conn, "f2", "", "rv1", "反向").unwrap_err();
    assert!(empty.contains("还没有选择目标表"), "{empty}");
    assert_eq!(count_fields(&conn, "v2"), 0, "失败不该留下半配对");
}

#[test]
fn pair_relation_folds_derived_target_view_to_host() {
    let conn = setup();
    add_view(&conn, "v2", "宿主表", None);
    add_view(&conn, "v2d", "派生视图", Some("v2"));
    create_field(&conn, "v1", "f1", "relation", None).unwrap();

    let out = pair_relation_field(&conn, "f1", "v2d", "rv1", "反向").unwrap();

    // 数据和反向列都只挂宿主：派生视图背后没有独立的字段表
    assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
    assert_eq!(options_of(&conn, "f1")["target_view_id"], "v2");
    assert_eq!(out.reverse_field_id, "rv1");
}

#[test]
fn delete_relation_field_removes_untouched_paired_reverse() {
    let conn = setup();
    add_view(&conn, "v2", "对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
    pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
    create_row(&conn, "v2", "t1", None).unwrap();
    set_cell(&conn, "t1", "rv1", r#"["r1"]"#).unwrap();

    delete_field(&conn, "f1").unwrap();

    assert_eq!(view_of_field(&conn, "rv1"), None);
    assert_eq!(count_fields(&conn, "v2"), 0);
    // 反向列的单元格随列一起走 FK 级联
    assert!(load_cells(&conn, "v2").unwrap().is_empty());
}

#[test]
fn delete_relation_field_keeps_customized_paired_reverse() {
    let conn = setup();
    add_view(&conn, "v2", "对端", None);
    create_field(&conn, "v1", "f1", "relation", Some("项目")).unwrap();
    pair_relation_field(&conn, "f1", "v2", "rv1", "反向").unwrap();
    rename_field(&conn, "rv1", "谁关联了我").unwrap();
    update_field_options(
        &conn,
        "rv1",
        r#"{"kind":"reverse_relation","source_view_id":"v9","source_field_id":"f1"}"#,
    )
    .unwrap();

    delete_field(&conn, "f1").unwrap();

    assert_eq!(view_of_field(&conn, "rv1").as_deref(), Some("v2"));
}

fn read_contract() -> (Vec<serde_json::Value>, Vec<String>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../contracts/field_type_contract.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到契约文件 {}: {e}", path.display()));
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("契约文件应是合法 JSON");
    let types = doc["types"]
        .as_array()
        .expect("契约的 types 应是数组")
        .clone();
    let timestamps = doc["triggerManagedTimestampTypes"]
        .as_array()
        .expect("契约的 triggerManagedTimestampTypes 应是数组")
        .iter()
        .map(|v| v.as_str().expect("每项应是字符串").to_string())
        .collect();
    (types, timestamps)
}
