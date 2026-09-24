/**
 * @aa/europepmc — Europe PMC 客户端
 *
 * ===== 为什么接这个源（实测，见 `docs/16-author-contact.md` 与 `docs/17-europepmc.md`）=====
 *
 * 需求④ 原本只授权 Crossref。实测下来 Crossref 有两处够不着：
 *
 *   1. **题名缺副标题**：`article.title` 当前没拿满分的 27 篇里，**20 篇（74%）Crossref 的题名
 *      比 Europe PMC 短**——Crossref 常给 `Acupuncture for Chronic Severe Functional Constipation`，
 *      而 PubMed 收录的是完整题名 `…: A Randomized Trial`。金标准用的是完整题名。
 *   2. **查不到时的兜底**：Crossref 有记录缺失/反查无候选的情形（实测 2017 年有几篇
 *      `CROSSREF_NOTE: 按标题反查得到 5 个候选但均低于阈值`）。
 *
 * ===== 明确**不**用它做什么 =====
 *
 * **不用它补 `author_contact`。** 这一条是有实测依据的、反直觉的结论：
 * Europe PMC 会把**每一位作者**的邮箱都附在各自单位后面，且**不保留通讯作者标记**
 * （PubMed 的 `Electronic address:` 标记在该数据集里没有）。实测：
 *   · 82/203 篇能拿到邮箱，但"恰好一个邮箱"的 50 篇里**只有 21 篇（42%）**那一个就是金标准邮箱
 *     → "唯一即采用"会引入 29 个错误；
 *   · 抽到的邮箱**命中** Europe PMC 列表的 78 篇，当前加权正确率只有 26.9%（低于基线 38.9%），
 *     因为 EPMC 列的邮箱几乎必然包含我们抽到的那个 → **命中没有判别力**。
 * 即：这个源给的正是我们最缺的信息（"谁是通讯作者"），而它恰恰没有这个信息。
 *
 * 数据来源：`https://www.ebi.ac.uk/europepmc/webservices/rest/search`
 * 无需 API key；带上 `mailto` 是礼貌约定，也便于对方在异常流量时联系。
 */

/** Europe PMC 的一条核心记录（只保留我们用得到的字段）。 */
export interface EuropePmcWork {
  /** DOI（规范化后） */
  doi: string;
  /** PubMed 题名——**比 Crossref 更常带副标题**，这是接入本源的主要理由 */
  title?: string;
  /** 期刊名（优先全称，退化到 MEDLINE 缩写） */
  journal?: string;
  /** 出版年 */
  pubYear?: string;
  /** PubMed ID */
  pmid?: string;
  /** PubMed Central ID（开放获取时才有） */
  pmcid?: string;
  /**
   * 全部作者的邮箱（**不含通讯作者标记**）。
   * 保留下来只用于"冲突记录/人工复核"，**不用于自动填 `authorContact`**（见文件头说明）。
   */
  authorEmails: readonly string[];
}

export interface EuropePmcClient {
  /** 按 DOI 查一条记录；查不到返回 null。 */
  byDoi(doi: string): Promise<EuropePmcWork | null>;
}

export interface EuropePmcClientOptions {
  /** 联系方式，写进 User-Agent（Europe PMC 的礼貌约定） */
  mailto?: string;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 超时毫秒，默认 15000 */
  timeoutMs?: number;
  /** 失败重试次数，默认 2（只对 5xx / 网络错误重试） */
  retries?: number;
  /** 测试用的重试等待，默认真实 setTimeout */
  sleepImpl?: (ms: number) => Promise<void>;
}

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)+/g;

/** 去掉 DOI 的 URL 前缀，统一成裸 DOI。 */
export function normalizeDoi(input: string): string {
  return String(input ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
}

/**
 * 清洗题名/刊名：**先剥内联标签**、再解码 HTML 实体，最后折叠空白。
 *
 * ⚠️ 剥标签这一步不能省。实测 2023-02 的 EPMC 题名是
 * `… Controlled, 2 <b>×</b> 2 Factorial Trial.`——直接把 `<b>` 写进产物会让该篇题名
 * 从"半分"掉成"错"（21 篇 A/B 里唯一的一次退步就是这么来的）。
 * 顺序也很重要：必须**先剥标签再解码实体**，否则 `&lt;b&gt;` 会被解码成 `<b>` 而躲过剥离。
 */
function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t || undefined;
}

/** Europe PMC 的响应形态（只声明用到的部分）。 */
interface EpMcResult {
  doi?: string;
  title?: string;
  pubYear?: string;
  pmid?: string;
  pmcid?: string;
  journalInfo?: { journal?: { title?: string; medlineAbbreviation?: string } };
  authorList?: {
    author?: {
      fullName?: string;
      affiliation?: string;
      authorAffiliationDetailsList?: { authorAffiliation?: { affiliation?: string }[] };
    }[];
  };
}

function toWork(r: EpMcResult): EuropePmcWork | null {
  const doi = normalizeDoi(r.doi ?? '');
  if (!doi) return null;
  const emails = new Set<string>();
  for (const a of r.authorList?.author ?? []) {
    const texts: string[] = [];
    for (const aff of a.authorAffiliationDetailsList?.authorAffiliation ?? []) texts.push(String(aff.affiliation ?? ''));
    if (a.affiliation) texts.push(String(a.affiliation));
    for (const t of texts) {
      for (const m of t.match(EMAIL_RE) ?? []) emails.add(m.replace(/\s+/g, ''));
    }
  }
  const title = clean(r.title);
  const journal = clean(r.journalInfo?.journal?.title ?? r.journalInfo?.journal?.medlineAbbreviation);
  const pubYear = clean(r.pubYear);
  const pmid = clean(r.pmid);
  const pmcid = clean(r.pmcid);
  return {
    doi,
    ...(title ? { title } : {}),
    ...(journal ? { journal } : {}),
    ...(pubYear ? { pubYear } : {}),
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    authorEmails: [...emails],
  };
}

export function createEuropePmcClient(opts: EuropePmcClientOptions = {}): EuropePmcClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ua = `article-agent/1.0${opts.mailto ? ` (mailto:${opts.mailto})` : ''}`;

  return {
    async byDoi(rawDoi: string): Promise<EuropePmcWork | null> {
      const doi = normalizeDoi(rawDoi);
      if (!doi) return null;
      const url = `${BASE}?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core&pageSize=1`;

      let lastErr: Error | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await doFetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: ac.signal });
          clearTimeout(timer);
          /* 4xx 不重试（请求本身有问题，重试也是白费） */
          if (res.status >= 400 && res.status < 500) return null;
          if (!res.ok) { lastErr = new Error(`Europe PMC HTTP ${res.status}`); }
          else {
            const j = (await res.json()) as { resultList?: { result?: EpMcResult[] } };
            const hit = j.resultList?.result?.[0];
            return hit ? toWork(hit) : null;
          }
        } catch (e) {
          clearTimeout(timer);
          lastErr = e as Error;
        }
        if (attempt < retries) await sleep(300 * (attempt + 1));
      }
      throw lastErr ?? new Error('Europe PMC 请求失败');
    },
  };
}
