/**
 * 密钥泄漏扫描（`tools/lib/secret_scan.mjs`）。
 *
 * 这个检查是**安装包的唯一防泄漏闸**：`runtime/llm.local.json` 里是真实 API key，
 * 一旦随包发给医生就等于泄漏。所以三个方向都要钉住：
 *   · 该报的报（llm.local.json、文本里的 sk-…）
 *   · **不该报的不报**（二进制里的巧合字节 —— 实测 `locales\nl.pak` 会误报）
 *   · 二进制根本不读（PDF 的压缩流同样会碰巧匹配）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSecretLeaks, TEXT_EXT, KEY_RE } from './lib/secret_scan.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aa-secret-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (rel, content) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe('findSecretLeaks —— 安装包防泄漏闸', () => {
  it('抓到 llm.local.json（文件名本身就是问题）', () => {
    write('runtime/llm.local.json', '{"apiKey":"whatever"}');
    const hits = findSecretLeaks(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0].rel).toContain('llm.local.json');
  });

  it('抓到文本文件里的密钥（不看文件名）', () => {
    write('runtime/说明.txt', '临时记一下：sk-abcdefghijklmnop123456');
    const hits = findSecretLeaks(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0].rel).toContain('说明.txt');
  });

  it('**不报**二进制文件里的巧合字节 —— 实测 locales/nl.pak 会误报', () => {
    // 扩展名不在文本白名单里 → 根本不读
    write('locales/nl.pak', 'sk-abcdefghijklmnop123456');
    write('resources/app.asar.unpacked/x.dll', 'sk-abcdefghijklmnop123456');
    expect(findSecretLeaks(dir)).toHaveLength(0);
  });

  it('**不报** PDF / 图片里碰巧出现的同样字节', () => {
    write('Datas/articles/2015/x.pdf', '%PDF-1.7 sk-abcdefghijklmnop123456');
    write('build/mineru/2015/x/txt/x_middle.json', '{"raw":"ok"}');   // json 是文本，但没密钥
    expect(findSecretLeaks(dir)).toHaveLength(0);
  });

  it('干净的包一个都不报', () => {
    write('使用说明.txt', '双击图标启动；不需要填密钥。');
    write('build/extraction/2015/2015-01.json', '{"articleId":"2015-01"}');
    write('runtime/说明.txt', '这个目录必须存在。');
    expect(findSecretLeaks(dir)).toHaveLength(0);
  });

  it('递归进子目录，且报的是相对路径', () => {
    write('a/b/c/runtime/llm.local.json', '{}');
    const hits = findSecretLeaks(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0].rel).toBe(join('a', 'b', 'c', 'runtime', 'llm.local.json'));
  });

  it('目录不存在时返回空数组，不抛异常', () => {
    expect(findSecretLeaks(join(dir, '不存在'))).toEqual([]);
  });

  it('形态约束：文本白名单里不含二进制扩展名，密钥正则不过度宽松', () => {
    for (const bad of ['.pak', '.dll', '.exe', '.bin', '.pdf', '.png', '.woff2']) {
      expect(TEXT_EXT.has(bad), `${bad} 不该被当文本扫`).toBe(false);
    }
    for (const good of ['.json', '.txt', '.md', '.bat', '.mjs']) {
      expect(TEXT_EXT.has(good), `${good} 应该被扫`).toBe(true);
    }
    // 太短的不算密钥（避免误报），够长的才算
    expect(KEY_RE.test('sk-short')).toBe(false);
    expect(KEY_RE.test('sk-abcdefghijklmnop')).toBe(true);
  });
});
