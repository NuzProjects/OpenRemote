//! A reader for binary property lists (`bplist00`), enough for Safari's
//! bookmarks: strings, numbers, arrays and dictionaries; everything else
//! reads as `Other`. The format is Apple's, public in its open-source
//! CoreFoundation (`CFBinaryPList.c`).

#[derive(Clone, Debug, PartialEq)]
pub enum Plist {
    Bool(bool),
    Int(i64),
    Real(f64),
    Text(String),
    Data(Vec<u8>),
    Array(Vec<Plist>),
    Dict(Vec<(String, Plist)>),
    Other,
}

impl Plist {
    pub fn get(&self, key: &str) -> Option<&Plist> {
        match self {
            Plist::Dict(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            Plist::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Plist]> {
        match self {
            Plist::Array(items) => Some(items),
            _ => None,
        }
    }
}

/// A list nested deeper than this is damaged (or a cycle).
const MAX_DEPTH: u32 = 64;

struct Reader<'a> {
    bytes: &'a [u8],
    offset_size: usize,
    ref_size: usize,
    count: usize,
    table: usize,
}

/// The list's top object, or none when the bytes aren't a binary list.
pub fn parse(bytes: &[u8]) -> Option<Plist> {
    if bytes.len() < 8 + 32 || !bytes.starts_with(b"bplist00") {
        return None;
    }
    let trailer = &bytes[bytes.len() - 32..];
    let be = |b: &[u8]| b.iter().fold(0usize, |n, byte| (n << 8) | *byte as usize);
    let reader = Reader {
        bytes,
        offset_size: trailer[6] as usize,
        ref_size: trailer[7] as usize,
        count: be(&trailer[8..16]),
        table: be(&trailer[24..32]),
    };
    if !(1..=8).contains(&reader.offset_size) || !(1..=8).contains(&reader.ref_size) {
        return None;
    }
    reader.object(be(&trailer[16..24]), 0)
}

impl Reader<'_> {
    fn number(&self, at: usize, size: usize) -> Option<usize> {
        let bytes = self.bytes.get(at..at.checked_add(size)?)?;
        Some(bytes.iter().fold(0usize, |n, b| (n << 8) | *b as usize))
    }

    fn object(&self, index: usize, depth: u32) -> Option<Plist> {
        if depth > MAX_DEPTH || index >= self.count {
            return None;
        }
        let at = self.number(self.table + index * self.offset_size, self.offset_size)?;
        let marker = *self.bytes.get(at)?;
        let (kind, info) = (marker >> 4, (marker & 0xf) as usize);
        // A length: in the marker, or an integer object after it.
        let sized = |from: usize| -> Option<(usize, usize)> {
            if info != 0xf {
                return Some((info, from));
            }
            let int = *self.bytes.get(from)?;
            if int >> 4 != 1 {
                return None;
            }
            let width = 1usize << (int & 0xf);
            Some((self.number(from + 1, width)?, from + 1 + width))
        };
        Some(match kind {
            0x0 => match marker {
                0x08 => Plist::Bool(false),
                0x09 => Plist::Bool(true),
                _ => Plist::Other,
            },
            0x1 => {
                let width = 1usize << info;
                if width > 8 {
                    return Some(Plist::Other);
                }
                // Eight-byte integers are signed (the cast keeps their bits),
                // the smaller ones are not.
                Plist::Int(self.number(at + 1, width)? as i64)
            }
            0x2 => {
                let bytes = self.bytes.get(at + 1..at + 1 + (1usize << info))?;
                match bytes.len() {
                    4 => Plist::Real(f32::from_be_bytes(bytes.try_into().ok()?) as f64),
                    8 => Plist::Real(f64::from_be_bytes(bytes.try_into().ok()?)),
                    _ => Plist::Other,
                }
            }
            0x4 => {
                let (len, from) = sized(at + 1)?;
                Plist::Data(self.bytes.get(from..from.checked_add(len)?)?.to_vec())
            }
            0x5 => {
                let (len, from) = sized(at + 1)?;
                let bytes = self.bytes.get(from..from.checked_add(len)?)?;
                Plist::Text(String::from_utf8_lossy(bytes).into_owned())
            }
            0x6 => {
                let (len, from) = sized(at + 1)?;
                let bytes = self.bytes.get(from..from.checked_add(len.checked_mul(2)?)?)?;
                let units: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect();
                Plist::Text(String::from_utf16_lossy(&units))
            }
            0xa => {
                let (len, from) = sized(at + 1)?;
                let mut items = Vec::with_capacity(len.min(4096));
                for i in 0..len {
                    let r = self.number(from + i * self.ref_size, self.ref_size)?;
                    items.push(self.object(r, depth + 1)?);
                }
                Plist::Array(items)
            }
            0xd => {
                let (len, from) = sized(at + 1)?;
                let mut entries = Vec::with_capacity(len.min(4096));
                for i in 0..len {
                    let k = self.number(from + i * self.ref_size, self.ref_size)?;
                    let v = self.number(from + (len + i) * self.ref_size, self.ref_size)?;
                    let Plist::Text(key) = self.object(k, depth + 1)? else {
                        return None;
                    };
                    entries.push((key, self.object(v, depth + 1)?));
                }
                Plist::Dict(entries)
            }
            _ => Plist::Other,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_not_a_binary_list_is_none() {
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"<?xml version=\"1.0\"?><plist></plist>"), None);
        assert_eq!(parse(&[0u8; 80]), None);
    }
}
