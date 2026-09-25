/**
 * 指板和弦形状搜索核心逻辑（纯函数，不依赖 DOM，页面与测试共用）。
 *
 * 规则（与需求一一对应）：
 *  - 每根弦可闷音（null）或按 0..maxFret 品；
 *  - 弹响弦不少于 MIN_SOUNDED_STRINGS 根；
 *  - 弹响弦出现的音级只能来自目标集合，且必须覆盖全部目标音级；
 *  - 每根按下的弦（品位 > 0）算一根手指，不计横按，最多 MAX_FINGERS 根；
 *  - 非零品位的最大最小差不超过 MAX_SPAN；没有按弦时跨度算零；
 *  - 结果按 跨度 → 品位总和 → 从低音弦到高音弦的向量字典序 排序，
 *    向量比较中闷音排在任何品位之后；仅展示前 MAX_RESULTS 个。
 */

export const MIN_SOUNDED_STRINGS = 3;
export const MAX_FINGERS = 4;
export const MAX_SPAN = 4;
export const MAX_RESULTS = 20;

/** 一根弦的按法：null 表示闷音，0..maxFret 表示品位 */
export type FretChoice = number | null;

export interface ChordQuery {
  /** 开放弦 MIDI 音高，从低音弦到高音弦排列 */
  openMidis: number[];
  /** 目标音级（0–11，互不相同） */
  targets: number[];
  /** 最大品位 */
  maxFret: number;
}

export type ExclusionCode =
  | 'too-few-sounded'     // 弹响弦少于 3 根
  | 'foreign-pitch-class' // 出现目标集合之外的音级
  | 'missing-target'      // 未覆盖全部目标音级
  | 'too-many-fingers'    // 按弦手指数超过 4
  | 'span-too-wide';      // 非零品位跨度超过 4

export const EXCLUSION_CODES: readonly ExclusionCode[] = [
  'too-few-sounded',
  'foreign-pitch-class',
  'missing-target',
  'too-many-fingers',
  'span-too-wide',
];

export interface Evaluation {
  ok: boolean;
  codes: ExclusionCode[];
}

export interface Shape {
  /** 各弦按法，从低音弦到高音弦 */
  frets: FretChoice[];
  /** 弹响弦数量 */
  sounded: number;
  /** 按弦手指数（品位 > 0 的弦数） */
  fingers: number;
  /** 非零品位跨度；没有按弦时为 0 */
  span: number;
  /** 品位总和（闷音计 0） */
  fretSum: number;
}

export interface SearchReport {
  /** 排序后的前 MAX_RESULTS 个形状 */
  shapes: Shape[];
  /** 合法形状总数 */
  totalValid: number;
  /** 枚举的候选总数（含闷音组合） */
  totalCandidates: number;
  /** 各条规则排除掉的候选数量（一个候选可能违反多条） */
  exclusions: Record<ExclusionCode, number>;
}

/** MIDI 音高 → 音级（0–11） */
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** 页面侧输入校验：4–6 根弦、2–5 个不同目标音级、最大品位 3–9 */
export function validateQuery(query: ChordQuery): string[] {
  const errors: string[] = [];
  const { openMidis, targets, maxFret } = query;
  if (openMidis.length < 4 || openMidis.length > 6) {
    errors.push(`弦数须为 4–6，当前为 ${openMidis.length}`);
  }
  if (openMidis.some((m) => !Number.isInteger(m) || m < 0 || m > 127)) {
    errors.push('开放弦 MIDI 音高须为 0–127 的整数');
  }
  if (targets.length < 2 || targets.length > 5) {
    errors.push(`目标音级须为 2–5 个，当前为 ${targets.length}`);
  }
  if (new Set(targets).size !== targets.length) {
    errors.push('目标音级须互不相同');
  }
  if (targets.some((t) => !Number.isInteger(t) || t < 0 || t > 11)) {
    errors.push('目标音级须在 0–11 之间');
  }
  if (!Number.isInteger(maxFret) || maxFret < 3 || maxFret > 9) {
    errors.push(`最大品位须为 3–9 的整数，当前为 ${maxFret}`);
  }
  return errors;
}

