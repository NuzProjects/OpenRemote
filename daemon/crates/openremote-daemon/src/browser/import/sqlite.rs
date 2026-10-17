//! A small reader for SQLite files, enough to read the tables other
//! browsers keep their history and bookmarks in: whole-table scans of
//! ordinary (rowid) tables, text in UTF-8, a write-ahead log applied on
//! top. Nothing is ever written, and the file read is always a copy.
//!
//! It exists so importing costs no dependency: SQLite itself would be C
//! compiled into every build (the daemon also ships as a Linux binary and
//! inside the Android app) for a feature used once. The format is stable
//! and documented (https://sqlite.org/fileformat2.html); only the parts
//! these tables need are here.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::rc::Rc;

/// What a column holds.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    pub fn int(&self) -> Option<i64> {
        match self {
            Value::Int(n) => Some(*n),
            Value::Real(f) => Some(*f as i64),
            _ => None,
        }
    }

    pub fn real(&self) -> Option<f64> {
        match self {
            Value::Int(n) => Some(*n as f64),
            Value::Real(f) => Some(*f),
            _ => None,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// The file is not a database this reader understands.
    Format(&'static str),
    /// No such table (or column).
    Missing(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Format(why) => write!(f, "not a database that can be read ({why})"),
            Error::Missing(what) => write!(f, "no {what} in it"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

type Result<T> = std::result::Result<T, Error>;

/// A table: where its b-tree starts and what its columns are called.
pub struct Table {
    root: u32,
    columns: Vec<String>,
    /// The column that is the row's own id (`INTEGER PRIMARY KEY`): the
    /// record stores nothing for it.
    alias: Option<usize>,
}

pub struct Database {
    file: File,
    page_size: usize,
    /// Page content minus the bytes the file reserves at each page's end.
    usable: usize,
    /// Pages from the write-ahead log, which are newer than the file's.
    wal: HashMap<u32, Rc<Vec<u8>>>,
}

const HEADER: &[u8; 16] = b"SQLite format 3\0";
/// A b-tree is never this deep; a file that says otherwise is damaged.
const MAX_DEPTH: u32 = 24;

fn be16(b: &[u8], at: usize) -> usize {
    u16::from_be_bytes([b[at], b[at + 1]]) as usize
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// A variable-length integer: its value and how many bytes it took.
fn varint(b: &[u8], at: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for i in 0..9 {
        let byte = *b.get(at + i)?;
        if i == 8 {
            return Some(((value << 8) | byte as u64, 9));
        }
        value = (value << 7) | (byte & 0x7f) as u64;
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    None
}

impl Database {
    /// Opens a database file, and applies the write-ahead log beside it
    /// (`<file>-wal`) when there is one.
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let mut head = [0u8; 100];
        file.read_exact(&mut head)
            .map_err(|_| Error::Format("too short"))?;
        if &head[..16] != HEADER {
            return Err(Error::Format("not SQLite"));
        }
        let page_size = match be16(&head, 16) {
            1 => 65536,
            n if n >= 512 && n.is_power_of_two() => n,
            _ => return Err(Error::Format("page size")),
        };
        let usable = page_size - head[20] as usize;
        if usable < 480 {
            return Err(Error::Format("page size"));
        }
        // 0 is a file whose text encoding was never needed (no table yet).
        if !matches!(be32(&head, 56), 0 | 1) {
            return Err(Error::Format("text is not UTF-8"));
        }
        let mut name = path.as_os_str().to_owned();
        name.push("-wal");
        let wal = std::fs::read(&name)
            .map(|bytes| read_wal(&bytes, page_size))
            .unwrap_or_default();
        Ok(Self {
            file,
            page_size,
            usable,
            wal,
        })
    }

    fn page(&mut self, number: u32) -> Result<Rc<Vec<u8>>> {
        if number == 0 {
            return Err(Error::Format("page 0"));
        }
        if let Some(page) = self.wal.get(&number) {
            return Ok(Rc::clone(page));
        }
        let mut page = vec![0u8; self.page_size];
        self.file
            .seek(SeekFrom::Start((number as u64 - 1) * self.page_size as u64))?;
        self.file
            .read_exact(&mut page)
            .map_err(|_| Error::Format("a page is missing"))?;
        Ok(Rc::new(page))
    }

    /// The table with this name.
    pub fn table(&mut self, name: &str) -> Result<Table> {
        let mut found = None;
        let master = Table {
            root: 1,
            columns: ["type", "name", "tbl_name", "rootpage", "sql"]
                .map(String::from)
                .to_vec(),
            alias: None,
        };
        self.scan(&master, &["type", "name", "rootpage", "sql"], |_, row| {
            if row[0].text() == Some("table") && row[1].text() == Some(name) {
                if let (Some(root), Some(sql)) = (row[2].int(), row[3].text()) {
                    found = Some((root as u32, sql.to_string()));
                    return false;
                }
            }
            true
        })?;
        let (root, sql) = found.ok_or_else(|| Error::Missing(format!("table {name}")))?;
        let (columns, alias) = columns_of(&sql);
        Ok(Table {
            root,
            columns,
            alias,
        })
    }

    /// Calls `each` with the row's id and the named columns of every row
    /// of the table, in order, until it answers false.
    pub fn scan(
        &mut self,
        table: &Table,
        columns: &[&str],
        mut each: impl FnMut(i64, &[Value]) -> bool,
    ) -> Result<()> {
        let want: Vec<usize> = columns
            .iter()
            .map(|c| {
                table
                    .columns
                    .iter()
                    .position(|name| name.eq_ignore_ascii_case(c))
                    .ok_or_else(|| Error::Missing(format!("column {c}")))
            })
            .collect::<Result<_>>()?;
        let mut row = Vec::with_capacity(want.len());
        self.walk(table.root, 0, &mut |id, payload| {
            row.clear();
            if !record(payload, &want, table.alias, id, &mut row) {
                // A row that can't be read is skipped, not fatal.
                return true;
            }
            each(id, &row)
        })?;
        Ok(())
    }

    /// Visits a table b-tree's rows in order; false from `visit` stops.
    fn walk(
        &mut self,
        number: u32,
        depth: u32,
        visit: &mut dyn FnMut(i64, &[u8]) -> bool,
    ) -> Result<bool> {
        if depth > MAX_DEPTH {
            return Err(Error::Format("b-tree too deep"));
        }
        let page = self.page(number)?;
        let at = if number == 1 { 100 } else { 0 };
        let kind = *page.get(at).ok_or(Error::Format("short page"))?;
        let cells = be16(&page, at + 3);
        match kind {
            // Interior: each cell leads to a child; the last child is
            // named in the header.
            0x05 => {
                let pointers = at + 12;
                for i in 0..cells {
                    let cell = be16(&page, pointers + 2 * i);
                    if cell + 4 > page.len() {
                        return Err(Error::Format("cell outside page"));
                    }
                    if !self.walk(be32(&page, cell), depth + 1, visit)? {
                        return Ok(false);
                    }
                }
                self.walk(be32(&page, at + 8), depth + 1, visit)
            }
            // Leaf: the rows themselves.
            0x0d => {
                let pointers = at + 8;
                for i in 0..cells {
                    let cell = be16(&page, pointers + 2 * i);
                    let Some((size, a)) = varint(&page, cell) else {
                        return Err(Error::Format("cell"));
                    };
                    let Some((id, b)) = varint(&page, cell + a) else {
                        return Err(Error::Format("cell"));
                    };
                    let start = cell + a + b;
                    let payload = self.payload(&page, start, size as usize)?;
                    if !visit(id as i64, &payload) {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            _ => Err(Error::Format("not a table page")),
        }
    }

    /// A cell's whole payload: what is on the page, then the overflow
    /// pages it continues on.
    fn payload(&mut self, page: &[u8], start: usize, size: usize) -> Result<Vec<u8>> {
        let u = self.usable;
        let max_local = u - 35;
        if size <= max_local {
            return page
                .get(start..start + size)
                .map(<[u8]>::to_vec)
                .ok_or(Error::Format("payload outside page"));
        }
        let min_local = (u - 12) * 32 / 255 - 23;
        let k = min_local + (size - min_local) % (u - 4);
        let local = if k <= max_local { k } else { min_local };
        let mut out = Vec::with_capacity(size);
        out.extend_from_slice(
            page.get(start..start + local)
                .ok_or(Error::Format("payload outside page"))?,
        );
        let mut next = be32(page, start + local);
        while out.len() < size {
            if next == 0 {
                return Err(Error::Format("overflow chain ends early"));
            }
            let overflow = self.page(next)?;
            let take = (size - out.len()).min(u - 4);
            out.extend_from_slice(
                overflow
                    .get(4..4 + take)
                    .ok_or(Error::Format("overflow page"))?,
            );
            next = be32(&overflow, 0);
        }
        Ok(out)
    }
}

/// The wanted columns of one record, appended to `out`. False when the
/// record is damaged.
fn record(payload: &[u8], want: &[usize], alias: Option<usize>, id: i64, out: &mut Vec<Value>) -> bool {
    let Some((header, mut at)) = varint(payload, 0) else {
        return false;
    };
    let header = header as usize;
    if header > payload.len() {
        return false;
    }
    // Serial types, and where each column's bytes start.
    let mut types = Vec::new();
    while at < header {
        let Some((t, n)) = varint(payload, at) else {
            return false;
        };
        types.push(t);
        at += n;
    }
    let mut offsets = Vec::with_capacity(types.len());
    let mut body = header;
    for t in &types {
        offsets.push(body);
        body += match t {
            0 | 8 | 9 => 0,
            1 => 1,
            2 => 2,
            3 => 3,
            4 => 4,
            5 => 6,
            6 | 7 => 8,
            t if *t >= 12 => ((*t - 12) / 2) as usize,
            _ => return false,
        };
    }
    for &column in want {
        if alias == Some(column) {
            out.push(Value::Int(id));
            continue;
        }
        let (Some(&t), Some(&from)) = (types.get(column), offsets.get(column)) else {
            // A column added after the row was written reads as null.
            out.push(Value::Null);
            continue;
        };
        let value = match t {
            0 => Value::Null,
            8 => Value::Int(0),
            9 => Value::Int(1),
            1..=6 => {
                let len = [1, 2, 3, 4, 6, 8][t as usize - 1];
                let Some(bytes) = payload.get(from..from + len) else {
                    return false;
                };
                let mut n = if bytes[0] & 0x80 != 0 { -1i64 } else { 0 };
                for byte in bytes {
                    n = (n << 8) | *byte as i64;
                }
                Value::Int(n)
            }
            7 => {
                let Some(bytes) = payload.get(from..from + 8) else {
                    return false;
                };
                Value::Real(f64::from_be_bytes(bytes.try_into().expect("eight bytes")))
            }
            t => {
                let len = if t % 2 == 0 { (t - 12) / 2 } else { (t - 13) / 2 } as usize;
                let Some(bytes) = payload.get(from..from + len) else {
                    return false;
                };
                if t % 2 == 0 {
                    Value::Blob(bytes.to_vec())
                } else {
                    Value::Text(String::from_utf8_lossy(bytes).into_owned())
                }
            }
        };
        out.push(value);
    }
    true
}

/// A table's column names from its CREATE statement, and which one is
/// the row id.
fn columns_of(sql: &str) -> (Vec<String>, Option<usize>) {
    let Some(open) = sql.find('(') else {
        return (Vec::new(), None);
    };
    let close = sql.rfind(')').unwrap_or(sql.len());
    let body = &sql[open + 1..close.max(open + 1)];
    // Split at commas outside parentheses and quotes.
    let mut parts = Vec::new();
    let (mut depth, mut quote, mut from) = (0i32, None::<char>, 0usize);
    for (i, c) in body.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"' | '`') => quote = Some(c),
            (None, '[') => quote = Some(']'),
            (None, '(') => depth += 1,
            (None, ')') => depth -= 1,
            (None, ',') if depth == 0 => {
                parts.push(&body[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&body[from..]);
    let mut columns = Vec::new();
    let mut alias = None;
    for part in parts {
        let part = part.trim();
        let first = part
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(['"', '`', '[', ']', '\'']);
        let upper = part.to_ascii_uppercase();
        if matches!(
            first.to_ascii_uppercase().as_str(),
            "PRIMARY" | "UNIQUE" | "CHECK" | "FOREIGN" | "CONSTRAINT"
        ) {
            continue;
        }
        // `INTEGER PRIMARY KEY DESC` is an ordinary column in SQLite, the
        // one quirk of the rule.
        if upper.contains("INTEGER PRIMARY KEY") && !upper.contains("PRIMARY KEY DESC") {
            alias = Some(columns.len());
        }
        columns.push(first.to_string());
    }
    (columns, alias)
}

/// The pages a write-ahead log holds as of its last commit. Frames carry
/// the salt of the log's current run and a running checksum; the first
/// frame that fails either, and everything after it, is a write that
/// never finished.
fn read_wal(bytes: &[u8], page_size: usize) -> HashMap<u32, Rc<Vec<u8>>> {
    let mut pages = HashMap::new();
    if bytes.len() < 32 {
        return pages;
    }
    let magic = be32(bytes, 0);
    if magic != 0x377f_0682 && magic != 0x377f_0683 {
        return pages;
    }
    let big = magic & 1 == 1;
    if be32(bytes, 8) as usize != page_size {
        return pages;
    }
    let word = |at: usize| -> u32 {
        let w = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
        if big {
            u32::from_be_bytes(w)
        } else {
            u32::from_le_bytes(w)
        }
    };
    let sum = |mut s: (u32, u32), from: usize, to: usize| -> (u32, u32) {
        let mut at = from;
        while at + 8 <= to {
            s.0 = s.0.wrapping_add(word(at)).wrapping_add(s.1);
            s.1 = s.1.wrapping_add(word(at + 4)).wrapping_add(s.0);
            at += 8;
        }
        s
    };
    let mut running = sum((0, 0), 0, 24);
    if running != (be32(bytes, 24), be32(bytes, 28)) {
        return pages;
    }
    let salt = (be32(bytes, 16), be32(bytes, 20));
    let frame = 24 + page_size;
    let mut staged: Vec<(u32, usize)> = Vec::new();
    let mut at = 32;
    while at + frame <= bytes.len() {
        if (be32(bytes, at + 8), be32(bytes, at + 12)) != salt {
            break;
        }
        running = sum(running, at, at + 8);
        running = sum(running, at + 24, at + frame);
        if running != (be32(bytes, at + 16), be32(bytes, at + 20)) {
            break;
        }
        staged.push((be32(bytes, at), at + 24));
        // A commit frame names the database's size after it: everything
        // staged so far is real.
        if be32(bytes, at + 4) != 0 {
            for (number, from) in staged.drain(..) {
                pages.insert(number, Rc::new(bytes[from..from + page_size].to_vec()));
            }
        }
        at += frame;
    }
    pages
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_run_one_to_nine_bytes() {
        assert_eq!(varint(&[0x7f], 0), Some((127, 1)));
        assert_eq!(varint(&[0x81, 0x00], 0), Some((128, 2)));
        assert_eq!(varint(&[0xff; 9], 0), Some((u64::MAX, 9)));
        assert_eq!(varint(&[0x81], 0), None);
    }

    #[test]
    fn column_names_come_from_the_create_statement() {
        let (columns, alias) = columns_of(
            "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL, \"last visit\" INTEGER, PRIMARY KEY(a, b), CHECK(x IN (1,2)))",
        );
        assert_eq!(
            columns,
            ["id", "url", "title", "visit_count", "last visit"].map(String::from)
        );
        assert_eq!(alias, Some(0));
        let (columns, alias) = columns_of("CREATE TABLE t (a TEXT, b INTEGER PRIMARY KEY DESC)");
        assert_eq!(columns, ["a", "b"].map(String::from));
        // A descending key is not a row-id alias in SQLite.
        assert_eq!(alias, None);
    }
}
