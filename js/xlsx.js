// ============================================================================
// xlsx.js — 极简 .xlsx 读取器（零依赖：自写 ZIP 读取 + 最小 XML 扫描）
//
// .xlsx 本质是 ZIP(XML)。本模块把工作表还原为二维字符串表，交给 import-file.js
// 走既有的「预览表格 + 字段映射 + 目标牌组」链路。
//
// 支持：
//   - ZIP：STORED(0) 与 DEFLATE(8)（用 DecompressionStream('deflate-raw') 解压）
//   - 单元格：共享字符串 t="s" / 内联字符串 t="inlineStr" / t="str" / 数值 /
//             布尔 t="b" / 常见日期（内置 numFmtId 或含 y/d 的自定义格式码）
//   - 多工作表（v0.5.7）：按 workbook.xml + rels 列出全部 sheet（名称 / 顺序 / 隐藏），
//             `openXlsx()` 可任选其中一张按需解析（懒加载 + 缓存）
//   - 公式（v0.5.7）：默认优先用 Excel 写入的**缓存值 `<v>`**；缓存缺失时（`fullCalcOnLoad`、
//             第三方库产出的表等）用内置的小型求值器算出来 —— 见 FORMULA_FUNCTIONS
//   - 合并单元格（v0.5.7）：`<mergeCells>` 解析 + 默认把左上角的值**填充**到整个合并区
//             （导入场景下「分类」跨行更实用）；`mergeMode: 'blank'` 则只保留左上角
// 明确不支持：跨工作表引用 / 名称定义 / 数组与共享公式的从属格 / 富文本样式 /
//             ZIP64、加密工作簿、图片等
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

/* --------------------------- 单元格引用 / 公式求值 --------------------------- */

/** "C12" → { r: 11, c: 2 }（0 基，容忍 $ 绝对引用）；非法返回 null */
export function refToRC(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(String(ref == null ? '' : ref).trim());
  if (!m) return null;
  const c = colIndex(m[1]);
  const r = Number(m[2]) - 1;
  return c < 0 || !(r >= 0) ? null : { r, c };
}

/** { r, c }（0 基）→ "C12" */
export function rcToRef(r, c) {
  let s = '';
  let n = Number(c) + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + (Number(r) + 1);
}

/**
 * 公式取值模式：
 *   - `cached`（默认）：优先用 Excel 写入的缓存结果 `<v>`；**缓存缺失**时才自己求值
 *     （第三方库导出的表常带 `fullCalcOnLoad` 且不含缓存值）
 *   - `evaluate`：只要有表达式就自己算，算不出来再回退缓存值
 */
export const FORMULA_MODE = { cached: 'cached', evaluate: 'evaluate' };

/** 求值器支持的运算符（`%` 为后缀百分比）；不在表内的写法（如跨表引用 `Sheet1!A1`）即「不支持」 */
export const FORMULA_OPERATORS = ['^', '*', '/', '+', '-', '&', '=', '<>', '<', '>', '<=', '>='];

/** 运算符优先级（Excel：^ > * / > + - > & > 比较） */
const BIN_PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

/** 公式分词；遇到不认识的字符返回 null（= 该公式不支持，调用方回退缓存值） */
function tokenizeFormula(src) {
  const s = String(src == null ? '' : src);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"') {
      // 字符串字面量（"" 转义为一个 "）
      let str = '';
      let closed = false;
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            str += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        str += s[i++];
      }
      if (!closed) return null;
      out.push({ t: 'str', v: str });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    // 单元格引用（可带 : 构成区域）；后面紧跟 ( 的按函数名处理（如 LOG10(100)）
    const ref = /^(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?::(\$?[A-Za-z]{1,3}\$?[0-9]{1,7}))?/.exec(s.slice(i));
    if (ref && !/^\s*\(/.test(s.slice(i + ref[0].length))) {
      out.push({ t: 'ref', v: ref[1], to: ref[2] || null });
      i += ref[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (name) {
      out.push({ t: 'name', v: name[0].toUpperCase() });
      i += name[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=<>(),%;'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    return null; // 未知 token（跨表引用 !、数组常量 {…} 等）→ 不支持
  }
  return out;
}


/* --------------------------- 公式：值语义与函数表 --------------------------- */

/** 摊平函数实参（区域求值结果本身是数组） */
function flattenArgs(args) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else out.push(v);
  };
  walk(args);
  return out;
}

/** 取数字（Excel 语义：布尔 → 1/0、空 → 0、文本数字可转、其余 #VALUE!） */
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null || v === '') return 0;
  const n = Number(String(v));
  if (!isFinite(n)) throw new Error('#VALUE!');
  return n;
}

