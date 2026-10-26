// A small QR encoder: byte mode, error correction level M, versions 1 to 7.
//
// OpenRemote pairs a phone by drawing one QR code: a LAN URL such as
// `http://192.168.1.42:47823/#K7QM2XTB9R`, which is at most about 37
// characters, so version 3 fits it and versions 1 to 7 leave room to spare.
// Neither lockfile carries an encoder and adding a dependency is not an
// option, so this module is the encoder.
//
// The tables below are the standard's, and every one of these versions uses
// blocks of one size, which keeps the interleaving simple enough to read.
// `qr.test.js` checks the symbol with a decoder written the way a scanner
// reads it, and checks the format bits against the published table.

// Level M, per version: [total codewords, data codewords per block, blocks,
// error correction codewords per block].
const BLOCKS = {
  1: [26, 16, 1, 10],
  2: [44, 28, 1, 16],
  3: [70, 44, 1, 26],
  4: [100, 32, 2, 18],
  5: [134, 43, 2, 24],
  6: [172, 27, 4, 16],
  7: [196, 31, 4, 18],
}

// Where the alignment patterns sit, by version (empty for version 1).
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
}

// Error correction level M is 00 in the format bits.
const LEVEL_M = 0

// ---- GF(256), the field the Reed-Solomon codes live in ----

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
let gfReady = false

function gfInit() {
  if (gfReady) return
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    // Multiply by the primitive polynomial's root (x + 1), modulo 0x11d.
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
  gfReady = true
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** The generator polynomial for `degree` error correction codewords. */
function generator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** The `degree` error correction codewords for one block of data. */
function eccFor(data, degree) {
  const gen = generator(degree)
  const remainder = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor)
  }
  return remainder
}

// ---- the data codewords ----

function versionFor(bytes) {
  for (let version = 1; version <= 7; version += 1) {
    const [, perBlock, blocks] = BLOCKS[version]
    // Two codewords are the mode indicator and the length; the rest is
    // payload.
    if (perBlock * blocks - 2 >= bytes) return version
  }
  throw new Error(`a ${bytes} byte payload does not fit in version 7`)
}

export function qrVersion(text) {
  return versionFor(new TextEncoder().encode(text).length)
}

/** Mode indicator, length, payload, terminator, and the standard padding. */
function dataCodewords(text, version) {
  const bytes = new TextEncoder().encode(text)
  const [, perBlock, blocks] = BLOCKS[version]
  const dataCount = perBlock * blocks
  const bits = []
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, 8) // versions 1 to 9 count in 8 bits
  for (const byte of bytes) push(byte, 8)
  // Terminator: up to four zero bits, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < dataCount * 8; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  for (let i = 0; codewords.length < dataCount; i += 1) codewords.push(i % 2 === 0 ? 0xec : 0x11)
  return codewords
}

/** Data and correction codewords, interleaved the way the spec orders them. */
function codewords(text, version) {
  const [, perBlock, blocks, eccPerBlock] = BLOCKS[version]
  const data = dataCodewords(text, version)
  const chunks = []
  for (let i = 0; i < blocks; i += 1) {
    chunks.push(data.slice(i * perBlock, (i + 1) * perBlock))
  }
  const ecc = chunks.map((chunk) => eccFor(chunk, eccPerBlock))
  const out = []
  for (let i = 0; i < perBlock; i += 1) {
    for (let block = 0; block < blocks; block += 1) out.push(chunks[block][i])
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (let block = 0; block < blocks; block += 1) out.push(ecc[block][i])
  }
  return out
}

// ---- the symbol ----

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

/** The 15 format bits for level M and `mask`, BCH(15, 5) plus the mask. */
export function formatBits(mask) {
  let value = (LEVEL_M << 3) | mask
  let remainder = value << 10
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >> i) & 1) remainder ^= 0x537 << (i - 10)
  }
  return ((value << 10) | remainder) ^ 0x5412
}

function placeFinder(modules, reserved, row0, col0) {
  const size = modules.length
  for (let row = -1; row <= 7; row += 1) {
    for (let col = -1; col <= 7; col += 1) {
      const r = row0 + row
      const c = col0 + col
      if (r < 0 || c < 0 || r >= size || c >= size) continue
      const inside = row >= 0 && row <= 6 && col >= 0 && col <= 6
      const ring = row === 0 || row === 6 || col === 0 || col === 6
      const core = row >= 2 && row <= 4 && col >= 2 && col <= 4
      modules[r][c] = inside && (ring || core) ? 1 : 0
      reserved[r][c] = true
    }
  }
}

function placeAlignment(modules, reserved, version) {
  const centers = ALIGNMENT[version]
  const size = modules.length
  for (const row of centers) {
    for (const col of centers) {
      // The three corners already hold finder patterns.
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8)
      if (nearFinder) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          modules[row + dr][col + dc] = dark ? 1 : 0
          reserved[row + dr][col + dc] = true
        }
      }
    }
  }
}

function placeTiming(modules, reserved) {
  const size = modules.length
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0
    modules[6][i] = dark
    reserved[6][i] = true
    modules[i][6] = dark
    reserved[i][6] = true
  }
}

