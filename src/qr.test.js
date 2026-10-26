// The QR encoder is the one piece of this feature that a machine cannot
// fully prove: only a phone camera can. What these tests do instead is read
// every symbol back the way a scanner reads it: find the format bits, work
// out the mask from them, unmask, walk the data modules in the spec's order,
// deinterleave, and compare the bytes with what went in. A symbol that
// survives that round trip is placed, masked and labelled correctly.

import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBits, qrMatrix, qrRows, qrVersion } from './qr.js'

// The published format strings for error correction level M. They are the
// external check on the BCH calculation: if these match, a real scanner
// reads the right level and mask out of the symbol.
const FORMAT_M = {
  0: '101010000010010',
  1: '101000100100101',
  2: '101111001111100',
  3: '101101101001011',
  4: '100010111111001',
  5: '100000011001110',
  6: '100111110010111',
  7: '100101010100000',
}

// ---- a reader, written the way a scanner reads ----

const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38] }
const BLOCK_TOTAL = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196 }
const BLOCK_DATA = { 1: 16, 2: 28, 3: 44, 4: 32, 5: 43, 6: 27, 7: 31 }
const BLOCK_COUNT = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 4, 7: 4 }

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

/** Which modules are function patterns, worked out independently of the encoder. */
function functionMap(size, version) {
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const mark = (row, col) => {
    if (row >= 0 && col >= 0 && row < size && col < size) fn[row][col] = true
  }
  for (const [row0, col0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let row = -1; row <= 7; row += 1) {
      for (let col = -1; col <= 7; col += 1) mark(row0 + row, col0 + col)
    }
  }
  for (let i = 0; i < size; i += 1) {
    mark(6, i)
    mark(i, 6)
  }
  for (const row of ALIGNMENT[version]) {
    for (const col of ALIGNMENT[version]) {
      const corner =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (corner) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) mark(row + dr, col + dc)
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i)
    mark(i, 8)
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8)
    mark(8, size - 1 - i)
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(Math.floor(i / 3), (i % 3) + size - 11)
      mark((i % 3) + size - 11, Math.floor(i / 3))
    }
  }
  return fn
}

/** The 15 format bits as a scanner reads them: bit 14 first, as a string. */
function readFormat(matrix) {
  const bits = []
  for (let i = 0; i <= 5; i += 1) bits.push(matrix[i][8])
  bits.push(matrix[7][8], matrix[8][8], matrix[8][7])
  for (let i = 9; i < 15; i += 1) bits.push(matrix[8][14 - i])
  return bits.reverse().join('')
}

/** The same bits from the copy split between the other two finders. */
function readFormatCopy(matrix) {
  const size = matrix.length
  const bits = []
  for (let i = 0; i < 8; i += 1) bits.push(matrix[8][size - 1 - i])
  for (let i = 8; i < 15; i += 1) bits.push(matrix[size - 15 + i][8])
  return bits.reverse().join('')
}

/** Data codewords, in the order the spec writes them. */
function readCodewords(matrix, version) {
  const size = matrix.length
  const fn = functionMap(size, version)
  const bits = []
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let k = 0; k < 2; k += 1) {
        if (!fn[row][col - k]) bits.push(matrix[row][col - k])
      }
    }
    upward = !upward
  }
  const total = BLOCK_TOTAL[version]
  const out = []
  for (let i = 0; i + 8 <= total * 8; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    out.push(byte)
  }
  // What is left over is the version's remainder bits, which are zero:
  // versions 2 to 6 carry seven of them, versions 1 and 7 carry none.
  assert.equal(bits.slice(total * 8).length, version === 1 || version === 7 ? 0 : 7)
  return out
}

