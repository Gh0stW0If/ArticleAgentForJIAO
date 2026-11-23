import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AA_ROOT ?? join(toolDir, '..'));
const build = join(root, 'build');
const port = Number(process.env.AA_PROGRESS_PORT ?? 43132);
const yearDirectory = /^\d{4}$/;
const studyFile = /^\d{4}-\d+\.json$/;
const reviewFile = /^\d{4}-\d+(?:\..+)?\.json$/;
const page = await readFile(join(toolDir, 'project-progress.html'));

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function byYear(directory, pattern) {
  const years = (await entries(directory)).filter(entry => entry.isDirectory() && yearDirectory.test(entry.name));
  return Promise.all(years.map(async ({ name: year }) => ({
    year,
    paths: (await entries(join(directory, year)))
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => join(directory, year, entry.name)),
  })));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function reviewCounts() {
  const annotations = await byYear(join(build, 'annotations'), reviewFile);
  const records = await Promise.all(annotations.flatMap(({ year, paths }) => paths.map(async path => ({
    year,
    record: await readJson(path),
  }))));
  const marked = records.filter(({ record }) => record?.articleId && record.entries?.length);
  const batches = join(build, 'review-batches');
  const batchFiles = (await entries(batches)).filter(entry => entry.isFile() && entry.name.endsWith('.json'));
  const imports = await Promise.all(batchFiles.map(({ name }) => readJson(join(batches, name))));
  return {
    annotatedStudies: new Set(marked.map(({ year, record }) => `${year}/${record.articleId}`)).size,
    imports: imports.filter(batch => batch?.at && batch.reviewer && batch.reviewer !== 'e2e').length,
  };
}

async function revisionFiles() {
  const directory = join(root, 'Datas', 'design', '2026-11修正');
  const files = (await entries(directory))
    .filter(entry => entry.isFile() && !entry.name.startsWith('~$') && /\.(xlsx|docx)$/i.test(entry.name));
  const records = await Promise.all(files.map(async ({ name }) => {
    const info = await stat(join(directory, name)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    return info && { name, updatedAt: info.mtime.toISOString() };
  }));
  return records.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function progress() {
  const [extraction, scores, review, precisReviews, evaluation, revisions] = await Promise.all([
    byYear(join(build, 'extraction'), studyFile),
    byYear(join(build, 'precis2'), studyFile),
    reviewCounts(),
    byYear(join(build, 'precis2-review'), reviewFile),
    readJson(join(build, 'precis2', 'eval.json')),
    revisionFiles(),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    extraction: { studies: extraction.flatMap(({ paths }) => paths).length, years: extraction.filter(({ paths }) => paths.length).length },
    review,
    precis2: {
      studies: scores.flatMap(({ paths }) => paths).length,
      reviewFiles: precisReviews.flatMap(({ paths }) => paths).length,
      evaluation: evaluation?.overall ? {
        generatedAt: evaluation.generatedAt,
        matched: evaluation.overall.matchedStudies,
        total: evaluation.overall.goldStudies,
        exact: evaluation.overall.exactRate,
        near: evaluation.overall.nearRate,
        kappa: evaluation.overall.kappa,
      } : null,
    },
    revisions,
  };
}

function respond(res, status, type, content) {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(content);
}

const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (req.method !== 'GET') return respond(res, 405, 'text/plain', '仅支持 GET');
  if (path === '/') return respond(res, 200, 'text/html', page);
  if (path !== '/api/progress') return respond(res, 404, 'text/plain', '页面不存在');

  try {
    respond(res, 200, 'application/json', JSON.stringify(await progress()));
  } catch (error) {
    console.error(error);
    respond(res, 500, 'application/json', JSON.stringify({ error: '无法读取工作区进度' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`论文进度面板 http://127.0.0.1:${server.address().port}/`);
});
