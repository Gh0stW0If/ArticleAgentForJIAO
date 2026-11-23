import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const flowCaption = /\bconsort\b|\bflow[\s-]*(?:chart|diagram)\b|\b(?:trial|study) profile\b|\b(?:participant|patient|recruitment|trial|study) flow\b|(?:研究|试验|纳入|筛选|受试者)流程/u;
const figureNumber = /\bfig(?:ure)?\.?\s*(\d+)\b|图\s*(\d+)\b/gi;
const flowDescription = /\b(?:participants?|patients?)\b.{0,85}\b(?:screened|randomi[sz]ed|allocated|excluded|withdrew|enrolled)\b|入组|随机分配|入组筛选/u;

// RapidOCR 的默认 ONNX 模型随 Python 环境安装。切图在本地识别。
const ocr = `
import json, sys
from rapidocr import RapidOCR

sys.stdout.reconfigure(encoding="utf-8")
engine = RapidOCR()
results = []
for path in sys.argv[1:]:
    try:
        result = engine(path)
        lines = []
        for box, text, score in zip(result.boxes, result.txts, result.scores):
            if score >= 0.55 and text.strip():
                lines.append(f"[x={round(min(p[0] for p in box))}, y={round(min(p[1] for p in box))}] {text.strip()}")
        results.append("\\n".join(lines))
    except (ValueError, TypeError, RuntimeError):
        results.append("")
print(json.dumps(results, ensure_ascii=False))
`;

export async function readParticipantFlow(root, doc) {
  const middle = resolve(root, doc.mineruDir);
  // 旧 MiniDoc 中 mineruDir 存的是 _middle.json 路径。
  const directory = middle.endsWith('_middle.json') ? dirname(middle) : middle;
  const mentioned = new Set();
  for (const block of doc.blocks) {
    if (block.type !== 'text' || block.dropped || !['methods', 'results', 'abstract'].includes(block.section)) continue;
    const paragraphs = block.text.toLowerCase().split(/(?<=[。;；]|\.)\s+(?=[a-z]{2,}\s)/u);
    for (const paragraph of paragraphs) {
      if (!flowCaption.test(paragraph) && !flowDescription.test(paragraph)) continue;
      for (const match of paragraph.matchAll(figureNumber)) mentioned.add(match[1] ?? match[2]);
    }
  }
  const figures = doc.blocks.filter(block => block.type === 'figure' && !block.dropped
    && (flowCaption.test(block.text.toLowerCase())
      || [...block.text.matchAll(figureNumber)].some(match => mentioned.has(match[1] ?? match[2]))));
  if (!figures.length) return { doc, warnings: [] };

  const warnings = [];
  const inputs = [];
  for (const block of figures) {
    const path = block.imagePath && [resolve(directory, block.imagePath), resolve(directory, 'images', block.imagePath)]
      .find(candidate => {
        const local = relative(directory, candidate);
        return local && !local.startsWith('..') && !isAbsolute(local) && existsSync(candidate);
      });
    if (path) inputs.push({ block, path });
    else warnings.push(`第 ${block.page} 页流程图缺少切图`);
  }
  if (!inputs.length) return { doc, warnings };
  const directoryCache = join(root, 'build', 'participant-flow-cache');
  mkdirSync(directoryCache, { recursive: true });
  const recognized = new Map();
  const pending = [];
  for (const input of inputs) {
    const hash = createHash('sha256').update(ocr).update(process.env.AA_OCR_PYTHON || 'python').update(readFileSync(input.path)).digest('hex');
    input.cacheFile = join(directoryCache, hash + '.json');
    try {
      const cached = JSON.parse(readFileSync(input.cacheFile, 'utf8'));
      if (typeof cached.text === 'string' && /\d/.test(cached.text)) { recognized.set(input.block.index, cached.text); continue; }
    } catch {}
    pending.push(input);
  }

  try {
    if (pending.length) {
    const { stdout } = await exec(process.env.AA_OCR_PYTHON || 'python', ['-c', ocr, ...pending.map(item => item.path)], {
      cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    const text = JSON.parse(stdout);
    for (const [i, { block, cacheFile }] of pending.entries()) {
      if (typeof text[i] === 'string' && /\d/.test(text[i])) { recognized.set(block.index, text[i]); writeFileSync(cacheFile, JSON.stringify({text:text[i]}), 'utf8'); }
      else warnings.push(`第 ${block.page} 页流程图未识别到人数，请查阅原图`);
    }
    }
    return {
      doc: {
        ...doc,
        blocks: doc.blocks.map(block => {
          const captionAndText = recognized.get(block.index);
          return captionAndText ? { ...block, figureOcr: captionAndText, text: `${block.text}\n流程图 OCR（坐标仅用于辨别框的相对位置）\n${captionAndText}` } : block;
        }),
      },
      warnings,
    };
  } catch {
    warnings.push('流程图 OCR 未运行。请确认 Python 安装了 RapidOCR 和 ONNX Runtime，或设置 AA_OCR_PYTHON。');
    return { doc, warnings };
  }
}
