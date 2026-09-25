import {
  MAX_RESULTS,
  analyze,
  evaluateShape,
  measureShape,
  pitchClass,
  rankShape,
  validateQuery,
  type ChordQuery,
  type ExclusionCode,
  type FretChoice,
  type SearchReport,
  type Shape,
} from './search';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

const TUNING_PRESETS: Array<[string, number[]]> = [
  ['吉他标准', [40, 45, 50, 55, 59, 64]],
  ['吉他 Drop D', [38, 45, 50, 55, 59, 64]],
  ['贝斯标准', [28, 33, 38, 43]],
  ['尤克里里', [60, 64, 67, 69]],
];

const CHORD_QUALITIES: Array<[string, number[]]> = [
  ['大三和弦', [0, 4, 7]],
  ['小三和弦', [0, 3, 7]],
  ['属七和弦', [0, 4, 7, 10]],
  ['大七和弦', [0, 4, 7, 11]],
  ['小七和弦', [0, 3, 7, 10]],
  ['减三和弦', [0, 3, 6]],
  ['强力和弦', [0, 7]],
];

const CODE_LABELS: Record<ExclusionCode, string> = {
  'too-few-sounded': '弹响弦不足 3 根',
  'foreign-pitch-class': '出现目标集合之外的音级',
  'missing-target': '未覆盖全部目标音级',
  'too-many-fingers': '按弦手指超过 4 根（不计横按）',
  'span-too-wide': '非零品位跨度超过 4 品',
};

// ---------- 页面状态 ----------

const state = {
  openMidis: [40, 45, 50, 55, 59, 64],
  targets: new Set<number>([0, 4, 7]),
  maxFret: 5,
  report: null as SearchReport | null,
  query: null as ChordQuery | null,
  selected: null as Shape | null,
};

// ---------- DOM 工具 ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function mustGet<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as unknown as T;
}

function midiName(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;
}

function shapeLabel(shape: Shape): string {
  return shape.frets.map((f) => (f === null ? '×' : String(f))).join(' ');
}

// ---------- 参数区 ----------

function renderTuningPresets(): void {
  const box = mustGet('tuning-presets');
  box.textContent = '';
  for (const [name, midis] of TUNING_PRESETS) {
    const btn = el('button', {}, name);
    btn.addEventListener('click', () => {
      state.openMidis = [...midis];
      mustGet<HTMLSelectElement>('string-count').value = String(midis.length);
      renderStringInputs();
    });
    box.appendChild(btn);
  }
}

function renderStringInputs(): void {
  const count = Number(mustGet<HTMLSelectElement>('string-count').value);
  // 调整开放弦数组长度：截断或在末弦上方每次叠纯四度
  while (state.openMidis.length > count) state.openMidis.pop();
  while (state.openMidis.length < count) {
    state.openMidis.push(state.openMidis[state.openMidis.length - 1] + 5);
  }
  const box = mustGet('string-inputs');
  box.textContent = '';
  state.openMidis.forEach((midi, i) => {
    const label = el('label', { class: 'field' }, `${CIRCLED[i]} ${i === 0 ? '（最低）' : ''}`);
    const input = el('input', { type: 'number', min: '0', max: '127', value: String(midi) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      state.openMidis[i] = Number(input.value);
    });
    label.appendChild(input);
    box.appendChild(label);
  });
  renderDiagSelects();
}

function renderPcGrid(): void {
  const grid = mustGet('pc-grid');
  grid.textContent = '';
  NOTE_NAMES.forEach((name, pc) => {
    const btn = el('button', { class: 'toggle' + (state.targets.has(pc) ? ' on' : '') }, name);
    btn.addEventListener('click', () => {
      if (state.targets.has(pc)) state.targets.delete(pc);
      else state.targets.add(pc);
      btn.classList.toggle('on');
    });
    grid.appendChild(btn);
  });
}

