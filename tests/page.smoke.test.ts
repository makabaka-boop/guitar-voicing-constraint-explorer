import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';

/**
 * 页面冒烟测试：在 happy-dom 中加载真实 index.html 并执行 main.ts，
 * 验证默认参数下搜索自动运行、结果与指板预览渲染、诊断功能可用。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('页面冒烟（happy-dom）', () => {
  beforeAll(async () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    const window = new Window();
    window.document.write(html);
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).document = window.document;
    await import('../src/main');
    // runSearch 内部用 setTimeout 让出渲染，等待其完成
    await sleep(100);
  });

  it('默认参数下自动搜索并展示 20 个结果', () => {
    const items = document.querySelectorAll('#result-list li');
    expect(items).toHaveLength(20);
    expect(document.getElementById('stats')!.textContent).toContain('合法');
  });

  it('首个结果自动预览到指板上', () => {
    const svg = document.getElementById('fretboard')!;
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0);
    expect(document.getElementById('preview-info')!.textContent).toContain('按法');
  });

  it('结果条目展示向量与指标', () => {
    const first = document.querySelector('#result-list li button')!;
    expect(first.textContent).toMatch(/1\. [0-9× ]+/);
    expect(first.textContent).toContain('跨度');
  });

  it('诊断一个非法按法会给出排除原因', () => {
    // 全部设为闷音 → 弹响弦不足
    document.querySelectorAll<HTMLSelectElement>('#diag-selects select').forEach((sel) => {
      sel.value = 'x';
    });
    (document.getElementById('diagnose-btn') as HTMLButtonElement).click();
    const out = document.getElementById('diag-output')!.textContent!;
    expect(out).toContain('弹响弦仅 0 根');
  });

  it('诊断一个合法按法会给出名次', () => {
    // 标准 C 大三和弦：× 3 2 0 1 0
    const frets = ['x', '3', '2', '0', '1', '0'];
    document.querySelectorAll<HTMLSelectElement>('#diag-selects select').forEach((sel, i) => {
      sel.value = frets[i];
    });
    (document.getElementById('diagnose-btn') as HTMLButtonElement).click();
    const out = document.getElementById('diag-output')!.textContent!;
    expect(out).toContain('合法按法');
    expect(out).toContain('排第');
  });
});
