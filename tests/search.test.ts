import { describe, expect, it } from 'vitest';
import {
  MAX_RESULTS,
  allValidShapes,
  analyze,
  compareShapes,
  evaluateShape,
  measureShape,
  pitchClass,
  rankShape,
  validateQuery,
  type ChordQuery,
  type FretChoice,
  type Shape,
} from '../src/search';

// ---------- 测试内独立实现的参考版本（对拍用，刻意与 src 实现写法不同） ----------

/** 参考谓词：逐条规则直白转译 */
function referenceOk(frets: FretChoice[], query: ChordQuery): boolean {
  const targetSet = new Set(query.targets);
  const soundedPcs: number[] = [];
  const pressed: number[] = [];
  frets.forEach((f, i) => {
    if (f === null) return;
    soundedPcs.push(pitchClass(query.openMidis[i] + f));
    if (f > 0) pressed.push(f);
  });
  if (soundedPcs.length < 3) return false; // 弹响弦不少于 3 根
  if (soundedPcs.some((pc) => !targetSet.has(pc))) return false; // 只能出现目标音级
  if ([...targetSet].some((t) => !soundedPcs.includes(t))) return false; // 覆盖全部目标
  if (pressed.length > 4) return false; // 最多 4 根手指
  if (pressed.length > 0 && Math.max(...pressed) - Math.min(...pressed) > 4) return false; // 跨度 ≤ 4
  return true;
}

/** 参考度量 */
function referenceMeasure(frets: FretChoice[]): Omit<Shape, 'frets'> {
  const sounded = frets.filter((f) => f !== null).length;
  const pressed = frets.filter((f): f is number => f !== null && f > 0);
  const fretSum = frets.reduce<number>((sum, f) => sum + (f ?? 0), 0);
  const span = pressed.length === 0 ? 0 : Math.max(...pressed) - Math.min(...pressed);
  return { sounded, fingers: pressed.length, span, fretSum };
}