function decode(text) {
  const matrix = qrMatrix(text)
  const version = qrVersion(text)
  const size = 21 + 4 * (version - 1)
  assert.equal(matrix.length, size)
  for (const row of matrix) assert.equal(row.length, size)

  // The format bits name the mask, and the level, exactly, in both copies.
  const format = readFormat(matrix)
  assert.equal(readFormatCopy(matrix), format, 'both format copies agree')
  const mask = Object.keys(FORMAT_M).find((key) => FORMAT_M[key] === format)
  assert.notEqual(mask, undefined, `format bits ${format} are not level M`)
  assert.equal(format.slice(0, 2), '10', 'the level bits are 00 before the mask')

  // Unmask, then read.
  const fn = functionMap(size, version)
  const plain = matrix.map((row) => row.slice())
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!fn[row][col] && MASKS[Number(mask)](row, col)) plain[row][col] ^= 1
    }
  }
  const words = readCodewords(plain, version)

  // Deinterleave: the stream carries codeword 0 of every block, then
  // codeword 1 of every block, so block b's codeword i sits at stream
  // position i * blocks + b.
  const perBlock = BLOCK_DATA[version]
  const blocks = BLOCK_COUNT[version]
  const data = new Array(perBlock * blocks)
  for (let i = 0; i < perBlock; i += 1) {
    for (let block = 0; block < blocks; block += 1) {
      data[block * perBlock + i] = words[i * blocks + block]
    }
  }
  assert.equal(data.length, perBlock * blocks)

  // Byte mode, then the length, then the bytes.
  const bits = []
  for (const word of data) for (let i = 7; i >= 0; i -= 1) bits.push((word >> i) & 1)
  const read = (from, width) => {
    let value = 0
    for (let i = 0; i < width; i += 1) value = (value << 1) | bits[from + i]
    return value
  }
  assert.equal(read(0, 4), 0b0100, 'byte mode')
  const length = read(4, 8)
  const bytes = []
  for (let i = 0; i < length; i += 1) bytes.push(read(12 + i * 8, 8))
  return { version, mask: Number(mask), text: new TextDecoder().decode(Uint8Array.from(bytes)), size }
}

// ---- the tests ----

test('the format bits match the standard table for level M', () => {
  for (const [mask, bits] of Object.entries(FORMAT_M)) {
    assert.equal(formatBits(Number(mask)).toString(2).padStart(15, '0'), bits, `mask ${mask}`)
  }
})

test('a pairing URL reads back byte for byte in a version 3 symbol', () => {
  const url = 'http://192.168.1.42:47823/#K7QM2XTB9R'
  const read = decode(url)
  assert.equal(read.text, url)
  assert.equal(read.version, 3)
  assert.equal(read.size, 29)
})

test('the quiet zone is not counted in the matrix', () => {
  const rows = qrRows('http://10.0.0.9:47823/#ABCDEFGH')
  assert.equal(rows.length, 21 + 4 * (qrVersion('http://10.0.0.9:47823/#ABCDEFGH') - 1))
  for (const row of rows) for (const module of row) assert.equal(typeof module, 'boolean')
})

test('every version 1 to 7 round trips at its capacity edge', () => {
  const capacities = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122 }
  for (const [version, capacity] of Object.entries(capacities)) {
    const exact = 'A'.repeat(Number(capacity))
    assert.equal(qrVersion(exact), Number(version), `a ${capacity} byte payload is version ${version}`)
    const read = decode(exact)
    assert.equal(read.text, exact)
    // One more byte moves it up a version, so the edge is really the edge.
    if (Number(version) < 7) {
      assert.ok(qrVersion('A'.repeat(Number(capacity) + 1)) > Number(version))
    }
  }
})

test('a symbol is deterministic, and different payloads are different symbols', () => {
  const one = qrMatrix('http://192.168.1.2:47823/#AAAAAAAA').map((row) => row.join('')).join('')
  const again = qrMatrix('http://192.168.1.2:47823/#AAAAAAAA').map((row) => row.join('')).join('')
  const other = qrMatrix('http://192.168.1.2:47823/#BBBBBBBB').map((row) => row.join('')).join('')
  assert.equal(one, again)
  assert.notEqual(one, other)
})

test('the finder patterns and the dark module are where a scanner looks', () => {
  const matrix = qrMatrix('http://192.168.1.42:47823/#K7QM2XTB9R')
  const size = matrix.length
  for (const [row0, col0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    assert.equal(matrix[row0][col0], 1, 'the finder corner is dark')
    assert.equal(matrix[row0 + 1][col0 + 1], 0, 'the ring inside it is light')
    assert.equal(matrix[row0 + 3][col0 + 3], 1, 'its core is dark')
  }
  assert.equal(matrix[size - 8][8], 1, 'the dark module')
  // The timing pattern alternates along row and column six.
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0)
    assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0)
  }
})

test('a payload no version can hold says so instead of drawing garbage', () => {
  assert.throws(() => qrVersion('x'.repeat(400)), /does not fit/)
})