/** 数值列表（SUM / COUNT 等只认能转成有限数字的项） */
function numList(args) {
  return flattenArgs(args)
    .map((v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v == null || v === '' ? null : Number(v)))
    .filter((n) => typeof n === 'number' && isFinite(n));
}

/** Excel 真值语义（数字 ≠ 0 为真、TRUE 为真；文本一律为假） */
function isTruthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return false;
}

/** 公式结果 → 单元格文本 */
export function formatFormulaValue(v) {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(12))); // 抹掉 0.30000000000000004 这类浮点尾巴
  }
  return String(v == null ? '' : v);
}

/** 四舍五入到 d 位（普通四舍五入，非银行家舍入） */
function roundTo(n, d) {
  const p = Math.pow(10, d);
  return Math.round((n + (n >= 0 ? 1 : -1) * Number.EPSILON) * p) / p;
}

/**
 * 内置函数表（`n` = 允许的参数个数区间）。范围**刻意收窄**：不在这张表里的写法
 * （VLOOKUP / 日期函数 / 跨表引用等）一律视为「不支持」→ 回退 Excel 缓存值。
 * IF / IFERROR 在求值器里做**惰性求值**（只算命中的分支），不在此表。
 */
const FUNCS = {
  SUM: { n: [1, 64], f: (a) => numList(a).reduce((s, n) => s + n, 0) },
  PRODUCT: { n: [1, 64], f: (a) => numList(a).reduce((s, n) => s * n, 1) },
  AVERAGE: {
    n: [1, 64],
    f: (a) => {
      const l = numList(a);
      if (!l.length) throw new Error('#DIV/0!');
      return l.reduce((s, n) => s + n, 0) / l.length;
    }
  },
  MIN: { n: [1, 64], f: (a) => (numList(a).length ? Math.min(...numList(a)) : 0) },
  MAX: { n: [1, 64], f: (a) => (numList(a).length ? Math.max(...numList(a)) : 0) },
  COUNT: { n: [1, 64], f: (a) => numList(a).length },
  COUNTA: { n: [1, 64], f: (a) => flattenArgs(a).filter((v) => v != null && v !== '').length },
  ROUND: { n: [1, 2], f: (a) => roundTo(toNum(a[0]), a.length > 1 ? Math.trunc(toNum(a[1])) : 0) },
  ABS: { n: [1, 1], f: (a) => Math.abs(toNum(a[0])) },
  INT: { n: [1, 1], f: (a) => Math.floor(toNum(a[0])) },
  MOD: {
    n: [2, 2],
    f: (a) => {
      const d = toNum(a[1]);
      if (!d) throw new Error('#DIV/0!');
      return toNum(a[0]) - d * Math.floor(toNum(a[0]) / d);
    }
  },
  POWER: { n: [2, 2], f: (a) => Math.pow(toNum(a[0]), toNum(a[1])) },
  SQRT: {
    n: [1, 1],
    f: (a) => {
      const x = toNum(a[0]);
      if (x < 0) throw new Error('#NUM!');
      return Math.sqrt(x);
    }
  },
  LEN: { n: [1, 1], f: (a) => String(a[0] == null ? '' : a[0]).length },
  UPPER: { n: [1, 1], f: (a) => String(a[0] == null ? '' : a[0]).toUpperCase() },
  LOWER: { n: [1, 1], f: (a) => String(a[0] == null ? '' : a[0]).toLowerCase() },
  TRIM: { n: [1, 1], f: (a) => String(a[0] == null ? '' : a[0]).trim().replace(/\s+/g, ' ') },
  LEFT: { n: [1, 2], f: (a) => String(a[0] == null ? '' : a[0]).slice(0, a.length > 1 ? Math.max(0, Math.trunc(toNum(a[1]))) : 1) },
  RIGHT: {
    n: [1, 2],
    f: (a) => {
      const s = String(a[0] == null ? '' : a[0]);
      const k = a.length > 1 ? Math.max(0, Math.trunc(toNum(a[1]))) : 1;
      return k === 0 ? '' : s.slice(-k);
    }
  },
  MID: {
    n: [2, 3],
    f: (a) => {
      const s = String(a[0] == null ? '' : a[0]);
      const start = Math.max(1, Math.trunc(toNum(a[1])));
      const len = a.length > 2 ? Math.max(0, Math.trunc(toNum(a[2]))) : s.length;
      return s.slice(start - 1, start - 1 + len);
    }
  },
  CONCAT: { n: [1, 64], f: (a) => flattenArgs(a).map((v) => (v == null ? '' : String(v))).join('') },
  CONCATENATE: { n: [1, 64], f: (a) => flattenArgs(a).map((v) => (v == null ? '' : String(v))).join('') },
  AND: { n: [1, 64], f: (a) => flattenArgs(a).every(isTruthy) },
  OR: { n: [1, 64], f: (a) => flattenArgs(a).some(isTruthy) },
  NOT: { n: [1, 1], f: (a) => !isTruthy(a[0]) }
};

