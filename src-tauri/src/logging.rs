// 日志落盘：控制台之外再写一份 `<数据目录>/logs/tsflowy-YYYYMMDD.log`。
// 数据目录要等 setup 里 bootstrap 完才确定，所以落点先挂空、目录定了再 attach；
// 在那之前只有 bootstrap 自己的几行，它们只进控制台（那时还不知道该往哪写）。
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::files::auto_backup::format_local_time;

/// 日志子目录名（诊断包按这个名字收文件）
pub const LOG_SUBDIR: &str = "logs";
const FILE_PREFIX: &str = "tsflowy-";
const FILE_SUFFIX: &str = ".log";
/// 单日文件上限：异常刷屏时宁可截断，也不吃掉用户磁盘
const MAX_DAY_BYTES: u64 = 4 * 1024 * 1024;
/// 只保留最近这么多天的日志
const KEEP_DAYS: usize = 7;

/// 本地时间的「日序号 + 可读时间」。human 形如 `2026-10-18 09:12:33`；
/// 取不出日期部分时退回 epoch 序号——日志宁可标错时间，也不能因此丢掉内容。
fn local_stamp(t: SystemTime) -> (String, String) {
    let human = format_local_time(t);
    match human.get(0..10) {
        Some(d) if d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' => {
            (d.replace('-', ""), human)
        }
        _ => {
            let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            (format!("epoch{secs}"), human)
        }
    }
}

struct Inner {
    day: String,
    file: Option<File>,
    bytes: u64,
    /// 当日写满上限后停止落盘（只在满的那一刻提示一次，之后静默）
    capped: bool,
}

impl Inner {
    const fn new() -> Self {
        Self {
            day: String::new(),
            file: None,
            bytes: 0,
            capped: false,
        }
    }
}

/// 一个数据目录对应的日志落点。做成结构体而不全是全局量，好让截断与轮转能被单测覆盖。
pub struct Sink {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl Sink {
    /// 建目录；建不出来就返回 Err，调用方（attach）选择不落盘
    pub fn create(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            inner: Mutex::new(Inner::new()),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 只留最近 KEEP_DAYS 个日志文件，更早的删掉。按文件名里的日期序，
    /// 非本前缀的文件一律不碰（日志目录可能被用户塞了别的东西）。
    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.starts_with(FILE_PREFIX) && n.ends_with(FILE_SUFFIX))
            .collect();
        names.sort();
        names.reverse();
        for name in names.into_iter().skip(KEEP_DAYS) {
            let _ = fs::remove_file(self.dir.join(name));
        }
    }

    /// 追加一段已格式化好的字节（tracing 层给的是整行，append_client 给的是自己拼的一行）
    pub fn append(&self, bytes: &[u8], cap: u64) -> io::Result<()> {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            // 锁被 panic 污染不影响日志本身
            Err(poisoned) => poisoned.into_inner(),
        };
        let (day, _) = local_stamp(SystemTime::now());
        if guard.day != day || guard.file.is_none() {
            guard.file.take();
            let path = self.dir.join(format!("{FILE_PREFIX}{day}{FILE_SUFFIX}"));
            guard.day = day;
            guard.bytes = 0;
            guard.capped = false;
            guard.file = Some(OpenOptions::new().create(true).append(true).open(&path)?);
            // 开完再收尾：当天的文件已经建好，算进 KEEP_DAYS 里，总数才真的不超过这么多天
            self.prune();
        }
        if guard.capped {
            return Ok(());
        }
        // 先记账再写：写失败最多少一行，反过来（持有 file 的可变借用时再改 guard）编译不过
        let over = guard.bytes.saturating_add(bytes.len() as u64) > cap;
        if over {
            guard.capped = true;
        } else {
            guard.bytes += bytes.len() as u64;
        }
        let file = match guard.file.as_mut() {
            Some(f) => f,
            None => return Ok(()),
        };
        if over {
            let _ =
                file.write_all("\n[logging] 当日日志已达上限，后续行本次运行不再写入\n".as_bytes());
            let _ = file.flush();
            return Ok(());
        }
        file.write_all(bytes)?;
        let _ = file.flush();
        Ok(())
    }

    /// 前端（webview）日志并入同一份文件：WebView2 的控制台用户打不开，报障只能靠落盘日志
    pub fn append_client(&self, level: &str, message: &str) {
        let (_, stamp) = local_stamp(SystemTime::now());
        let line = format!("{stamp} [{level:>5}] (webview) {message}\n");
        let _ = self.append(line.as_bytes(), MAX_DAY_BYTES);
    }
}

