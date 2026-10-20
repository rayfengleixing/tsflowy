use super::*;
use std::collections::BTreeMap;

/// 测试便捷包装：位置参数转 NewView 结构体，避免每个用例手写结构体字面量。
/// 显式定义优先于 `use super::*` 导入的同名函数，故测试内的 create 调用都走这里。
#[allow(clippy::too_many_arguments)] // 刻意与旧位置参数签名一致，让既有用例零改动
fn create(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    layout: &str,
    extra: &str,
    source_id: Option<&str>,
) -> Result<ViewRow, String> {
    super::create(
        conn,
        NewView {
            id,
            workspace_id,
            parent_id,
            name,
            layout,
            extra,
            source_id,
        },
    )
}

fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    super::super::migrations::ensure_migrated(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w1','W',1,1)",
        [],
    )
    .unwrap();
    conn
}

/// 与 tree.test.ts 同款 fixture：r1/r2/r3 根级（0-2），c1/c2/c3 在 r1 下（0-2）
fn seed_default_fixture(conn: &Connection) {
    for (id, parent, pos) in [
        ("r1", None, 0),
        ("r2", None, 1),
        ("r3", None, 2),
        ("c1", Some("r1"), 0),
        ("c2", Some("r1"), 1),
        ("c3", Some("r1"), 2),
    ] {
        conn.execute(
            "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
             VALUES (?1, 'w1', ?2, ?1, 'document', '{}', ?3, 1, 1)",
            params![id, parent, pos],
        )
        .unwrap();
    }
}

/// id → (parent_id, position)，按 id 排序便于整体断言
fn layout(conn: &Connection) -> BTreeMap<String, (Option<String>, i64)> {
    let mut stmt = conn
        .prepare("SELECT id, parent_id, position FROM views")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.into_iter()
        .map(|(id, p, pos)| (id, (p, pos)))
        .collect()
}

#[test]
fn move_same_parent_reorder() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "c3", Some("r1"), 0).unwrap();
    let l = layout(&conn);
    assert_eq!(l["c3"], (Some("r1".into()), 0));
    assert_eq!(l["c1"], (Some("r1".into()), 1));
    assert_eq!(l["c2"], (Some("r1".into()), 2));
    assert_eq!(l["r1"], (None, 0));
}

#[test]
fn move_cross_parent_index_clamped_to_end() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "c1", None, 99).unwrap();
    let l = layout(&conn);
    assert_eq!(l["c1"], (None, 3)); // 追加到根级末尾
    assert_eq!(l["r1"], (None, 0)); // 旧父级保持
    assert_eq!(l["c2"], (Some("r1".into()), 0)); // 旧父级兄弟压缩
    assert_eq!(l["c3"], (Some("r1".into()), 1));
    assert_eq!(l["r2"], (None, 1));
}

#[test]
fn move_cross_parent_head() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "r3", Some("r1"), 0).unwrap();
    let l = layout(&conn);
    assert_eq!(l["r3"], (Some("r1".into()), 0));
    assert_eq!(l["c1"], (Some("r1".into()), 1));
    assert_eq!(l["c2"], (Some("r1".into()), 2));
    assert_eq!(l["c3"], (Some("r1".into()), 3));
    assert_eq!(l["r1"], (None, 0));
    assert_eq!(l["r2"], (None, 1));
}

#[test]
fn move_to_root_middle() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "c2", None, 1).unwrap();
    let l = layout(&conn);
    assert_eq!(l["c2"], (None, 1));
    assert_eq!(l["r2"], (None, 2));
    assert_eq!(l["r3"], (None, 3));
    assert_eq!(l["c1"], (Some("r1".into()), 0));
}

#[test]
fn move_to_same_position_is_noop() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "c2", Some("r1"), 1).unwrap();
    let l = layout(&conn);
    assert_eq!(l["c2"], (Some("r1".into()), 1));
    assert_eq!(l["c1"], (Some("r1".into()), 0));
    assert_eq!(l["c3"], (Some("r1".into()), 2));
}