/** 惰性/特殊求值的内置函数（不放进 FUNCS） */
const SPECIAL_FUNCS = ['IF', 'IFERROR', 'TRUE', 'FALSE'];

/** 求值器支持的全部函数名（供 README / 测试引用） */
export const FORMULA_FUNCTION_NAMES = Object.keys(FUNCS).concat(SPECIAL_FUNCS).sort();


/**
 * 工作表 XML → 二维字符串表（按 r="C5" 定位列，跳列补空；公式与合并单元格按 opts 处理）。
 * @param {string} xml
 * @param {{ shared?: string[], dateStyles?: Set<number>, mergeMode?: 'fill'|'blank',
 *           formulaMode?: 'cached'|'evaluate' }} [opts]
 * @returns {string[][]}
 */
export function parseSheet(xml, { ...opts } = {}) {
  return parseSheetDetailed(xml, opts).rows;
}

/* --------------------------- 公式：解析与求值 --------------------------- */

/** 递归下降解析 → AST；不认识的写法返回 null */
function parseFormulaAst(src) {
  const tokens = tokenizeFormula(src);
  if (!tokens || !tokens.length) return null;
  const st = { t: tokens, i: 0 };
  try {
    const node = parseExpr(st, 0);
    return st.i === tokens.length ? node : null;
  } catch (e) {
    return null;
  }
}

function pPeek(st) {
  return st.t[st.i] || null;
}

function pEat(st, v) {
  const t = pPeek(st);
  if (t && t.t === 'op' && t.v === v) {
    st.i++;
    return true;
  }
  return false;
}

function parseExpr(st, minPrec) {
  let left = parseUnary(st);
  for (;;) {
    const t = pPeek(st);
    if (!t || t.t !== 'op' || BIN_PREC[t.v] == null || BIN_PREC[t.v] < minPrec) break;
    const prec = BIN_PREC[t.v];
    st.i++;
    left = { k: 'bin', op: t.v, a: left, b: parseExpr(st, prec + 1) };
  }
  return left;
}

function parseUnary(st) {
  const t = pPeek(st);
  if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
    st.i++;
    return { k: 'un', op: t.v, a: parseUnary(st) };
  }
  return parsePostfix(st);
}

function parsePostfix(st) {
  let node = parsePrimary(st);
  while (pEat(st, '%')) node = { k: 'pct', a: node };
  return node;
}