function setTargetsFromChord(root: number, intervals: number[]): void {
  state.targets = new Set(intervals.map((i) => (root + i) % 12));
  renderPcGrid();
}

function renderChordPresets(): void {
  const rootSel = mustGet<HTMLSelectElement>('chord-root');
  NOTE_NAMES.forEach((name, pc) => rootSel.appendChild(el('option', { value: String(pc) }, name)));
  const qualitySel = mustGet<HTMLSelectElement>('chord-quality');
  CHORD_QUALITIES.forEach(([name], i) => qualitySel.appendChild(el('option', { value: String(i) }, name)));
  const apply = (): void => {
    const root = Number(rootSel.value);
    const [, intervals] = CHORD_QUALITIES[Number(qualitySel.value)];
    setTargetsFromChord(root, intervals);
  };
  rootSel.addEventListener('change', apply);
  qualitySel.addEventListener('change', apply);
}

function readQuery(): ChordQuery {
  return {
    openMidis: [...state.openMidis],
    targets: [...state.targets].sort((a, b) => a - b),
    maxFret: state.maxFret,
  };
}

// ---------- 搜索与结果 ----------

function runSearch(): void {
  const errorBox = mustGet('error');
  errorBox.textContent = '';
  state.maxFret = Number(mustGet<HTMLInputElement>('max-fret').value);
  const query = readQuery();
  const errors = validateQuery(query);
  if (errors.length > 0) {
    errorBox.textContent = errors.join('\n');
    return;
  }
  const status = mustGet('status');
  status.textContent = '搜索中…';
  // 让状态先渲染，再执行可能耗时的全枚举
  setTimeout(() => {
    state.query = query;
    state.report = analyze(query);
    state.selected = state.report.shapes[0] ?? null;
    status.textContent = '';
    renderStats();
    renderResults();
    renderPreview();
    renderDiagSelects();
  }, 20);
}

function renderStats(): void {
  const stats = mustGet('stats');
  const report = state.report;
  if (!report) return;
  const ex = report.exclusions;
  stats.innerHTML = '';
  stats.append(
    `共枚举 ${report.totalCandidates.toLocaleString()} 种按法，合法 `,
    el('b', {}, String(report.totalValid)),
    ` 个，显示前 ${Math.min(MAX_RESULTS, report.totalValid)} 个。\n排除统计（一种按法可能违反多条）：`,
  );
  stats.appendChild(el('br'));
  stats.append(
    `弹响弦不足 ${ex['too-few-sounded']} · 目标外音级 ${ex['foreign-pitch-class']} · ` +
      `未覆盖目标 ${ex['missing-target']} · 手指超限 ${ex['too-many-fingers']} · 跨度过大 ${ex['span-too-wide']}`,
  );
}