#[test]
fn move_into_own_descendant_is_silent_noop() {
    let conn = setup();
    seed_default_fixture(&conn);
    // c1 是 r1 的后代：环守卫必须静默拒绝
    move_view(&conn, "r1", Some("c1"), 0).unwrap();
    let l = layout(&conn);
    assert_eq!(l["r1"], (None, 0));
    assert_eq!(l["c1"], (Some("r1".into()), 0));
    assert_eq!(l["c2"], (Some("r1".into()), 1));
    assert_eq!(l["c3"], (Some("r1".into()), 2));
}

#[test]
fn move_unknown_target_is_noop() {
    let conn = setup();
    seed_default_fixture(&conn);
    move_view(&conn, "ghost", None, 0).unwrap();
    assert_eq!(layout(&conn).len(), 6);
}

/// id → (workspace_id, parent_id, position)：跨空间移动要同时断言归属和排序
fn placement(conn: &Connection) -> BTreeMap<String, (String, Option<String>, i64)> {
    let mut stmt = conn
        .prepare("SELECT id, workspace_id, parent_id, position FROM views")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.into_iter()
        .map(|(id, ws, p, pos)| (id, (ws, p, pos)))
        .collect()
}

fn add_workspace(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?1, ?1, 1, 1)",
        params![id],
    )
    .unwrap();
}

/// 两个空间各自成树：w1 = r1(→c1,c2) + r2，w2 = p1(→q1) + p2
fn seed_two_workspaces(conn: &Connection) {
    add_workspace(conn, "w2");
    for (ws, id, parent) in [
        ("w1", "r1", None),
        ("w1", "r2", None),
        ("w1", "c1", Some("r1")),
        ("w1", "c2", Some("r1")),
        ("w2", "p1", None),
        ("w2", "p2", None),
        ("w2", "q1", Some("p1")),
    ] {
        create(conn, id, ws, parent, id, "document", "{}", None).unwrap();
    }
}

#[test]
fn move_to_other_workspace_root_renumbers_both_sides() {
    let conn = setup();
    seed_two_workspaces(&conn);
    move_view_to_workspace(&conn, "r1", "w2", None, 0).unwrap();
    let l = placement(&conn);
    assert_eq!(l["r1"], ("w2".into(), None, 0));
    assert_eq!(l["p1"], ("w2".into(), None, 1));
    assert_eq!(l["p2"], ("w2".into(), None, 2));
    // 源侧补位；子页跟着换了空间，父子关系与原排序不变
    assert_eq!(l["r2"], ("w1".into(), None, 0));
    assert_eq!(l["c1"], ("w2".into(), Some("r1".into()), 0));
    assert_eq!(l["c2"], ("w2".into(), Some("r1".into()), 1));
}

#[test]
fn move_to_other_workspace_under_parent() {
    let conn = setup();
    seed_two_workspaces(&conn);
    move_view_to_workspace(&conn, "c1", "w2", Some("p1"), 1).unwrap();
    let l = placement(&conn);
    assert_eq!(l["c1"], ("w2".into(), Some("p1".into()), 1));
    assert_eq!(l["q1"], ("w2".into(), Some("p1".into()), 0));
    assert_eq!(l["c2"], ("w1".into(), Some("r1".into()), 0));
    assert_eq!(l["r1"], ("w1".into(), None, 0));
}

#[test]
fn move_takes_row_detail_doc_and_derived_view() {
    let conn = setup();
    seed_two_workspaces(&conn);
    // 一张表：宿主 + 它的派生视图（不属于树）+ 挂在宿主下的行详情文档
    create(&conn, "db1", "w1", None, "db1", "grid", "{}", None).unwrap();
    create(
        &conn,
        "db2",
        "w1",
        None,
        "看板视图",
        "board",
        "{}",
        Some("db1"),
    )
    .unwrap();
    conn.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES ('row1', 'w1', 'db1', '某行', 'document', '{\"row_detail\":1}', 0, 1, 1)",
        [],
    )
    .unwrap();

    move_view_to_workspace(&conn, "db1", "w2", Some("p1"), 0).unwrap();
    let l = placement(&conn);
    assert_eq!(l["db1"], ("w2".into(), Some("p1".into()), 0));
    assert_eq!(l["row1"], ("w2".into(), Some("db1".into()), 0));
    // 派生视图 parent_id 恒为 NULL，进不了子树 CTE，只能按 source_id 跟着宿主走
    assert_eq!(l["db2"], ("w2".into(), None, 0));
}

