import zlib from 'node:zlib';

// Чтение и запись .xlsx без сторонних библиотек: zip-контейнер (zlib из Node.js)
// и минимальный разбор/сборка XML листа. Нужен для загрузки сводки ЦОУ и выгрузки
// отчёта в её формате.

const MAX_ENTRY = 100 * 1024 * 1024;

// ---------------------------------------------------------------- zip: чтение

function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Файл не похож на .xlsx (не zip-архив)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждённый .xlsx: оглавление архива');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, () => {
      if (usize > MAX_ENTRY) throw new Error('Слишком большой лист в .xlsx');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
      throw new Error('Неподдерживаемое сжатие в .xlsx');
    });
  }
  return out;
}

// ---------------------------------------------------------------- XML

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Управляющие символы недопустимы в XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].replace(/^\w+:(?=id$)/, 'r:')] = decode(m[2]);
  return out;
}

/** Без префиксов пространств имён: <x:row> → <row>. */
function noPrefix(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z]\w*:(?=[A-Za-z])/g, '<$1');
}

function texts(xml: string): string {
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  let s = '';
  while ((m = re.exec(xml))) s += decode(m[1]);
  return s;
}

export function colIndex(ref: string): number {
  const m = /^[A-Z]+/.exec(ref);
  let n = 0;
  for (const ch of m ? m[0] : 'A') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface Sheet {
  name: string;
  /** Строки по номеру (с 1): значения ячеек по индексу столбца (с 0), всё строками. */
  rows: Map<number, string[]>;
}

/** Читает все листы книги. Даты остаются числами Excel — их переводит вызывающий. */
export function readXlsx(buf: Buffer): Sheet[] {
  const zip = unzip(buf);
  const get = (name: string) => {
    const f = zip.get(name);
    return f ? f().toString('utf8') : '';
  };
  const wb = noPrefix(get('xl/workbook.xml'));
  if (!wb) throw new Error('В архиве нет книги Excel (xl/workbook.xml)');
  const rels = new Map<string, string>();
  for (const m of noPrefix(get('xl/_rels/workbook.xml.rels')).match(/<Relationship\b[^>]*>/g) || []) {
    const a = attrs(m);
    rels.set(a.Id, a.Target);
  }
  const shared: string[] = [];
  const ss = noPrefix(get('xl/sharedStrings.xml')).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of ss.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []) shared.push(texts(m));

  const sheets: Sheet[] = [];
  for (const m of wb.match(/<sheet\b[^>]*>/g) || []) {
    const a = attrs(m);
    let target = rels.get(a['r:id']) || '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    const xml = noPrefix(get(target));
    const rows = new Map<number, string[]>();
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm: RegExpExecArray | null;
    let auto = 0;
    while ((rm = rowRe.exec(xml))) {
      const ra = attrs(rm[1]);
      const r = ra.r ? parseInt(ra.r, 10) : auto + 1;
      auto = r;
      if (!rm[2]) continue;
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      let col = -1;
      while ((cm = cellRe.exec(rm[2]))) {
        const ca = attrs(cm[1]);
        col = ca.r ? colIndex(ca.r) : col + 1;
        const inner = cm[2] || '';
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val = '';
        if (ca.t === 's') val = vm ? shared[parseInt(vm[1], 10)] || '' : '';
        else if (ca.t === 'inlineStr') val = texts(inner);
        else if (ca.t === 'b') val = vm && vm[1] === '1' ? 'ИСТИНА' : 'ЛОЖЬ';
        else val = vm ? decode(vm[1]) : '';
        cells[col] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      rows.set(r, cells);
    }
    sheets.push({ name: a.name || 'Лист', rows });
  }
  return sheets;
}

/** Число Excel (дни с 30.12.1899) → 'YYYY-MM-DD HH:MM:SS' без часового пояса (настенное время). */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400) * 1000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD HH:MM:SS' → число Excel. */
export function toExcelDate(wall: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall);
  if (!m) return 0;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  return ms / 86400000 + 25569;
}

// ---------------------------------------------------------------- запись

export type Style = 'title' | 'note' | 'head' | 'num' | 'text' | 'date' | 'dur' | 'open' | 'center';

const STYLE_INDEX: Record<Style, number> = { title: 1, note: 2, head: 3, text: 4, date: 5, dur: 6, num: 7, open: 8, center: 9 };

export interface Cell {
  v: string | number | null;
  s?: Style;
}

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  /** Объединения, например 'B2:C2'. */
  merges?: string[];
  /** Ширина столбцов в символах. */
  widths?: number[];
  /** Закрепить строки сверху. */
  freezeRows?: number;
  /** Автофильтр, например 'A4:S120'. */
  autoFilter?: string;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yy\\ hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm:ss"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="13"/><name val="Arial"/><family val="2"/></font>
<font><sz val="9"/><color rgb="FF707478"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFC00000"/><name val="Arial"/><family val="2"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE3D2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB8BABD"/></left><right style="thin"><color rgb="FFB8BABD"/></right><top style="thin"><color rgb="FFB8BABD"/></top><bottom style="thin"><color rgb="FFB8BABD"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sp: SheetSpec): string {
  const cols = (sp.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const rows = sp.rows
    .map((row, ri) => {
      const cells = row
        .map((c, ci) => {
          if (!c || c.v === null || c.v === undefined || c.v === '') {
            return c && c.s ? `<c r="${colName(ci)}${ri + 1}" s="${STYLE_INDEX[c.s]}"/>` : '';
          }
          const ref = `${colName(ci)}${ri + 1}`;
          const s = c.s ? ` s="${STYLE_INDEX[c.s]}"` : '';
          if (typeof c.v === 'number') return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(c.v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const freeze = sp.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sp.freezeRows}" topLeftCell="A${sp.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const merges = sp.merges && sp.merges.length ? `<mergeCells count="${sp.merges.length}">${sp.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const filter = sp.autoFilter ? `<autoFilter ref="${sp.autoFilter}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${freeze}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData>${filter}${merges}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" paperSize="9" fitToHeight="0"/></worksheet>`;
}

// CRC-32 для zip.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw, { level: 6 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function definedNames(sheets: SheetSpec[]): string {
  const names = sheets
    .map((s, i) =>
      s.autoFilter
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.slice(0, 31))}'!${s.autoFilter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>`
        : '',
    )
    .join('');
  return names ? `<definedNames>${names}</definedNames>` : '';
}

/** Собирает книгу .xlsx из листов. */
export function writeXlsx(sheets: SheetSpec[]): Buffer {
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>${definedNames(sheets)}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES_XML],
  ];
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
  return zip(files);
}