/** 计算一个形状的度量指标（不校验合法性） */
export function measureShape(frets: FretChoice[]): Omit<Shape, 'frets'> {
  let sounded = 0;
  let fingers = 0;
  let fretSum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const f of frets) {
    if (f === null) continue;
    sounded++;
    fretSum += f;
    if (f > 0) {
      fingers++;
      if (f < min) min = f;
      if (f > max) max = f;
    }
  }
  return { sounded, fingers, span: fingers === 0 ? 0 : max - min, fretSum };
}

// ---- 内部实现：用位掩码加速全枚举 ----

const BIT_TOO_FEW_SOUNDED = 1;
const BIT_FOREIGN_PC = 2;
const BIT_MISSING_TARGET = 4;
const BIT_TOO_MANY_FINGERS = 8;
const BIT_SPAN_TOO_WIDE = 16;

function maskToCodes(mask: number): ExclusionCode[] {
  const codes: ExclusionCode[] = [];
  if (mask & BIT_TOO_FEW_SOUNDED) codes.push('too-few-sounded');
  if (mask & BIT_FOREIGN_PC) codes.push('foreign-pitch-class');
  if (mask & BIT_MISSING_TARGET) codes.push('missing-target');
  if (mask & BIT_TOO_MANY_FINGERS) codes.push('too-many-fingers');
  if (mask & BIT_SPAN_TOO_WIDE) codes.push('span-too-wide');
  return codes;
}

/**
 * 对单个形状求值，返回违反规则的位掩码（0 表示合法）。
 * targetMask/targetBits 由调用方预算，避免全枚举时重复构造 Set。
 */
function evaluateMask(
  frets: FretChoice[],
  openMidis: number[],
  targetMask: boolean[],
  targetBits: number,
): number {
  let sounded = 0;
  let fingers = 0;
  let foreign = false;
  let seenBits = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < frets.length; i++) {
    const f = frets[i];
    if (f === null) continue;
    sounded++;
    const pc = pitchClass(openMidis[i] + f);
    if (targetMask[pc]) {
      seenBits |= 1 << pc;
    } else {
      foreign = true;
    }
    if (f > 0) {
      fingers++;
      if (f < min) min = f;
      if (f > max) max = f;
    }
  }
  let mask = 0;
  if (sounded < MIN_SOUNDED_STRINGS) mask |= BIT_TOO_FEW_SOUNDED;
  if (foreign) mask |= BIT_FOREIGN_PC;
  // seenBits 始终是 targetBits 的子集，相等即覆盖全部目标音级
  if (seenBits !== targetBits) mask |= BIT_MISSING_TARGET;
  if (fingers > MAX_FINGERS) mask |= BIT_TOO_MANY_FINGERS;
  if (fingers > 0 && max - min > MAX_SPAN) mask |= BIT_SPAN_TOO_WIDE;
  return mask;
}

function normalizeTargets(targets: number[]): { targetMask: boolean[]; targetBits: number } {
  const targetMask = new Array<boolean>(12).fill(false);
  let targetBits = 0;
  for (const t of targets) {
    targetMask[t] = true;
    targetBits |= 1 << t;
  }
  return { targetMask, targetBits };
}

/** 校验单个形状，返回违反的规则代码（空数组表示合法） */
export function evaluateShape(frets: FretChoice[], query: ChordQuery): Evaluation {
  const { targetMask, targetBits } = normalizeTargets(query.targets);
  const mask = evaluateMask(frets, query.openMidis, targetMask, targetBits);
  return { ok: mask === 0, codes: maskToCodes(mask) };
}