function renderResults(): void {
  const list = mustGet('result-list');
  list.textContent = '';
  const report = state.report;
  if (!report) return;
  if (report.shapes.length === 0) {
    const item = el('li');
    item.appendChild(el('span', { class: 'meta' }, '没有满足条件的按法，请放宽参数。'));
    list.appendChild(item);
    return;
  }
  report.shapes.forEach((shape, i) => {
    const item = el('li');
    const btn = el('button');
    if (state.selected === shape) btn.classList.add('selected');
    btn.appendChild(el('span', {}, `${i + 1}. ${shapeLabel(shape)}`));
    btn.appendChild(
      el('span', { class: 'meta' }, `跨度 ${shape.span} · 和 ${shape.fretSum} · 指 ${shape.fingers}`),
    );
    btn.addEventListener('click', () => {
      state.selected = shape;
      renderResults();
      renderPreview();
      syncDiagToShape(shape);
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

// ---------- 指板预览 ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node as SVGElement;
}

function renderPreview(): void {
  const svg = mustGet<SVGSVGElement>('fretboard');
  const info = mustGet('preview-info');
  svg.textContent = '';
  const shape = state.selected;
  const query = state.query;
  if (!shape || !query) {
    info.textContent = '点击任一结果在此预览。弦序自低音弦（①）到高音弦，× 为闷音，○ 为开放弦。';
    return;
  }
  const n = shape.frets.length;
  const maxFret = Math.max(query.maxFret, 1);
  const fretW = 62;
  const spacing = 36;
  const marginL = 96;
  const marginR = 16;
  const marginT = 26;
  const marginB = 34;
  const width = marginL + maxFret * fretW + marginR;
  const height = marginT + (n - 1) * spacing + marginB;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const yOf = (i: number): number => marginT + (n - 1 - i) * spacing; // 低音弦在下方
  const xOfFret = (f: number): number => marginL + (f - 0.5) * fretW; // 品 f 的中心

  // 弦
  for (let i = 0; i < n; i++) {
    svg.appendChild(svgEl('line', {
      x1: marginL, y1: yOf(i), x2: marginL + maxFret * fretW, y2: yOf(i),
      stroke: '#8a93a3', 'stroke-width': 1 + (n - 1 - i) * 0.35,
    }));
    svg.appendChild(svgEl('text', {
      x: 8, y: yOf(i) + 4, fill: '#9aa3b2', 'font-size': 12,
    })).textContent = `${CIRCLED[i]} ${midiName(query.openMidis[i])}`;
  }
  // 琴枕与品丝
  svg.appendChild(svgEl('rect', {
    x: marginL - 5, y: marginT - 8, width: 5, height: (n - 1) * spacing + 16, fill: '#d8dde6',
  }));
  for (let f = 1; f <= maxFret; f++) {
    svg.appendChild(svgEl('line', {
      x1: marginL + f * fretW, y1: marginT - 8, x2: marginL + f * fretW, y2: marginT + (n - 1) * spacing + 8,
      stroke: '#4a5261', 'stroke-width': 2,
    }));
    svg.appendChild(svgEl('text', {
      x: xOfFret(f), y: height - 12, fill: '#9aa3b2', 'font-size': 12, 'text-anchor': 'middle',
    })).textContent = String(f);
  }
  // 各弦按法标记
  shape.frets.forEach((fret, i) => {
    const y = yOf(i);
    if (fret === null) {
      svg.appendChild(svgEl('text', {
        x: marginL - 34, y: y + 5, fill: '#ff7c7c', 'font-size': 16, 'text-anchor': 'middle',
      })).textContent = '×';
    } else if (fret === 0) {
      svg.appendChild(svgEl('circle', {
        cx: marginL - 34, cy: y, r: 7, fill: 'none', stroke: '#8fd694', 'stroke-width': 2,
      }));
    } else {
      const pc = pitchClass(query.openMidis[i] + fret);
      svg.appendChild(svgEl('circle', { cx: xOfFret(fret), cy: y, r: 14, fill: '#f0b45a' }));
      const label = svgEl('text', {
        x: xOfFret(fret), y: y + 4, fill: '#20180a', 'font-size': 12, 'font-weight': 700, 'text-anchor': 'middle',
      });
      label.textContent = NOTE_NAMES[pc];
      svg.appendChild(label);
    }
  });

  const pcs = shape.frets.flatMap((f, i) => (f === null ? [] : [pitchClass(query.openMidis[i] + f)]));
  const pcNames = [...new Set(pcs)].sort((a, b) => a - b).map((pc) => NOTE_NAMES[pc]).join(' ');
  info.textContent =
    `按法（低→高）：${shapeLabel(shape)} ｜ 跨度 ${shape.span} ｜ 品位和 ${shape.fretSum} ｜ ` +
    `手指 ${shape.fingers} ｜ 弹响 ${shape.sounded} 弦 ｜ 音级：${pcNames}`;
}

// ---------- 排除原因诊断 ----------

function renderDiagSelects(): void {
  const box = mustGet('diag-selects');
  box.textContent = '';
  const count = state.openMidis.length;
  for (let i = 0; i < count; i++) {
    const label = el('label', { class: 'field' }, CIRCLED[i]);
    const sel = el('select') as HTMLSelectElement;
    sel.appendChild(el('option', { value: 'x' }, '闷音 ×'));
    for (let f = 0; f <= state.maxFret; f++) {
      sel.appendChild(el('option', { value: String(f) }, `${f} 品`));
    }
    label.appendChild(sel);
    box.appendChild(label);
  }
}

function diagFrets(): FretChoice[] {
  const box = mustGet('diag-selects');
  return [...box.querySelectorAll('select')].map((sel) =>
    sel.value === 'x' ? null : Number(sel.value),
  );
}

function syncDiagToShape(shape: Shape): void {
  const selects = [...mustGet('diag-selects').querySelectorAll('select')];
  shape.frets.forEach((f, i) => {
    if (selects[i]) selects[i].value = f === null ? 'x' : String(f);
  });
}

function runDiagnose(): void {
  const out = mustGet('diag-output');
  out.textContent = '';
  const query = readQuery();
  const errors = validateQuery(query);
  if (errors.length > 0) {
    out.appendChild(el('p', { class: 'error' }, errors.join('\n')));
    return;
  }
  const frets = diagFrets();
  const ev = evaluateShape(frets, query);
  if (ev.ok) {
    const rank = rankShape(frets, query);
    const p = el('p', { class: 'ok-text' });
    p.textContent = rank
      ? `✓ 合法按法：在全部 ${rank.total} 个合法形状中排第 ${rank} 位` +
        (rank.rank > MAX_RESULTS ? `，未进入前 ${MAX_RESULTS} 故未列出。` : '，已列于搜索结果中。')
      : '✓ 合法按法。';
    out.appendChild(p);
    return;
  }
  const m = measureShape(frets);
  const targetSet = new Set(query.targets);
  const list = el('ul', { class: 'reasons' });
  const add = (text: string): void => {
    list.appendChild(el('li', { class: 'bad' }, text));
  };
  for (const code of ev.codes) {
    switch (code) {
      case 'too-few-sounded':
        add(`弹响弦仅 ${m.sounded} 根，少于要求的 3 根`);
        break;
      case 'foreign-pitch-class': {
        const bad = frets.flatMap((f, i) => {
          if (f === null) return [];
          const pc = pitchClass(query.openMidis[i] + f);
          return targetSet.has(pc) ? [] : [`${CIRCLED[i]}弦 ${NOTE_NAMES[pc]}`];
        });
        add(`出现目标外音级：${bad.join('、')}`);
        break;
      }
      case 'missing-target': {
        const seen = new Set(
          frets.flatMap((f, i) => (f === null ? [] : [pitchClass(query.openMidis[i] + f)])),
        );
        const missing = [...targetSet].filter((t) => !seen.has(t)).map((t) => NOTE_NAMES[t]);
        add(`缺少目标音级：${missing.join('、')}`);
        break;
      }
      case 'too-many-fingers':
        add(`按下 ${m.fingers} 根弦，超过 4 根手指（不计横按）`);
        break;
      case 'span-too-wide':
        add(`非零品位跨度为 ${m.span} 品，超过 4 品`);
        break;
    }
  }
  out.appendChild(list);
}

// ---------- 启动 ----------

function init(): void {
  renderTuningPresets();
  renderStringInputs();
  renderPcGrid();
  renderChordPresets();
  mustGet('string-count').addEventListener('change', renderStringInputs);
  mustGet<HTMLInputElement>('max-fret').addEventListener('input', (e) => {
    state.maxFret = Number((e.target as HTMLInputElement).value);
    renderDiagSelects();
  });
  mustGet('search').addEventListener('click', runSearch);
  mustGet('diagnose-btn').addEventListener('click', runDiagnose);
  runSearch();
}

init();