function parsePrimary(st) {
  const t = pPeek(st);
  if (!t) throw new Error('#SYNTAX!');
  if (t.t === 'num') {
    st.i++;
    return { k: 'num', v: t.v };
  }
  if (t.t === 'str') {
    st.i++;
    return { k: 'str', v: t.v };
  }
  if (t.t === 'ref') {
    st.i++;
    return t.to ? { k: 'range', from: t.v, to: t.to } : { k: 'ref', v: t.v };
  }
  if (t.t === 'name') {
    st.i++;
    if (pEat(st, '(')) {
      const args = [];
      if (!pEat(st, ')')) {
        do {
          args.push(parseExpr(st, 0));
        } while (pEat(st, ','));
        if (!pEat(st, ')')) throw new Error('#SYNTAX!');
      }
      if (t.v === 'TRUE' || t.v === 'FALSE') {
        // TRUE() / FALSE()
        if (args.length) throw new Error('#VALUE!');
        return { k: 'bool', v: t.v === 'TRUE' };
      }
      return { k: 'call', name: t.v, args };
    }
    if (t.v === 'TRUE') return { k: 'bool', v: true };
    if (t.v === 'FALSE') return { k: 'bool', v: false };
    throw new Error('#NAME?');
  }
  if (t.t === 'op' && t.v === '(') {
    st.i++;
    const node = parseExpr(st, 0);
    if (!pEat(st, ')')) throw new Error('#SYNTAX!');
    return node;
  }
  throw new Error('#SYNTAX!');
}