/** 排序比较器：跨度 → 品位总和 → 低→高弦向量字典序（闷音排在品位之后） */
export function compareShapes(a: Shape, b: Shape): number {
  if (a.span !== b.span) return a.span - b.span;
  if (a.fretSum !== b.fretSum) return a.fretSum - b.fretSum;
  const len = Math.min(a.frets.length, b.frets.length);
  for (let i = 0; i < len; i++) {
    const x = a.frets[i] === null ? Infinity : (a.frets[i] as number);
    const y = b.frets[i] === null ? Infinity : (b.frets[i] as number);
    if (x !== y) return x - y;
  }
  return 0;
}

/** 枚举全部合法形状并排序（不截断），analyze/rankShape 共用 */
export function allValidShapes(query: ChordQuery): Shape[] {
  const n = query.openMidis.length;
  const { targetMask, targetBits } = normalizeTargets(query.targets);
  const radix = query.maxFret + 2; // 闷音 + 0..maxFret
  const total = Math.pow(radix, n);
  const frets: FretChoice[] = new Array<FretChoice>(n).fill(null);
  const valid: Shape[] = [];
  for (let code = 0; code < total; code++) {
    let x = code;
    for (let i = 0; i < n; i++) {
      const d = x % radix;
      x = Math.floor(x / radix);
      frets[i] = d === 0 ? null : d - 1;
    }
    if (evaluateMask(frets, query.openMidis, targetMask, targetBits) === 0) {
      valid.push({ frets: [...frets], ...measureShape(frets) });
    }
  }
  valid.sort(compareShapes);
  return valid;
}

/** 全枚举搜索：返回前 MAX_RESULTS 个形状及各条规则的排除统计 */
export function analyze(query: ChordQuery): SearchReport {
  const n = query.openMidis.length;
  const { targetMask, targetBits } = normalizeTargets(query.targets);
  const radix = query.maxFret + 2;
  const total = Math.pow(radix, n);
  const frets: FretChoice[] = new Array<FretChoice>(n).fill(null);
  const exclusions: Record<ExclusionCode, number> = {
    'too-few-sounded': 0,
    'foreign-pitch-class': 0,
    'missing-target': 0,
    'too-many-fingers': 0,
    'span-too-wide': 0,
  };
  const valid: Shape[] = [];
  for (let code = 0; code < total; code++) {
    let x = code;
    for (let i = 0; i < n; i++) {
      const d = x % radix;
      x = Math.floor(x / radix);
      frets[i] = d === 0 ? null : d - 1;
    }
    const mask = evaluateMask(frets, query.openMidis, targetMask, targetBits);
    if (mask === 0) {
      valid.push({ frets: [...frets], ...measureShape(frets) });
    } else {
      if (mask & BIT_TOO_FEW_SOUNDED) exclusions['too-few-sounded']++;
      if (mask & BIT_FOREIGN_PC) exclusions['foreign-pitch-class']++;
      if (mask & BIT_MISSING_TARGET) exclusions['missing-target']++;
      if (mask & BIT_TOO_MANY_FINGERS) exclusions['too-many-fingers']++;
      if (mask & BIT_SPAN_TOO_WIDE) exclusions['span-too-wide']++;
    }
  }
  valid.sort(compareShapes);
  return {
    shapes: valid.slice(0, MAX_RESULTS),
    totalValid: valid.length,
    totalCandidates: total,
    exclusions,
  };
}

/**
 * 计算指定形状在全部合法形状中的名次（1 起）。
 * 形状不合法时返回 null（可配合 evaluateShape 查看排除原因）。
 */
export function rankShape(frets: FretChoice[], query: ChordQuery): { rank: number; total: number } | null {
  if (!evaluateShape(frets, query).ok) return null;
  const target: Shape = { frets, ...measureShape(frets) };
  const all = allValidShapes(query);
  let rank = 1;
  for (const shape of all) {
    if (compareShapes(shape, target) < 0) rank++;
  }
  return { rank, total: all.length };
}
