#!/usr/bin/env bun
/**
 * Generate the fork's icons and logos from the pixel grids below.
 *
 *   bun run branding/generate-assets.ts
 *
 * Writes branding/assets/ (committed). No image tools needed: PNG, ICO and ICNS are
 * encoded here, so this runs on any OS. scripts/apply-branding.ts copies the results
 * into the app at build time.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'

const OUT = join(import.meta.dir, 'assets')

// ─── Design ───────────────────────────────────────────────────────────────────

/** App symbol: a 5x5 pixel "S". */
const SYMBOL = [
  '.####',
  '#....',
  '.###.',
  '....#',
  '####.',
]

/** Wordmark "SONJJ": 5x5 letters with a one-cell gap. */
const LETTERS: Record<string, string[]> = {
  S: SYMBOL,
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  J: ['..###', '....#', '....#', '#...#', '.###.'],
}
const WORDMARK = joinLetters('SONJJ')

/** App icon in a 1024 design space, following the macOS icon grid (824 tile, 100 inset). */
const ICON = {
  tile: { x0: 100, y0: 100, x1: 924, y1: 924, radius: 185 },
  gradient: { top: [0x34, 0x34, 0x3c], bottom: [0x18, 0x18, 0x1d] },
  glyph: { x: 292, y: 292, cell: 88, color: [0xf4, 0xf4, 0xf6] },
}

function joinLetters(word: string): string[] {
  const rows = ['', '', '', '', '']
  word.split('').forEach((ch, i) => {
    const letter = LETTERS[ch]
    if (!letter) throw new Error(`No pixel letter for "${ch}"`)
    for (let r = 0; r < 5; r++) rows[r] += (i > 0 ? '.' : '') + letter[r]
  })
  return rows
}

// ─── SVG ──────────────────────────────────────────────────────────────────────

/** Path data for a pixel grid: one rect per horizontal run, in grid units. */
function gridPath(grid: string[]): string {
  const parts: string[] = []
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== '#') { x++; continue }
      let w = 0
      while (row[x + w] === '#') w++
      parts.push(`M${x},${y}h${w}v1h-${w}z`)
      x += w
    }
  })
  return parts.join('')
}

function gridSvg(grid: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid[0].length} ${grid.length}">` +
    `<path d="${gridPath(grid)}" fill="currentColor"/></svg>\n`
}

function iconSvg(): string {
  const { tile, gradient, glyph } = ICON
  const hex = (c: number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${hex(gradient.top)}"/><stop offset="1" stop-color="${hex(gradient.bottom)}"/>` +
    `</linearGradient></defs>` +
    `<rect x="${tile.x0}" y="${tile.y0}" width="${tile.x1 - tile.x0}" height="${tile.y1 - tile.y0}" rx="${tile.radius}" fill="url(#bg)"/>` +
    `<path transform="translate(${glyph.x} ${glyph.y}) scale(${glyph.cell})" d="${gridPath(SYMBOL)}" fill="${hex(glyph.color)}"/>` +
    `</svg>\n`
}

// ─── Raster ───────────────────────────────────────────────────────────────────

function insideTile(x: number, y: number): boolean {
  const { x0, y0, x1, y1, radius: r } = ICON.tile
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function insideGlyph(x: number, y: number): boolean {
  const { x: gx, y: gy, cell } = ICON.glyph
  const col = Math.floor((x - gx) / cell)
  const row = Math.floor((y - gy) / cell)
  return row >= 0 && row < 5 && col >= 0 && col < 5 && SYMBOL[row][col] === '#'
}

/** Render the app icon at size x size, supersampled, as straight (non-premultiplied) RGBA. */
function renderIcon(size: number): Uint8Array {
  const ss = size >= 256 ? 4 : 8
  const scale = 1024 / size
  const { tile, gradient, glyph } = ICON
  const px = new Uint8Array(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let cover = 0, glyphCover = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) * scale
          const y = (py + (sy + 0.5) / ss) * scale
          if (!insideTile(x, y)) continue
          cover++
          if (insideGlyph(x, y)) glyphCover++
        }
      }
      if (cover === 0) continue
      const t = Math.min(1, Math.max(0, ((py + 0.5) * scale - tile.y0) / (tile.y1 - tile.y0)))
      const g = glyphCover / cover
      const i = (py * size + pxl) * 4
      for (let c = 0; c < 3; c++) {
        const bg = gradient.top[c] + (gradient.bottom[c] - gradient.top[c]) * t
        px[i + c] = Math.round(bg + (glyph.color[c] - bg) * g)
      }
      px[i + 3] = Math.round((255 * cover) / (ss * ss))
    }
  }
  return px
}

// ─── Encoders ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

/** ICO with 32-bit BMP entries below 256 px and a PNG entry at 256 px, like upstream's icon.ico. */
function encodeIco(sizes: number[]): Buffer {
  const images = sizes.map(size => {
    const rgba = renderIcon(size)
    if (size >= 256) return encodePng(rgba, size)
    const maskRow = Math.ceil(size / 32) * 4
    const bmp = Buffer.alloc(40 + size * size * 4 + maskRow * size) // AND mask stays zero: alpha decides
    bmp.writeUInt32LE(40, 0)
    bmp.writeInt32LE(size, 4)
    bmp.writeInt32LE(size * 2, 8) // XOR + AND mask height
    bmp.writeUInt16LE(1, 12)
    bmp.writeUInt16LE(32, 14)
    bmp.writeUInt32LE(size * size * 4 + maskRow * size, 20)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = (y * size + x) * 4
        const dst = 40 + ((size - 1 - y) * size + x) * 4 // bottom-up, BGRA
        bmp[dst] = rgba[src + 2]
        bmp[dst + 1] = rgba[src + 1]
        bmp[dst + 2] = rgba[src]
        bmp[dst + 3] = rgba[src + 3]
      }
    }
    return bmp
  })

  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i
    header[e] = size >= 256 ? 0 : size
    header[e + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(images[i].length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

/** ICNS with PNG payloads (macOS 10.7+). */
function encodeIcns(): Buffer {
  const entries: Array<[string, number]> = [
    ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
    ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
  ]
  const pngs = new Map<number, Buffer>()
  const blocks = entries.map(([type, size]) => {
    if (!pngs.has(size)) pngs.set(size, encodePng(renderIcon(size), size))
    const data = pngs.get(size)!
    const block = Buffer.alloc(8 + data.length)
    block.write(type, 0, 'ascii')
    block.writeUInt32BE(8 + data.length, 4)
    block.set(data, 8)
    return block
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + blocks.reduce((n, b) => n + b.length, 0), 4)
  return Buffer.concat([header, ...blocks])
}

// ─── Write ────────────────────────────────────────────────────────────────────

function write(name: string, data: string | Buffer): void {
  const path = join(OUT, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
  console.log(`  ${name}`)
}

const png = (size: number) => encodePng(renderIcon(size), size)

console.log(`Writing ${OUT}`)
write('symbol.svg', gridSvg(SYMBOL))
write('logo.svg', gridSvg(WORDMARK))
write('icon.svg', iconSvg())
write('icon-1024.png', png(1024))
write('icon.png', png(512))
write('icon.icns', encodeIcns())
write('icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256]))
write('web/apple-touch-icon.png', png(180))
write('web/icon-192.png', png(192))
write('web/icon-512.png', png(512))
write('web/favicon.ico', encodeIco([16, 32, 48]))