static SINK: OnceLock<Sink> = OnceLock::new();

/// setup 里数据目录确定后调用。重复调用以第一次为准（进程生命周期内数据目录不变）。
pub fn attach(data_dir: &Path) {
    if let Ok(sink) = Sink::create(&data_dir.join(LOG_SUBDIR)) {
        let _ = SINK.set(sink);
    }
}

fn sink() -> Option<&'static Sink> {
    SINK.get()
}

/// 当前日志目录（未 attach 时为 None），诊断包据此收日志
pub fn log_dir() -> Option<PathBuf> {
    sink().map(|s| s.dir().to_path_buf())
}

/// tracing 的文件落点：控制台那层之外再多挂一层用它，行格式由 fmt 层负责
#[derive(Clone, Copy, Default)]
pub struct FileWriter;

impl Write for FileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 落盘失败绝不能把应用带崩：这层吞掉错误，控制台那层还在
        if let Some(s) = sink() {
            let _ = s.append(buf, MAX_DAY_BYTES);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileWriter {
    type Writer = FileWriter;

    fn make_writer(&'a self) -> FileWriter {
        FileWriter
    }
}

/// 前端日志入口（未 attach 时静默丢弃）
pub fn append_client(level: &str, message: &str) {
    if let Some(s) = sink() {
        s.append_client(level, message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "tsflowy-logging-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn log_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect()
    }

    #[test]
    fn writes_tracing_lines_and_client_lines_into_one_daily_file() {
        let base = temp_base("write");
        let sink = Sink::create(&base.join(LOG_SUBDIR)).unwrap();
        sink.append(b"hello line\n", MAX_DAY_BYTES).unwrap();
        sink.append_client("WARN", "前端一行");
        let dir = base.join(LOG_SUBDIR);
        let names = log_names(&dir);
        assert_eq!(names.len(), 1, "同一天只应有一个日志文件: {names:?}");
        assert!(names[0].starts_with(FILE_PREFIX) && names[0].ends_with(FILE_SUFFIX));
        let text = fs::read_to_string(dir.join(&names[0])).unwrap();
        assert!(text.contains("hello line"), "{text}");
        assert!(text.contains("(webview) 前端一行"), "{text}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn bytes_over_cap_stop_the_day_and_say_so_once() {
        let base = temp_base("cap");
        let sink = Sink::create(&base.join(LOG_SUBDIR)).unwrap();
        sink.append(&[b'x'; 30], 40).unwrap();
        sink.append(&[b'y'; 30], 40).unwrap();
        sink.append(b"never\n", 40).unwrap();
        let dir = base.join(LOG_SUBDIR);
        let file = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .next()
            .unwrap();
        let text = fs::read_to_string(file).unwrap();
        assert!(!text.contains("never"), "截断后不该继续写: {text}");
        assert_eq!(
            text.matches("已达上限").count(),
            1,
            "提示只该出现一次: {text}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prune_keeps_the_newest_days_and_ignores_foreign_names() {
        let base = temp_base("prune");
        let dir = base.join(LOG_SUBDIR);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..(KEEP_DAYS + 3) {
            fs::write(
                dir.join(format!("{FILE_PREFIX}202610{i:02}{FILE_SUFFIX}")),
                b"x",
            )
            .unwrap();
        }
        fs::write(dir.join("keepme.txt"), b"x").unwrap();
        let sink = Sink::create(&dir).unwrap();
        // 触发一次跨天：写满 guard.day 与今天不同的分支才会 prune
        sink.inner.lock().unwrap().day = "19700101".to_string();
        sink.append(b"new day\n", MAX_DAY_BYTES).unwrap();
        let names = log_names(&dir);
        assert_eq!(
            names.iter().filter(|n| n.starts_with(FILE_PREFIX)).count(),
            KEEP_DAYS,
            "{names:?}"
        );
        assert!(names.contains(&"keepme.txt".to_string()));
        // 最旧的三天被删，留下的都是较新日期
        assert!(!names
            .iter()
            .any(|n| n.contains("20261000") || n.contains("20261001") || n.contains("20261002")));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stamp_splits_day_and_human_time() {
        let (day, human) = local_stamp(SystemTime::now());
        assert_eq!(day.len(), 8, "{day}");
        assert!(day.chars().all(|c| c.is_ascii_digit()), "{day}");
        assert!(human.contains(':'), "{human}");
    }
}