/** 比较：两侧都能转成有限数字时按数值比，否则按文本比（不区分大小写） */
function compareValues(a, b) {
  const na = typeof a === 'number' || typeof a === 'boolean' ? Number(a) : a === '' || a == null ? 0 : Number(a);
  const nb = typeof b === 'number' || typeof b === 'boolean' ? Number(b) : b === '' || b == null ? 0 : Number(b);
  if (isFinite(na) && isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = String(a == null ? '' : a).toLowerCase();
  const sb = String(b == null ? '' : b).toLowerCase();
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function evalBinNode(node, ctx) {
  const a = evalNode(node.a, ctx);
  const b = evalNode(node.b, ctx);
  switch (node.op) {
    case '&':
      return (a == null ? '' : String(a)) + (b == null ? '' : String(b));
    case '=':
      return compareValues(a, b) === 0;
    case '<>':
      return compareValues(a, b) !== 0;
    case '<':
      return compareValues(a, b) < 0;
    case '>':
      return compareValues(a, b) > 0;
    case '<=':
      return compareValues(a, b) <= 0;
    case '>=':
      return compareValues(a, b) >= 0;
    case '+':
      return toNum(a) + toNum(b);
    case '-':
      return toNum(a) - toNum(b);
    case '*':
      return toNum(a) * toNum(b);
    case '/': {
      const d = toNum(b);
      if (!d) throw new Error('#DIV/0!');
      return toNum(a) / d;
    }
    case '^':
      return Math.pow(toNum(a), toNum(b));
    default:
      throw new Error('#UNSUPPORTED');
  }
}

function evalCallNode(node, ctx) {
  // IF / IFERROR 惰性求值：只算命中分支（与 Excel 一致，也避免把未命中分支的报错带出来）
  if (node.name === 'IF') {
    if (node.args.length < 2 || node.args.length > 3) throw new Error('#VALUE!');
    if (isTruthy(evalNode(node.args[0], ctx))) return evalNode(node.args[1], ctx);
    return node.args.length > 2 ? evalNode(node.args[2], ctx) : false;
  }
  if (node.name === 'IFERROR') {
    if (node.args.length !== 2) throw new Error('#VALUE!');
    try {
      return evalNode(node.args[0], ctx);
    } catch (e) {
      return evalNode(node.args[1], ctx);
    }
  }
  const def = FUNCS[node.name];
  if (!def) throw new Error('#NAME?');
  if (node.args.length < def.n[0] || node.args.length > def.n[1]) throw new Error('#VALUE!');
  return def.f(node.args.map((a) => evalNode(a, ctx)));
}

function evalNode(node, ctx) {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'str':
      return node.v;
    case 'bool':
      return node.v;
    case 'ref': {
      const rc = refToRC(node.v);
      if (!rc) throw new Error('#REF!');
      if (!ctx.getRef) throw new Error('#UNSUPPORTED');
      const v = ctx.getRef(node.v, rc);
      return v == null ? '' : v;
    }
    case 'range':
      return ctx.getRange ? ctx.getRange(node.from, node.to) || [] : [];
    case 'pct':
      return toNum(evalNode(node.a, ctx)) / 100;
    case 'un': {
      const v = toNum(evalNode(node.a, ctx));
      return node.op === '-' ? -v : v;
    }
    case 'bin':
      return evalBinNode(node, ctx);
    case 'call':
      return evalCallNode(node, ctx);
    default:
      throw new Error('#UNSUPPORTED');
  }
}

/** 公式文本是否在求值器支持范围内（只看能否解析，不求值） */
export function isFormulaSupported(src) {
  return parseFormulaAst(String(src == null ? '' : src).replace(/^=/, '')) !== null;
}

/**
 * 求值一个公式（前导 `=` 可省）。
 * @param {string} src 公式文本
 * @param {{ getRef?: (ref: string, rc: {r: number, c: number}) => any,
 *           getRange?: (from: string, to: string) => any[] }} ctx 取单元格值的回调
 * @returns {number|string|boolean|null} null = 不支持 / 出错（调用方回退 Excel 缓存值）
 */
export function evalFormula(src, ctx = {}) {
  const ast = parseFormulaAst(String(src == null ? '' : src).replace(/^=/, ''));
  if (!ast) return null;
  try {
    const v = evalNode(ast, ctx);
    return typeof v === 'number' && !isFinite(v) ? null : v;
  } catch (e) {
    return null;
  }
}

/* --------------------------- 合并单元格 --------------------------- */

/** 合并单元格填充模式：`fill` = 左上角的值填充整个区域（默认，导入「分类」跨行更实用） */
export const MERGE_FILL = 'fill';
/** 合并单元格保留模式：`blank` = 只保留左上角，其余格保持原样 */
export const MERGE_BLANK = 'blank';
export const MERGE_MODES = [MERGE_FILL, MERGE_BLANK];

/**
 * 工作表 XML 里的 `<mergeCells>` → 合并区域列表（0 基起止坐标）。
 * @returns {Array<{ ref: string, r1: number, c1: number, r2: number, c2: number }>}
 */
export function parseMerges(xml) {
  const out = [];
  if (!xml) return out;
  const block = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml);
  const src = block ? block[1] : '';
  const re = /<mergeCell\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(src))) {
    const ref = attr(m[0], 'ref') || '';
    const parts = ref.split(':');
    const a = refToRC(parts[0]);
    const b = refToRC(parts[1] || parts[0]);
    if (!a || !b || (a.r === b.r && a.c === b.c)) continue; // 单格「合并」无意义
    const r1 = Math.min(a.r, b.r);
    const c1 = Math.min(a.c, b.c);
    const r2 = Math.max(a.r, b.r);
    const c2 = Math.max(a.c, b.c);
    out.push({ ref: `${rcToRef(r1, c1)}:${rcToRef(r2, c2)}`, r1, c1, r2, c2 });
  }
  return out;
}

/**
 * 把合并区域应用到二维表（会自动补齐区域超出的行列）。
 * @param {string[][]} rows
 * @param {ReturnType<typeof parseMerges>} merges
 * @param {{ mode?: 'fill'|'blank' }} [opts]
 * @returns {{ rows: string[][], filled: number }} filled = 被填充的格子数
 */