/** The small 18 bit block that versions 7 and up carry. */
function placeVersionInfo(modules, reserved, version) {
  if (version < 7) return
  const size = modules.length
  let remainder = version << 12
  for (let i = 17; i >= 12; i -= 1) {
    if ((remainder >> i) & 1) remainder ^= 0x1f25 << (i - 12)
  }
  const bits = (version << 12) | remainder
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1
    const row = Math.floor(i / 3)
    const col = (i % 3) + size - 11
    modules[row][col] = bit
    reserved[row][col] = true
    modules[col][row] = bit
    reserved[col][row] = true
  }
}

function drawFormat(modules, mask) {
  const size = modules.length
  const bits = formatBits(mask)
  // Bit 0 is the least significant bit of the 15, and the standard puts it
  // next to the top left finder's corner. Written twice: a scanner may read
  // either copy.
  const bit = (index) => (bits >> index) & 1
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i)
  modules[7][8] = bit(6)
  modules[8][8] = bit(7)
  modules[8][7] = bit(8)
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i)
  // The second copy is split between the other two finders, and ends on the
  // dark module.
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i)
  modules[size - 8][8] = 1
}

function placeData(modules, reserved, bits) {
  const size = modules.length
  let index = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    // Column 6 is the vertical timing pattern: the pair shifts left over it.
    if (col === 6) col -= 1
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let k = 0; k < 2; k += 1) {
        const c = col - k
        if (reserved[row][c]) continue
        modules[row][c] = index < bits.length ? bits[index] : 0
        index += 1
      }
    }
    upward = !upward
  }
}

function penalty(modules) {
  const size = modules.length
  let score = 0
  // Runs of five or more same-coloured modules in a row or a column.
  for (let i = 0; i < size; i += 1) {
    for (const read of [(j) => modules[i][j], (j) => modules[j][i]]) {
      let run = 1
      for (let j = 1; j < size; j += 1) {
        if (read(j) === read(j - 1)) {
          run += 1
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else {
          run = 1
        }
      }
    }
  }
  // 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const first = modules[row][col]
      if (
        first === modules[row][col + 1] &&
        first === modules[row + 1][col] &&
        first === modules[row + 1][col + 1]
      ) {
        score += 3
      }
    }
  }
  // The finder-like 1:1:3:1:1 patterns.
  const pattern = [1, 0, 1, 1, 1, 0, 1]
  const matches = (read) => {
    for (let i = 0; i + 6 < size; i += 1) {
      let hit = true
      for (let k = 0; k < 7; k += 1) {
        if (read(i + k) !== pattern[k]) {
          hit = false
          break
        }
      }
      if (hit) {
        const before = i - 4 >= -1 && read(i - 1) === 0 && read(i - 2) === 0 && read(i - 3) === 0 && read(i - 4) === 0
        const after = i + 11 <= size && read(i + 7) === 0 && read(i + 8) === 0 && read(i + 9) === 0 && read(i + 10) === 0
        if (before || after) score += 40
      }
    }
  }
  for (let i = 0; i < size; i += 1) {
    matches((j) => modules[i][j])
    matches((j) => modules[j][i])
  }
  // Dark ratio away from 50%.
  let dark = 0
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += modules[row][col]
  }
  const total = size * size
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10
  return score
}

/**
 * The modules of `text` as a square matrix: 1 for a dark module, 0 for a
 * light one, quiet zone not included.
 */
export function qrMatrix(text) {
  gfInit()
  const version = qrVersion(text)
  const size = 21 + 4 * (version - 1)
  const bits = []
  for (const byte of codewords(text, version)) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1)
  }

  // The function patterns first; everything they cover is reserved, and the
  // data walk fills the rest. The data bits are the same whichever mask
  // wins, so they are placed once, before the masks are tried.
  const base = Array.from({ length: size }, () => new Array(size).fill(0))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  placeFinder(base, reserved, 0, 0)
  placeFinder(base, reserved, 0, size - 7)
  placeFinder(base, reserved, size - 7, 0)
  placeTiming(base, reserved)
  placeAlignment(base, reserved, version)
  placeVersionInfo(base, reserved, version)
  for (let i = 0; i <= 8; i += 1) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[size - 1 - i][8] = true
    reserved[8][size - 1 - i] = true
  }
  placeData(base, reserved, bits)

  // Every mask produces a readable symbol; the penalty picks the one least
  // likely to be misread. The format bits must name the mask that is drawn,
  // which is what makes the choice self-describing for a scanner.
  let best = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = base.map((row) => row.slice())
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (!reserved[row][col] && MASKS[mask](row, col)) modules[row][col] ^= 1
      }
    }
    drawFormat(modules, mask)
    const score = penalty(modules)
    if (score < bestScore) {
      bestScore = score
      best = modules
    }
  }
  return best
}

/** The same matrix as a list of rows of booleans, for drawing. */
export function qrRows(text) {
  return qrMatrix(text).map((row) => row.map((module) => module === 1))
}
