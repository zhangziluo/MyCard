// ============================================================================
// xlsx.js — 极简 .xlsx 读取器（零依赖：自写 ZIP 读取 + 最小 XML 扫描）
//
// .xlsx 本质是 ZIP(XML)。本模块只解析**第一个工作表**，还原为二维字符串表，
// 交给 import-file.js 走既有的「预览表格 + 字段映射 + 目标牌组」链路。
//
// 支持：
//   - ZIP：STORED(0) 与 DEFLATE(8)（用 DecompressionStream('deflate-raw') 解压）
//   - 单元格：共享字符串 t="s" / 内联字符串 t="inlineStr" / t="str" / 数值 /
//             布尔 t="b" / 常见日期（内置 numFmtId 或含 y/d 的自定义格式码）
// 明确不支持：公式求值、合并单元格、多工作表选择、富文本样式、ZIP64、加密工作簿
// ============================================================================

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const DAY_MS = 86400000;
/** Excel 1900 日期系统序列号 0 对应的 Unix 毫秒（含 Excel 的 1900-02-29 兼容） */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/* ------------------------------ ZIP 读取 ------------------------------ */

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
    throw new Error('当前环境不支持解压 DEFLATE 的 .xlsx；请改用 CSV 或在 Excel 中「另存为 CSV」');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEocd(dv, len) {
  const to = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= to; i--) if (dv.getUint32(i, true) === SIG_EOCD) return i;
  return -1;
}

/**
 * 解出 ZIP 内全部条目（条目名 → 字节）。
 * @param {Uint8Array} bytes
 * @param {{ inflate?: (d: Uint8Array) => Promise<Uint8Array> }} opts 便于测试注入
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzip(bytes, { inflate = inflateRaw } = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(dv, buf.length);
  if (eocd < 0) throw new Error('不是有效的 .xlsx（未找到 ZIP 结构）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // 中央目录偏移
  const dec = new TextDecoder('utf-8');
  const out = new Map();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (dv.getUint32(p, true) !== SIG_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (dv.getUint32(localOff, true) !== SIG_LOC) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflate(raw));
    // 其它压缩方法（bzip2 / lzma）不支持 → 跳过
  }
  return out;
}

/* ------------------------------ 最小 XML 扫描 ------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解码 XML 实体（含数字实体） */
export function decodeXml(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch (err) {
        return m;
      }
    }
    return ENTITIES[e] != null ? ENTITIES[e] : m;
  });
}

/** 取标签内某个属性值（属性顺序任意） */
function attr(tag, name) {
  const m = new RegExp('\\b' + name.replace(/[:.]/g, '\\$&') + '\\s*=\\s*"([^"]*)"').exec(String(tag || ''));
  return m ? decodeXml(m[1]) : null;
}

/** 拼接片段内所有 <t>…</t>（用于 <si> / <is>，支持富文本分段） */
function allText(inner) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(inner))) out += decodeXml(m[1]);
  return out;
}

/** "C12" → 2（0 基列号）；无字母 → -1 */
export function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 共享字符串表：<si>…</si> → 文本数组 */
export function parseSharedStrings(xml) {
  const list = [];
  if (!xml) return list;
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) list.push(m[1] == null ? '' : allText(m[1]));
  return list;
}

/** Excel 序列号 → 可读文本（整数为日期，含小数则带时间） */
export function excelSerialToDate(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  const d = new Date(EXCEL_EPOCH_MS + v * DAY_MS);
  if (isNaN(d.getTime())) return String(n);
  const p = (x) => String(x).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return v % 1 !== 0 ? `${base} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : base;
}

/** styles.xml → 「cellXfs 下标 → 是否日期格式」（内置日期 numFmtId + 含 y/d 的自定义格式） */
export function parseDateStyleIndexes(stylesXml) {
  const dates = new Set();
  if (!stylesXml) return dates;
  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const custom = new Set();
  const cf = /<numFmt\b[^>]*\/?>/g;
  let m;
  while ((m = cf.exec(stylesXml))) {
    const id = attr(m[0], 'numFmtId');
    const code = attr(m[0], 'formatCode');
    if (id != null && code && /[yYdD]/.test(code)) custom.add(Number(id));
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!block) return dates;
  const xf = /<xf\b[^>]*\/?>/g;
  let i = 0;
  let x;
  while ((x = xf.exec(block[1]))) {
    const idm = attr(x[0], 'numFmtId');
    const id = idm == null ? 0 : Number(idm);
    if (builtin.has(id) || custom.has(id)) dates.add(i);
    i++;
  }
  return dates;
}

/**
 * 工作表 XML → 二维字符串表（按 r="C5" 定位列，跳列补空）。
 * @param {string} xml
 * @param {{ shared?: string[], dateStyles?: Set<number> }} opts
 * @returns {string[][]}
 */
export function parseSheet(xml, { shared = [], dateStyles = new Set() } = {}) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cellsXml = rm[3] || '';
    const slots = [];
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(cellsXml))) {
      const attrs = cm[2] != null ? cm[2] : cm[1];
      const body = cm[3] || '';
      const t = attr(attrs, 't') || '';
      const s = attr(attrs, 's');
      let val = '';
      if (t === 'inlineStr') {
        val = allText(body);
      } else {
        const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = vm ? decodeXml(vm[1]) : '';
        if (t === 's') val = shared[Number(raw)] != null ? shared[Number(raw)] : '';
        else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str') val = raw;
        else if (raw !== '' && s != null && dateStyles.has(Number(s))) val = excelSerialToDate(raw);
        else val = raw;
      }
      const ci = colIndex(attr(attrs, 'r'));
      const idx = ci >= 0 ? ci : auto;
      slots[idx] = val;
      auto = idx + 1;
    }
    for (let i = 0; i < slots.length; i++) if (slots[i] === undefined) slots[i] = '';
    rows.push(slots);
  }
  return rows;
}

/** 定位第一个工作表的 ZIP 条目名（优先按 workbook.xml + rels 解析，回退 sheet1.xml） */
export function firstSheetPath(files) {
  const names = [...files.keys()];
  const fallback = names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)) || null;
  const wb = files.get('xl/workbook.xml');
  if (!wb) return fallback;
  const dec = new TextDecoder('utf-8');
  const first = /<sheet\b[^>]*\/?>/.exec(dec.decode(wb));
  const rid = first ? attr(first[0], 'r:id') : null;
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (!rid || !rels) return fallback;
  const tags = dec.decode(rels).match(/<Relationship\b[^>]*\/?>/g) || [];
  for (const tag of tags) {
    if (attr(tag, 'Id') !== rid) continue;
    const target = attr(tag, 'Target');
    if (!target) break;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    if (files.has(path)) return path;
  }
  return fallback;
}

/**
 * .xlsx 字节 → 二维字符串表（第一个工作表）。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<string[][]>}
 */
export async function parseXlsxRows(bytes, opts = {}) {
  const files = await unzip(bytes, opts);
  const dec = new TextDecoder('utf-8');
  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(dec.decode(files.get('xl/sharedStrings.xml'))) : [];
  const dateStyles = files.has('xl/styles.xml') ? parseDateStyleIndexes(dec.decode(files.get('xl/styles.xml'))) : new Set();
  const path = firstSheetPath(files);
  if (!path) throw new Error('这个 .xlsx 里没有找到工作表');
  return parseSheet(dec.decode(files.get(path)), { shared, dateStyles });
}