#[test]
fn move_keeps_trashed_descendant_trashed_but_follows_parent() {
    let conn = setup();
    seed_two_workspaces(&conn);
    soft_delete(&conn, "c2").unwrap();
    move_view_to_workspace(&conn, "r1", "w2", None, 0).unwrap();
    let l = placement(&conn);
    assert_eq!(l["c2"].0, "w2".to_string());
    let is_trash: i64 = conn
        .query_row("SELECT is_trash FROM views WHERE id = 'c2'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(is_trash, 1, "跟着父页换了空间的回收站页面不该被顺手恢复");
}

#[test]
fn same_workspace_target_falls_back_to_ordinary_renumber() {
    let conn = setup();
    seed_two_workspaces(&conn);
    move_view_to_workspace(&conn, "c1", "w1", None, 0).unwrap();
    let l = placement(&conn);
    assert_eq!(l["c1"], ("w1".into(), None, 0));
    assert_eq!(l["r1"], ("w1".into(), None, 1));
    assert_eq!(l["r2"], ("w1".into(), None, 2));
    assert_eq!(l["c2"], ("w1".into(), Some("r1".into()), 0));
    // 另一个空间一律不动
    assert_eq!(l["p1"], ("w2".into(), None, 0));
}

#[test]
fn cross_workspace_move_rejects_bad_arguments() {
    let conn = setup();
    seed_two_workspaces(&conn);
    create(&conn, "d1", "w1", None, "派生", "board", "{}", Some("r2")).unwrap();
    soft_delete(&conn, "p2").unwrap();

    // 视图不存在 / 空间不存在
    assert!(move_view_to_workspace(&conn, "ghost", "w2", None, 0).is_err());
    assert!(move_view_to_workspace(&conn, "c1", "w9", None, 0).is_err());
    // 派生视图属于宿主，不能单独搬家
    assert!(move_view_to_workspace(&conn, "d1", "w2", None, 0).is_err());
    // 回收站里的页面不能搬，父级在回收站里也不行
    assert!(move_view_to_workspace(&conn, "p2", "w1", None, 0).is_err());
    assert!(move_view_to_workspace(&conn, "c1", "w2", Some("p2"), 0).is_err());
    // 目标父级必须在目标空间里：r2 是 w1 的页面
    assert!(move_view_to_workspace(&conn, "c1", "w2", Some("r2"), 0).is_err());
    // 全部拒绝后，两侧的位置与归属保持原样
    let l = placement(&conn);
    assert_eq!(l["c1"], ("w1".into(), Some("r1".into()), 0));
    assert_eq!(l["p1"], ("w2".into(), None, 0));
    assert_eq!(l["d1"], ("w1".into(), None, 0));
}

#[test]
fn create_document_seeds_content_row_and_fts() {
    let conn = setup();
    let name = r#"He said "hi" \ ok"#;
    let v = create(&conn, "v1", "w1", None, name, "document", "{}", None).unwrap();
    assert_eq!(v.position, 0);
    assert_eq!(v.is_trash, 0);
    let content: String = conn
        .query_row(
            "SELECT content FROM documents WHERE view_id = 'v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // 默认结构：H1 标题 + 分割线（与前端 document-structure-lock 的保护区一致）
    assert_eq!(
        content,
        r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"He said \"hi\" \\ ok"}]},{"type":"horizontalRule"}]}"#
    );
    // documents INSERT 触发器已写 FTS
    let fts: i64 = conn
        .query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fts, 1);
}