/** 参考排序键：跨度、品位和、向量（闷音用大数表示排在后面） */
function referenceKey(shape: Shape): number[] {
  return [
    shape.span,
    shape.fretSum,
    ...shape.frets.map((f) => (f === null ? Number.MAX_SAFE_INTEGER : f)),
  ];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 参考全枚举：递归生成全部组合，过滤、度量、排序 */
function referenceSearch(query: ChordQuery): Shape[] {
  const n = query.openMidis.length;
  const choices: FretChoice[] = [null];
  for (let f = 0; f <= query.maxFret; f++) choices.push(f);
  const results: Shape[] = [];
  const combo: FretChoice[] = new Array(n).fill(null);
  const walk = (i: number): void => {
    if (i === n) {
      if (referenceOk(combo, query)) {
        results.push({ frets: [...combo], ...referenceMeasure(combo) });
      }
      return;
    }
    for (const c of choices) {
      combo[i] = c;
      walk(i + 1);
    }
  };
  walk(0);
  results.sort((a, b) => compareKeys(referenceKey(a), referenceKey(b)));
  return results;
}

// ---------- 三弦小样本全枚举对拍 ----------

describe('三弦小样本全枚举对拍', () => {
  const cases: Array<[string, ChordQuery]> = [
    ['C 大三和弦 / E-A-D 三弦 / 3 品', { openMidis: [40, 45, 50], targets: [0, 4, 7], maxFret: 3 }],
    ['A 小三和弦 / E-A-D 三弦 / 5 品', { openMidis: [40, 45, 50], targets: [9, 0, 4], maxFret: 5 }],
    ['双音级 / F#-B-E 三弦 / 4 品', { openMidis: [42, 47, 52], targets: [6, 11], maxFret: 4 }],
    ['四音级 / 四弦贝斯 / 4 品', { openMidis: [28, 33, 38, 43], targets: [2, 5, 7, 11], maxFret: 4 }],
  ];

  it.each(cases)('%s：前 20 个结果与参考实现逐一相同', (_name, query) => {
    const expected = referenceSearch(query);
    const report = analyze(query);
    expect(report.shapes).toEqual(expected.slice(0, MAX_RESULTS));
    expect(report.totalValid).toBe(expected.length);
    expect(report.totalCandidates).toBe(Math.pow(query.maxFret + 2, query.openMidis.length));
  });

  it('排除统计与参考实现一致', () => {
    const query: ChordQuery = { openMidis: [40, 45, 50], targets: [0, 4, 7], maxFret: 3 };
    const report = analyze(query);
    // 用参考谓词逐候选统计违反的规则数
    const choices: FretChoice[] = [null, 0, 1, 2, 3];
    const counts = { sounded: 0, foreign: 0, missing: 0, fingers: 0, span: 0 };
    for (const a of choices) for (const b of choices) for (const c of choices) {
      const frets = [a, b, c];
      const pcs = frets.flatMap((f, i) => (f === null ? [] : [pitchClass(query.openMidis[i] + f)]));
      const pressed = frets.filter((f): f is number => f !== null && f > 0);
      if (pcs.length < 3) counts.sounded++;
      if (pcs.some((pc) => !query.targets.includes(pc))) counts.foreign++;
      if (query.targets.some((t) => !pcs.includes(t))) counts.missing++;
      if (pressed.length > 4) counts.fingers++;
      if (pressed.length > 0 && Math.max(...pressed) - Math.min(...pressed) > 4) counts.span++;
    }
    expect(report.exclusions['too-few-sounded']).toBe(counts.sounded);
    expect(report.exclusions['foreign-pitch-class']).toBe(counts.foreign);
    expect(report.exclusions['missing-target']).toBe(counts.missing);
    expect(report.exclusions['too-many-fingers']).toBe(counts.fingers);
    expect(report.exclusions['span-too-wide']).toBe(counts.span);
  });

  it('开放弦即覆盖目标时，全开放形状排在首位（跨度 0、品位和 0）', () => {
    // E-A-D 开放弦音级为 4、9、2
    const query: ChordQuery = { openMidis: [40, 45, 50], targets: [2, 4, 9], maxFret: 5 };
    const first = analyze(query).shapes[0];
    expect(first.frets).toEqual([0, 0, 0]);
    expect(first.span).toBe(0);
    expect(first.fretSum).toBe(0);
  });
});

// ---------- 移调不变性 ----------

describe('移调不变性', () => {
  const base: ChordQuery = { openMidis: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 4 };
  const baseShapes = allValidShapes(base);

  it('开放弦与目标音级同步平移 k 个半音后，合法形状完全一致', () => {
    for (let k = 1; k < 12; k++) {
      const shifted: ChordQuery = {
        openMidis: base.openMidis.map((m) => m + k),
        targets: base.targets.map((t) => (t + k) % 12),
        maxFret: base.maxFret,
      };
      expect(allValidShapes(shifted)).toEqual(baseShapes);
    }
  });

  it('仅平移开放弦（目标不动）会改变结果，反证测试有效', () => {
    const shifted: ChordQuery = {
      openMidis: base.openMidis.map((m) => m + 1),
      targets: base.targets,
      maxFret: base.maxFret,
    };
    expect(allValidShapes(shifted)).not.toEqual(baseShapes);
  });
});

// ---------- 单条规则与度量 ----------

describe('evaluateShape 规则判定', () => {
  const query: ChordQuery = { openMidis: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9 };

  it('标准 C 大三和弦按法合法', () => {
    const ev = evaluateShape([null, 3, 2, 0, 1, 0], query);
    expect(ev.ok).toBe(true);
    expect(ev.codes).toEqual([]);
  });

  it('弹响弦不足 3 根', () => {
    const ev = evaluateShape([null, null, null, 0, null, 0], query);
    expect(ev.ok).toBe(false);
    expect(ev.codes).toContain('too-few-sounded');
  });

  it('出现目标外音级', () => {
    // 第 1 弦 1 品 = F(5)，不在 {0,4,7}
    const ev = evaluateShape([1, 3, 2, 0, 1, 0], query);
    expect(ev.codes).toContain('foreign-pitch-class');
  });

  it('未覆盖全部目标音级', () => {
    // 只出现 E(4) 与 G(7)，缺 C(0)
    const ev = evaluateShape([null, null, 2, 0, null, 0], query);
    expect(ev.codes).toContain('missing-target');
    expect(ev.codes).not.toContain('foreign-pitch-class');
  });

  it('按弦手指超过 4 根', () => {
    const ev = evaluateShape([3, 3, 2, 2, 1, 1], query);
    expect(ev.codes).toContain('too-many-fingers');
  });

  it('非零品位跨度超过 4', () => {
    // 1 品与 6 品同时按下，跨度 5
    const ev = evaluateShape([null, null, 1, 0, 6, 0], query);
    expect(ev.codes).toContain('span-too-wide');
  });

  it('闷音不计入手指与跨度', () => {
    const m = measureShape([null, 3, null, 0, 1, null]);
    expect(m).toEqual({ sounded: 3, fingers: 2, span: 2, fretSum: 4 });
  });

  it('没有按弦时跨度算零', () => {
    expect(measureShape([0, 0, 0]).span).toBe(0);
    expect(measureShape([null, null, null]).span).toBe(0);
  });
});

describe('compareShapes 排序', () => {
  const shape = (frets: FretChoice[]): Shape => ({ frets, ...measureShape(frets) });

  it('先比跨度，再比品位总和', () => {
    expect(compareShapes(shape([0, 0, 0]), shape([1, 4, 1]))).toBeLessThan(0); // 跨度 0 < 3
    expect(compareShapes(shape([2, 0, 0]), shape([1, 1, 1]))).toBeLessThan(0); // 同跨度 0，和 2 < 3
    expect(compareShapes(shape([1, 1, 1]), shape([2, 0, 0]))).toBeGreaterThan(0); // 同跨度 0，和 3 > 2
  });

  it('跨度与品位和相同时按低→高弦向量字典序', () => {
    expect(compareShapes(shape([0, 2, 2]), shape([2, 0, 2]))).toBeLessThan(0);
    expect(compareShapes(shape([1, 0, 3]), shape([1, 3, 0]))).toBeLessThan(0);
  });

  it('向量比较中闷音排在品位之后', () => {
    // 跨度、品位和均相同，闷音位置决定先后
    expect(compareShapes(shape([2, null, 2]), shape([null, 2, 2]))).toBeLessThan(0);
    expect(compareShapes(shape([0, null, 2]), shape([null, 0, 2]))).toBeLessThan(0);
    expect(compareShapes(shape([null, null, 2]), shape([null, 2, null]))).toBeGreaterThan(0);
  });

  it('排序结果整体有序且不超过 20 个', () => {
    const query: ChordQuery = { openMidis: [40, 45, 50, 55, 59, 64], targets: [0, 4, 7], maxFret: 9 };
    const report = analyze(query);
    expect(report.totalValid).toBeGreaterThan(MAX_RESULTS);
    expect(report.shapes).toHaveLength(MAX_RESULTS);
    for (let i = 1; i < report.shapes.length; i++) {
      expect(compareShapes(report.shapes[i - 1], report.shapes[i])).toBeLessThanOrEqual(0);
    }
  });
});

describe('rankShape 名次', () => {
  const query: ChordQuery = { openMidis: [40, 45, 50], targets: [0, 4, 7], maxFret: 3 };

  it('合法形状的名次与排序位置一致', () => {
    const query: ChordQuery = { openMidis: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 4 };
    const all = allValidShapes(query);
    expect(all.length).toBeGreaterThan(2);
    all.forEach((s, i) => {
      expect(rankShape(s.frets, query)).toEqual({ rank: i + 1, total: all.length });
    });
  });

  it('不合法形状返回 null', () => {
    expect(rankShape([null, null, null], query)).toBeNull();
  });
});

describe('validateQuery 输入校验', () => {
  it('合法输入无错误', () => {
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 5 })).toEqual([]);
  });

  it('弦数、目标数、品位越界均被拒绝', () => {
    expect(validateQuery({ openMidis: [40, 45, 50], targets: [0, 4, 7], maxFret: 5 })).not.toHaveLength(0);
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0], maxFret: 5 })).not.toHaveLength(0);
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0, 1, 2, 3, 4, 5], maxFret: 5 })).not.toHaveLength(0);
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 2 })).not.toHaveLength(0);
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0, 4, 7], maxFret: 10 })).not.toHaveLength(0);
    expect(validateQuery({ openMidis: [40, 45, 50, 55], targets: [0, 0, 7], maxFret: 5 })).not.toHaveLength(0);
  });
});

describe('pitchClass', () => {
  it('处理负数与超八度', () => {
    expect(pitchClass(60)).toBe(0);
    expect(pitchClass(64)).toBe(4);
    expect(pitchClass(-1)).toBe(11);
    expect(pitchClass(127)).toBe(7);
  });
});