export function applyMerges(rows, merges, { mode = MERGE_FILL } = {}) {
  const list = Array.isArray(merges) ? merges : [];
  const grid = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r.slice() : []));
  if (!list.length || mode !== MERGE_FILL) return { rows: grid, filled: 0 }; // blank：只保留左上角
  let filled = 0;
  for (const m of list) {
    if (!m) continue;
    while (grid.length <= m.r2) grid.push([]);
    for (let r = m.r1; r <= m.r2; r++) {
      const row = grid[r] || (grid[r] = []);
      while (row.length <= m.c2) row.push('');
    }
    const v = grid[m.r1][m.c1];
    if (v === '' || v == null) continue; // 左上角是空的 → 没有可填充的值
    for (let r = m.r1; r <= m.r2; r++) {
      for (let c = m.c1; c <= m.c2; c++) {
        if (r === m.r1 && c === m.c1) continue;
        if (grid[r][c] === '') {
          // 只填空格，不覆盖真实数据
          grid[r][c] = v;
          filled++;
        }
      }
    }
  }
  return { rows: grid, filled };
}


/** 公式 / 合并单元格统计（导入时可在预览里提示用户） */
function emptyNotices() {
  return { formulas: 0, evaluated: 0, unsupported: 0, merges: 0, mergedCells: 0 };
}

/**
 * 工作表 XML → `{ rows, merges, notices }`（含公式处理与合并单元格处理）。
 * @param {string} xml
 * @param {{ shared?: string[], dateStyles?: Set<number>, mergeMode?: 'fill'|'blank',
 *           formulaMode?: 'cached'|'evaluate' }} [opts]
 * @returns {{ rows: string[][], merges: Array<{ref:string,r1:number,c1:number,r2:number,c2:number}>,
 *             notices: { formulas: number, evaluated: number, unsupported: number,
 *                        merges: number, mergedCells: number } }}
 */
export function parseSheetDetailed(
  xml,
  { shared = [], dateStyles = new Set(), mergeMode = MERGE_FILL, formulaMode = FORMULA_MODE.cached } = {}
) {
  const notices = emptyNotices();
  if (!xml) return { rows: [], merges: [], notices };
  const grid = []; // grid[r][c] = { text, num, formula, formulaShared, cached }
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cellsXml = rm[3] || '';
    const row = [];
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(cellsXml))) {
      const attrs = cm[2] != null ? cm[2] : cm[1];
      const body = cm[3] || '';
      const t = attr(attrs, 't') || '';
      const s = attr(attrs, 's');
      const cell = { text: '', num: null, hasFormula: false, formula: null, formulaShared: false, cached: null };
      const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const raw = vm ? decodeXml(vm[1]) : '';
      if (t === 'inlineStr') {
        cell.text = allText(body);
      } else if (t === 's') {
        cell.text = shared[Number(raw)] != null ? shared[Number(raw)] : '';
      } else if (t === 'b') {
        cell.text = raw === '1' ? 'TRUE' : 'FALSE';
        cell.num = raw === '1' ? 1 : 0;
      } else if (t === 'str') {
        cell.text = raw;
      } else if (raw !== '' && s != null && dateStyles.has(Number(s))) {
        cell.text = excelSerialToDate(raw);
        cell.num = Number(raw);
      } else {
        cell.text = raw;
        cell.num = raw !== '' && isFinite(Number(raw)) ? Number(raw) : null;
      }
      const fm = /<f\b([^>]*?)\/>|<f\b([^>]*?)>([\s\S]*?)<\/f>/.exec(body);
      if (fm) {
        const fAttrs = fm[1] != null ? fm[1] : fm[2] || '';
        const src = decodeXml((fm[3] || '').trim());
        cell.hasFormula = true;
        cell.formula = src;
        // 共享公式的「从属格」只有 t="shared" + si、没有自己的表达式 → 无法单独求值
        cell.formulaShared = !src && /t="shared"/.test(fAttrs);
        cell.cached = raw;
      }
      const ci = colIndex(attr(attrs, 'r'));
      const idx = ci >= 0 ? ci : auto;
      row[idx] = cell;
      auto = idx + 1;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    grid.push(row);
  }
  // ---- 公式：按需递归求值（带循环引用检测）；失败 → 回退 Excel 缓存值 ----
  const values = new Map(); // "r,c" → 原始值（数值/文本/布尔），供其它公式引用
  const results = new Map(); // "r,c" → 求值成功的原始值（决定最终文本）
  const visiting = new Set();
  const cellAt = (r, c) => (grid[r] ? grid[r][c] || null : null);
  const shouldEval = (cell) =>
    !!cell.formula &&
    !cell.formulaShared &&
    (formulaMode === FORMULA_MODE.evaluate || cell.cached == null || cell.cached === '');

  function getRef(ref, rc) {
    if (visiting.has(rc.r + ',' + rc.c)) throw new Error('#CIRCULAR'); // 循环引用 → 求值失败
    return valueAt(rc.r, rc.c);
  }

  function getRange(from, to) {
    const a = refToRC(from);
    const b = refToRC(to);
    if (!a || !b) throw new Error('#REF!');
    const out = [];
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push(valueAt(r, c));
    }
    return out;
  }

  function valueAt(r, c) {
    const cell = cellAt(r, c);
    if (!cell) return '';
    const key = r + ',' + c;
    if (values.has(key)) return values.get(key);
    if (shouldEval(cell)) {
      visiting.add(key);
      let v = null;
      try {
        v = evalFormula(cell.formula, { getRef, getRange });
      } catch (e) {
        v = null;
      } finally {
        visiting.delete(key);
      }
      if (v !== null && v !== undefined) {
        results.set(key, v);
        values.set(key, v);
        return v;
      }
      notices.unsupported++;
    }
    const v = cell.num != null ? cell.num : cell.text;
    values.set(key, v);
    return v;
  }

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const cell = grid[r][c];
      if (!cell || !cell.hasFormula) continue;
      notices.formulas++;
      if (shouldEval(cell)) valueAt(r, c); // 触发求值（顺序无关，依赖会递归按需算）
    }
  }
  notices.evaluated = results.size;

  const rows = grid.map((row, r) =>
    row.map((cell, c) => {
      if (!cell) return '';
      const key = r + ',' + c;
      return results.has(key) ? formatFormulaValue(results.get(key)) : cell.text;
    })
  );

  const merges = parseMerges(xml);
  const applied = applyMerges(rows, merges, { mode: mergeMode });
  notices.merges = merges.length;
  notices.mergedCells = applied.filled;
  return { rows: applied.rows, merges, notices };
}