#[test]
fn create_grid_has_no_document_row() {
    let conn = setup();
    create(&conn, "v1", "w1", None, "grid", "grid", "{}", None).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn create_position_increments_per_parent() {
    let conn = setup();
    create(&conn, "a", "w1", None, "a", "grid", "{}", None).unwrap();
    create(&conn, "b", "w1", None, "b", "grid", "{}", None).unwrap();
    create(&conn, "c", "w1", Some("a"), "c", "grid", "{}", None).unwrap();
    let pa: i64 = conn
        .query_row("SELECT position FROM views WHERE id='a'", [], |r| r.get(0))
        .unwrap();
    let pb: i64 = conn
        .query_row("SELECT position FROM views WHERE id='b'", [], |r| r.get(0))
        .unwrap();
    let pc: i64 = conn
        .query_row("SELECT position FROM views WHERE id='c'", [], |r| r.get(0))
        .unwrap();
    assert_eq!((pa, pb, pc), (0, 1, 0));
}

#[test]
fn subtree_soft_delete_restore_and_purge() {
    let conn = setup();
    seed_default_fixture(&conn);
    conn.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
        [],
    )
    .unwrap();

    soft_delete(&conn, "c1").unwrap();
    for (id, trashed) in [("c1", 1), ("d1", 1), ("r1", 0)] {
        let t: i64 = conn
            .query_row(
                "SELECT is_trash FROM views WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t, trashed, "{id} trash state");
    }
    let del: Option<i64> = conn
        .query_row("SELECT deleted_at FROM views WHERE id='c1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(del.is_some());

    restore(&conn, "c1").unwrap();
    let t: i64 = conn
        .query_row("SELECT is_trash FROM views WHERE id='d1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(t, 0);

    purge(&conn, "c1").unwrap();
    // c1 被彻底删除；d1 在 restore 后已回到树里，不陪葬（改挂到 c1 的父级 r1）
    let c1: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id = 'c1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(c1, 0, "c1 purged");
    let (d1, d1_parent): (i64, Option<String>) = conn
        .query_row(
            "SELECT COUNT(*), MAX(parent_id) FROM views WHERE id = 'd1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(d1, 1, "restored descendant survives parent purge");
    assert_eq!(d1_parent.as_deref(), Some("r1"));
    let r1: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id='r1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(r1, 1);
}

#[test]
fn purge_keeps_child_restored_from_trash() {
    // 报告场景：删父页 → 在回收站单独恢复子页 → 彻底删除父页，子页及其文档必须存活
    let conn = setup();
    seed_default_fixture(&conn);
    conn.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO documents(view_id, content, updated_at) VALUES ('d1', '{\"type\":\"doc\"}', 1)",
        [],
    )
    .unwrap();

    soft_delete(&conn, "c1").unwrap();
    restore(&conn, "d1").unwrap();
    purge(&conn, "c1").unwrap();

    let doc: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE view_id = 'd1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(doc, 1, "restored child document must survive");
    let parent: Option<String> = conn
        .query_row("SELECT parent_id FROM views WHERE id = 'd1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        parent.as_deref(),
        Some("r1"),
        "child re-attached to grandparent"
    );
}

#[test]
fn purge_trash_reparents_restored_children_instead_of_leaving_dangling_parent() {
    let conn = setup();
    seed_default_fixture(&conn);
    conn.execute(
        "INSERT INTO views(id, workspace_id, parent_id, name, layout, extra, position, created_at, updated_at)
         VALUES ('d1', 'w1', 'c1', 'd1', 'document', '{}', 0, 1, 1)",
        [],
    )
    .unwrap();

    soft_delete(&conn, "c1").unwrap();
    restore(&conn, "d1").unwrap();
    purge_trash(&conn, "w1").unwrap();

    let (survives, parent): (i64, Option<String>) = conn
        .query_row(
            "SELECT COUNT(*), MAX(parent_id) FROM views WHERE id = 'd1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(survives, 1, "restored child survives empty-trash");
    assert_eq!(parent, None, "no dangling parent_id after empty-trash");
}

#[test]
fn purge_expired_trash_counts_and_respects_null_deleted_at() {
    let conn = setup();
    seed_default_fixture(&conn);
    let old = now_ms() - 40 * 24 * 3600 * 1000;
    conn.execute(
        "UPDATE views SET is_trash = 1, deleted_at = ?1 WHERE id = 'r2'",
        params![old],
    )
    .unwrap();
    conn.execute("UPDATE views SET is_trash = 1 WHERE id = 'r3'", [])
        .unwrap(); // deleted_at 仍为 NULL

    let n = purge_expired_trash(&conn, "w1", now_ms() - 30 * 24 * 3600 * 1000).unwrap();
    assert_eq!(n, 1);
    let r2: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id='r2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(r2, 0);
    let r3: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id='r3'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(r3, 1);
}

#[test]
fn purge_expired_trash_all_covers_workspaces_the_ui_never_opened() {
    let conn = setup();
    seed_default_fixture(&conn);
    // 第二个空间：前端那个定时器只管当前打开的工作区，这边必须照样清干净
    conn.execute(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('w9', 'x', 1, 1)",
        [],
    )
    .unwrap();
    create(&conn, "z1", "w9", None, "过期页", "document", "{}", None).unwrap();
    let old = now_ms() - 40 * 24 * 3600 * 1000;
    for id in ["r2", "z1"] {
        conn.execute(
            "UPDATE views SET is_trash = 1, deleted_at = ?2 WHERE id = ?1",
            params![id, old],
        )
        .unwrap();
    }
    // 没到期的那页要留下
    create(&conn, "z2", "w9", None, "新页", "document", "{}", None).unwrap();
    conn.execute(
        "UPDATE views SET is_trash = 1, deleted_at = ?1 WHERE id = 'z2'",
        params![now_ms()],
    )
    .unwrap();

    let n = purge_expired_trash_all(&conn, now_ms() - 30 * 24 * 3600 * 1000).unwrap();
    assert_eq!(n, 2, "两个空间的过期项都要清掉");
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM views WHERE id IN ('r2','z1')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    let z2: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id='z2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(z2, 1, "未到保留期的不动");
}

// ---------- 多视图（迁移 007：views.source_id） ----------
/// 在宿主表上建一个派生视图
fn derive(conn: &Connection, id: &str, host: &str, name: &str, layout: &str) -> ViewRow {
    create(conn, id, "w1", None, name, layout, "{}", Some(host)).unwrap()
}

fn ids(rows: &[ViewRow]) -> Vec<String> {
    rows.iter().map(|v| v.id.clone()).collect()
}

#[test]
fn derived_views_hide_from_tree_trash_and_recent() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    derive(&conn, "d1", "g1", "看板", "board");
    conn.execute("UPDATE views SET visited_at = 5 WHERE id = 'd1'", [])
        .unwrap();

    // 活跃态：派生视图既不在树里，也不因 visited_at 出现在最近
    assert_eq!(ids(&list_by_workspace(&conn, "w1").unwrap()), vec!["g1"]);
    assert!(
        list_recent(&conn, "w1", 10).unwrap().is_empty(),
        "派生视图不进最近列表"
    );

    // 回收站：派生视图随宿主一起软删，但不单独占一行
    soft_delete(&conn, "g1").unwrap();
    assert_eq!(ids(&list_trash(&conn, "w1").unwrap()), vec!["g1"]);
}

#[test]
fn list_for_source_returns_host_first_then_derived_by_position() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    derive(&conn, "d2", "g1", "日历", "calendar");
    derive(&conn, "d1", "g1", "看板", "board");
    assert_eq!(
        ids(&list_for_source(&conn, "g1").unwrap()),
        vec!["g1", "d2", "d1"]
    );

    // 宿主自身的派生视图不会漏，别的表也串不进来
    create(&conn, "g2", "w1", None, "另一张表", "grid", "{}", None).unwrap();
    assert_eq!(ids(&list_for_source(&conn, "g2").unwrap()), vec!["g2"]);
}

#[test]
fn create_derived_view_scopes_position_and_rejects_bad_host() {
    let conn = setup();
    // 宿主的树内 position 已占用 0/1，派生视图的 position 另起一套从 0 开始
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    create(&conn, "g2", "w1", None, "表2", "grid", "{}", None).unwrap();
    assert_eq!(derive(&conn, "d1", "g1", "看板", "board").position, 0);
    assert_eq!(derive(&conn, "d2", "g1", "日历", "calendar").position, 1);
    let g1_pos: i64 = conn
        .query_row("SELECT position FROM views WHERE id='g1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(g1_pos, 0, "派生视图不抢宿主的树内排序位");

    // 派生视图不进树：parent_id 强制 NULL，哪怕调用方传了父节点
    let d = create(&conn, "d3", "w1", Some("g2"), "x", "grid", "{}", Some("g1")).unwrap();
    assert_eq!(d.parent_id, None);
    assert_eq!(d.source_id.as_deref(), Some("g1"));

    // 宿主不存在 → 报错
    let err = create(&conn, "d4", "w1", None, "x", "board", "{}", Some("ghost")).unwrap_err();
    assert!(err.contains("database view not found"), "{err}");
    // 派生视图不能再被派生（否则数据归属要递归解析）
    let err = create(&conn, "d5", "w1", None, "x", "board", "{}", Some("d1")).unwrap_err();
    assert!(err.contains("database view not found"), "{err}");
    // document 布局的派生视图没有意义（内容挂在 documents 上）
    let err = create(&conn, "d6", "w1", None, "x", "document", "{}", Some("g1")).unwrap_err();
    assert!(err.contains("document layout"), "{err}");
}

#[test]
fn soft_delete_and_restore_cover_derived_views() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    derive(&conn, "d1", "g1", "看板", "board");

    soft_delete(&conn, "g1").unwrap();
    let (t, del): (i64, Option<i64>) = conn
        .query_row(
            "SELECT is_trash, deleted_at FROM views WHERE id='d1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((t, del.is_some()), (1, true), "派生视图随宿主进回收站");

    restore(&conn, "g1").unwrap();
    let (t, del): (i64, Option<i64>) = conn
        .query_row(
            "SELECT is_trash, deleted_at FROM views WHERE id='d1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (t, del.is_some()),
        (0, false),
        "恢复后派生视图回来且 deleted_at 清空"
    );
}

#[test]
fn purge_host_cascades_to_derived_views() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    derive(&conn, "d1", "g1", "看板", "board");
    purge(&conn, "g1").unwrap(); // views.source_id 的 FK ON DELETE CASCADE
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM views", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn move_renumber_ignores_derived_views() {
    let conn = setup();
    seed_default_fixture(&conn); // r1/r2/r3 根级 0..2
    derive(&conn, "d1", "r1", "看板", "board"); // parent_id 同为 NULL
    move_view(&conn, "r3", Some("r1"), 0).unwrap();
    let l = layout(&conn);
    assert_eq!(l["r3"], (Some("r1".into()), 0));
    assert_eq!(l["r1"], (None, 0));
    assert_eq!(l["r2"], (None, 1));
    // 派生视图没被当成根级兄弟参与重排：仍是 NULL 父级、position 独立
    assert_eq!(l["d1"], (None, 0));
}

#[test]
fn duplicate_copies_subtree_with_content_and_properties() {
    let conn = setup();
    seed_default_fixture(&conn); // r1(0)/r2(1)/r3(2)，c1..c3 挂在 r1 下
    conn.execute(
        "UPDATE views SET is_favorite = 1, tags = '[\"甲\"]', aliases = '[\"旧名\"]' WHERE id = 'r1'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO documents(view_id, content, updated_at) VALUES ('r1', '{\"text\":\"正文\"}', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO page_properties(view_id, key, value, field_type, position)
         VALUES ('r1', '状态', 'done', 'text', 0)",
        [],
    )
    .unwrap();

    let (view, docs) = duplicate(&conn, "r1", "r1copy", "r1 副本").unwrap();

    assert_eq!(view.name, "r1 副本");
    assert_eq!(view.parent_id, None);
    assert_eq!(view.position, 3, "副本排在同级末尾");
    assert_eq!(view.is_favorite, 0, "收藏不继承");
    let tags: String = conn
        .query_row("SELECT tags FROM views WHERE id = 'r1copy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(tags, "[\"甲\"]", "标签继承");
    let aliases: String = conn
        .query_row("SELECT aliases FROM views WHERE id = 'r1copy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(aliases, "[\"旧名\"]", "别名继承（副本同样有那些叫法）");

    // 整棵子树：3 个子节点，父级指向副本根，名称与相对顺序保持
    let l = layout(&conn);
    assert_eq!(l["r1copy_1"], (Some("r1copy".into()), 0));
    assert_eq!(l["r1copy_2"], (Some("r1copy".into()), 1));
    assert_eq!(l["r1copy_3"], (Some("r1copy".into()), 2));
    let child_name: String = conn
        .query_row("SELECT name FROM views WHERE id = 'r1copy_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(child_name, "c1");

    // 正文：返回值供调用方重建反链，库里与 FTS 同步（触发器取副本名作 title）
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].view_id, "r1copy");
    assert_eq!(docs[0].content, "{\"text\":\"正文\"}");
    let fts_title: String = conn
        .query_row(
            "SELECT title FROM documents_fts WHERE view_id = 'r1copy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts_title, "r1 副本");

    let pp: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM page_properties WHERE view_id = 'r1copy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pp, 1);

    // 源节点与其子树未被改动
    assert_eq!(layout(&conn)["r1"], (None, 0));
    let src_children: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM views WHERE parent_id = 'r1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(src_children, 3);
}

#[test]
fn duplicate_copies_database_fields_rows_cells_and_row_documents() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    conn.execute(
        "INSERT INTO database_fields(id, database_view_id, name, field_type, options, width, is_hidden, position)
         VALUES ('f1','g1','名称','text','{\"kind\":\"none\"}',180,0,0),
                ('f2','g1','创建时间','created_at','{\"kind\":\"none\"}',180,0,1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO database_rows(id, database_view_id, position, created_at, updated_at)
         VALUES ('r1','g1',0,1,1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO database_cells(row_id, field_id, value) VALUES ('r1','f1','\"甲\"')",
        [],
    )
    .unwrap();
    // 行详情文档：数据库页面的子节点（extra.row_detail 使其不进页面树，但仍在 parent_id 链上）
    create(
        &conn,
        "rd1",
        "w1",
        Some("g1"),
        "行详情",
        "document",
        "{\"row_detail\":true}",
        None,
    )
    .unwrap();
    conn.execute(
        "UPDATE database_rows SET document_id = 'rd1' WHERE id = 'r1'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE documents SET content = '{\"text\":\"行正文\"}' WHERE view_id = 'rd1'",
        [],
    )
    .unwrap();

    duplicate(&conn, "g1", "g1copy", "表 副本").unwrap();

    let field_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM database_fields WHERE database_view_id = 'g1copy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(field_count, 2);
    let copied_type: String = conn
        .query_row(
            "SELECT field_type FROM database_fields WHERE id = 'g1copy_f0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(copied_type, "text");

    // 行：document_id 映射到复制出来的行详情文档（子树里唯一的子节点）
    let (row_id, row_doc): (String, Option<String>) = conn
        .query_row(
            "SELECT id, document_id FROM database_rows WHERE database_view_id = 'g1copy'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let copied_rd = row_doc.expect("行详情文档应被映射到副本");
    assert_eq!(copied_rd, "g1copy_1");
    let rd_parent: Option<String> = conn
        .query_row(
            "SELECT parent_id FROM views WHERE id = ?1",
            params![copied_rd],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rd_parent.as_deref(), Some("g1copy"));
    let rd_content: String = conn
        .query_row(
            "SELECT content FROM documents WHERE view_id = ?1",
            params![copied_rd],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rd_content, "{\"text\":\"行正文\"}");

    // 单元格：普通字段值搬运，时间戳字段由触发器写成新时间
    let copied_value: String = conn
        .query_row(
            "SELECT value FROM database_cells WHERE row_id = ?1 AND field_id = 'g1copy_f0'",
            params![row_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(copied_value, "\"甲\"");
    let ts_value: String = conn
        .query_row(
            "SELECT value FROM database_cells WHERE row_id = ?1 AND field_id = 'g1copy_f1'",
            params![row_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        ts_value.contains('T'),
        "created_at 单元格应为新时间: {ts_value}"
    );

    // 源表不受影响：文本单元格 + 插行触发器写入的 created_at 单元格
    let src_cells: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM database_cells WHERE row_id = 'r1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(src_cells, 2);
}

/// 复制视图要连父子行层级一起搬：parent_id 重映射到副本里的新行；
/// 指向回收站行（不随副本带走）的引用降级成顶层行，不能留一个跨表的幽灵父 id。
#[test]
fn duplicate_remaps_row_parent_links() {
    let conn = setup();
    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    conn.execute(
        "INSERT INTO database_rows(id, database_view_id, position, parent_id, is_trash, created_at, updated_at)
         VALUES ('p1','g1',0,NULL,0,1,1),
                ('c1','g1',1,'p1',0,1,1),
                ('c2','g1',2,'t1',0,1,1),
                ('t1','g1',3,NULL,1,1,1)",
        [],
    )
    .unwrap();

    duplicate(&conn, "g1", "g1copy", "表 副本").unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id FROM database_rows WHERE database_view_id = 'g1copy' ORDER BY position",
        )
        .unwrap();
    let copied: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        copied,
        vec![
            ("g1copy_r0".into(), None),
            ("g1copy_r1".into(), Some("g1copy_r0".into())),
            ("g1copy_r2".into(), None),
        ],
        "层级要跟着搬，父行没被带走的要回落成顶层"
    );
    // 源表原样不动
    let src_parent: Option<String> = conn
        .query_row(
            "SELECT parent_id FROM database_rows WHERE id = 'c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(src_parent.as_deref(), Some("p1"));
}

#[test]
fn duplicate_missing_source_and_derived_view_are_rejected() {
    let conn = setup();
    let err = duplicate(&conn, "ghost", "newcopy", "副本").unwrap_err();
    assert!(err.contains("view not found"), "{err}");

    create(&conn, "g1", "w1", None, "表", "grid", "{}", None).unwrap();
    derive(&conn, "d1", "g1", "看板", "board");
    let err = duplicate(&conn, "d1", "dcopy", "看板 副本").unwrap_err();
    assert!(err.contains("derived view"), "{err}");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM views WHERE id = 'dcopy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "失败的复制不留下半成品");
}

// ---------- 页面别名（迁移 025：views.aliases） ----------

fn aliases_of(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT aliases FROM views WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn create_view_starts_with_empty_aliases() {
    let conn = setup();
    let v = create(&conn, "p1", "w1", None, "页面", "document", "{}", None).unwrap();
    assert_eq!(v.aliases, "[]", "新建页面默认没有别名（读侧不必判 NULL）");
    assert_eq!(aliases_of(&conn, "p1"), "[]");
}

#[test]
fn set_aliases_normalizes_trim_dedupe_and_order() {
    let conn = setup();
    create(&conn, "p1", "w1", None, "页面", "document", "{}", None).unwrap();

    set_aliases(&conn, "p1", r#"[" 旧名 ","","别名甲","旧名","英文 名"]"#).unwrap();

    // 首尾空白清掉、空串丢弃、完全同名的重复只留第一次出现的顺序
    assert_eq!(aliases_of(&conn, "p1"), r#"["旧名","别名甲","英文 名"]"#);
}

#[test]
fn set_aliases_rejects_non_array_and_non_string_items() {
    let conn = setup();
    create(&conn, "p1", "w1", None, "页面", "document", "{}", None).unwrap();

    for junk in [r#"{""a"":1}"#, r#""旧名""#, "[3]", r#"[[""嵌套""]]"#] {
        let err = set_aliases(&conn, "p1", junk).unwrap_err();
        assert!(err.contains("aliases"), "{junk} → {err}");
    }
    assert_eq!(aliases_of(&conn, "p1"), "[]", "非法输入不落库");

    let err = set_aliases(&conn, "ghost", "[]").unwrap_err();
    assert!(err.contains("view not found"), "{err}");
}

#[test]
fn set_aliases_empty_array_clears_them() {
    let conn = setup();
    create(&conn, "p1", "w1", None, "页面", "document", "{}", None).unwrap();
    set_aliases(&conn, "p1", r#"["旧名"]"#).unwrap();

    set_aliases(&conn, "p1", "[]").unwrap();

    assert_eq!(aliases_of(&conn, "p1"), "[]");
}

#[test]
fn tags_and_aliases_share_the_normalization_but_not_the_column() {
    let conn = setup();
    create(&conn, "p1", "w1", None, "页面", "document", "{}", None).unwrap();

    set_tags(&conn, "p1", r#"[" 工作 ","工作"]"#).unwrap();
    set_aliases(&conn, "p1", r#"[" 旧名 ","旧名"]"#).unwrap();

    let tags: String = conn
        .query_row("SELECT tags FROM views WHERE id = 'p1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tags, r#"["工作"]"#);
    assert_eq!(aliases_of(&conn, "p1"), r#"["旧名"]"#, "两列互不串写");
}