/* --------------------------- 多工作表（v0.5.7） --------------------------- */

/** ZIP 条目名排序用的 sheet 序号（sheet12.xml > sheet2.xml） */
function sheetSeq(path) {
  const m = /sheet(\d+)\.xml$/i.exec(String(path || ''));
  return m ? Number(m[1]) : 0;
}

/** rels 里的相对 Target → 工作簿内路径（`worksheets/sheet1.xml` → `xl/worksheets/sheet1.xml`） */
function relPath(target) {
  const t = String(target || '');
  if (!t) return '';
  if (t.startsWith('/')) return t.slice(1);
  return 'xl/' + t.replace(/^\.\//, '');
}

/**
 * ZIP 条目 → 工作表清单（顺序 / 名称 / 路径 / 是否隐藏）。
 * 优先读 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels`；缺失时回退 `xl/worksheets/sheetN.xml` 排序。
 * @param {Map<string, Uint8Array>} files
 * @returns {Array<{ index: number, name: string, path: string, hidden: boolean }>}
 */
export function workbookSheets(files) {
  const names = files && files.keys ? [...files.keys()] : [];
  const fallback = names
    .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
    .sort((a, b) => sheetSeq(a) - sheetSeq(b) || a.localeCompare(b));
  const byFallback = () => fallback.map((p, i) => ({ index: i, name: `Sheet${i + 1}`, path: p, hidden: false }));
  const dec = new TextDecoder('utf-8');
  const wb = files && files.get ? files.get('xl/workbook.xml') : null;
  if (!wb) return byFallback();
  const relMap = new Map();
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (rels) {
    for (const tag of dec.decode(rels).match(/<Relationship\b[^>]*\/?>/g) || []) {
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      if (id && target) relMap.set(id, relPath(target));
    }
  }
  const block = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/.exec(dec.decode(wb));
  const tags = block ? block[1].match(/<sheet\b[^>]*\/?>/g) || [] : [];
  const out = [];
  tags.forEach((tag, i) => {
    const rid = attr(tag, 'r:id');
    const state = attr(tag, 'state') || '';
    let path = rid && relMap.get(rid) ? relMap.get(rid) : '';
    if (!path || !files.has(path)) path = fallback[i] || '';
    if (!path) return; // 定位不到对应 XML → 跳过这张表
    out.push({
      index: out.length,
      name: attr(tag, 'name') || `Sheet${i + 1}`,
      path,
      hidden: state === 'hidden' || state === 'veryHidden'
    });
  });
  return out.length ? out : byFallback();
}

/** 第一个工作表的 ZIP 条目名（兼容旧调用；没有任何工作表时返回 null） */
export function firstSheetPath(files) {
  const sheets = workbookSheets(files);
  return sheets.length ? sheets[0].path : null;
}

/**
 * 打开 .xlsx：解压一次，之后可按需（同步）读取任一张工作表。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{ inflate?: Function, mergeMode?: 'fill'|'blank', formulaMode?: 'cached'|'evaluate' }} [opts]
 * @returns {Promise<{ files: Map<string, Uint8Array>,
 *   sheets: Array<{ index: number, name: string, path: string, hidden: boolean }>,
 *   read: (which?: number|string) => { rows: string[][], merges: Array, notices: object },
 *   readAll: () => Array<object> }>}
 */
export async function openXlsx(bytes, { mergeMode = MERGE_FILL, formulaMode = FORMULA_MODE.cached, ...zipOpts } = {}) {
  const files = await unzip(bytes, zipOpts);
  const dec = new TextDecoder('utf-8');
  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(dec.decode(files.get('xl/sharedStrings.xml'))) : [];
  const dateStyles = files.has('xl/styles.xml') ? parseDateStyleIndexes(dec.decode(files.get('xl/styles.xml'))) : new Set();
  const sheets = workbookSheets(files);
  if (!sheets.length) throw new Error('这个 .xlsx 里没有找到工作表');
  const cache = new Map();
  const read = (which = 0) => {
    const sheet = typeof which === 'number' ? sheets[which] : sheets.find((s) => s.name === String(which));
    if (!sheet) throw new Error(`没有找到工作表「${which}」`);
    if (!cache.has(sheet.index)) {
      cache.set(sheet.index, parseSheetDetailed(dec.decode(files.get(sheet.path)), { shared, dateStyles, mergeMode, formulaMode }));
    }
    return cache.get(sheet.index);
  };
  const readAll = () => sheets.map((s) => ({ ...s, ...read(s.index) }));
  return { files, sheets, read, readAll };
}

/**
 * .xlsx 字节 → 二维字符串表（默认第一张工作表，可用 `opts.sheet` 指定序号或名称）。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{ sheet?: number|string, mergeMode?: 'fill'|'blank', formulaMode?: 'cached'|'evaluate' }} [opts]
 * @returns {Promise<string[][]>}
 */
export async function parseXlsxRows(bytes, opts = {}) {
  const wb = await openXlsx(bytes, opts);
  return wb.read(opts.sheet == null ? 0 : opts.sheet).rows;
}

/**
 * 只列出工作表清单（不解析内容）。
 * @returns {Promise<Array<{ index: number, name: string, path: string, hidden: boolean }>>}
 */
export async function listXlsxSheets(bytes, opts = {}) {
  const wb = await openXlsx(bytes, opts);
  return wb.sheets.map(({ index, name, path, hidden }) => ({ index, name, path, hidden }));
}

/**
 * 解析全部工作表（含 rows / merges / notices）。
 * @returns {Promise<Array<{ index: number, name: string, path: string, hidden: boolean,
 *   rows: string[][], merges: Array, notices: object }>>}
 */
export async function parseXlsxSheets(bytes, opts = {}) {
  const wb = await openXlsx(bytes, opts);
  return wb.readAll();
}
