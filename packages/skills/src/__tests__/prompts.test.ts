import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROMPTS, OUTCOME_TASKS, SENTINELS } from '../prompts.generated.ts';

const ROOT = resolve(__dirname, '../../../..');

describe('prompts — 生成的提示词', () => {
  it('各层级的系统提示都有且内容充实', () => {
    // article / comparison / outcome 三层 + 数值层（outcomeValue）
    // + 上游两个规划 SKILL（study-plan / outcome-plan）+ 事后验证（outcome-audit 查漏补缺）
    expect(Object.keys(PROMPTS).sort()).toEqual([
      'article', 'comparison', 'outcome', 'outcomeAudit', 'outcomePlan', 'outcomeValue', 'studyPlan',
    ]);
    for (const [level, text] of Object.entries(PROMPTS)) {
      expect(text.length, `${level} 提示词过短`).toBeGreaterThan(2000);
    }
  });

  it('数值层与结局字段层职责分离：两边的提示词各讲各的', () => {
    /*
     * 拆分动机（实测）：数值列的识别规则（ITT vs PP、变异值是 SD 还是 95%CI、例数在正文里…）
     * 篇幅很大，塞进结局字段的提示词里会把字段图例挤掉，两边都做不好。
     */
    const fieldSide = PROMPTS.outcome;
    const valueSide = PROMPTS.outcomeValue;
    // 取数列的"任务规则"放在用户消息尾巴里（材料在前、任务在后，便于前缀缓存命中）
    const valueAll = `${PROMPTS.outcomeValue}\n${OUTCOME_TASKS.value}`;

    // 数值层：讲取数列规则，不讲结局元信息图例
    expect(valueAll).toContain('ITT');
    expect(valueAll).toMatch(/变异值/);
    expect(valueSide).toContain('endOfTreatment');
    expect(valueSide).toContain('followUpEnd');
    expect(valueSide, '数值层不该再讲 construct 图例').not.toContain('subconstruct');

    // 结局字段层：讲字段定义，且明确声明数值不归它管
    expect(fieldSide).toContain('subconstruct');
    expect(fieldSide).toContain('measurementRange');
    expect(fieldSide).toMatch(/不要输出任何时点数值|不在本次职责内/);
    expect(`${fieldSide}\n${OUTCOME_TASKS.item}`, '结局字段层不该再重复取数列规则').not.toMatch(/Per protocol/);

    // 拆分后的字段层必须明显短于拆分前的那份"两件事合写"版本
    expect(fieldSide.length).toBeLessThan(6000);
  });

  it('outcome-audit 提示词要求只报差异、且必须带 quote', () => {
    const t = PROMPTS.outcomeAudit;
    expect(t).toContain('gaps');
    expect(t).toContain('suspects');
    expect(t).toMatch(/只报.*差异/);
    expect(t).toContain('quote');
  });

  it('outcome-plan 提示词要求以声明句为锚，并排除结果表里的额外指标', () => {
    const t = PROMPTS.outcomePlan;
    expect(t).toContain('anchor');
    expect(t).toMatch(/primary\/secondary outcome|primary.*outcome/i);
    expect(t).toMatch(/量表分项/);
    expect(t).toMatch(/对不上就不要列|会被系统丢弃/);
  });

  it('study-plan 提示词只做结构判断，不抽细节', () => {
    const t = PROMPTS.studyPlan;
    expect(t).toContain('comparisonCount');
    expect(t).toContain('experimentalGroupCount');
    expect(t).toMatch(/不要\*\*抽取任何设计细节|不要.*抽取任何设计细节/);
    expect(t).toContain('groups');
    expect(t).toContain('comparisons');
  });

  it('结局层的三段任务说明齐备（分步调用的用户消息尾巴）', () => {
    expect(Object.keys(OUTCOME_TASKS).sort()).toEqual(['item', 'list', 'value']);
    for (const [k, text] of Object.entries(OUTCOME_TASKS)) {
      // 识别阶段刻意做到极短（响应越小越不会被截断），其余两段则较完整
      expect(text.length, `${k} 任务说明过短`).toBeGreaterThan(k === 'list' ? 400 : 2000);
      expect(text, `${k} 缺 JSON 模板`).toContain('JSON 模板');
    }
    // 取值阶段必须能代入具体结局
    expect(OUTCOME_TASKS.item).toContain('{{OUTCOME_NAME}}');
    expect(OUTCOME_TASKS.item).toContain('{{INSTRUMENT}}');
    expect(OUTCOME_TASKS.value).toContain('{{OUTCOME_NAME}}');
    expect(OUTCOME_TASKS.value).toContain('{{INSTRUMENT}}');
    // 字段层不许输出时点块；数值层只输出时点块
    expect(OUTCOME_TASKS.item).toMatch(/不要输出任何时点数值/);
    expect(OUTCOME_TASKS.value).toMatch(/不要\*\*输出结局名称|不要.*输出结局名称/);
    // 识别阶段必须只输出两个键（否则响应又会被撑爆）
    expect(OUTCOME_TASKS.list).toMatch(/只需.*给出每个结局的名称与测量工具/);
    expect(OUTCOME_TASKS.list).toMatch(/不要.*给出任何数值或编码字段/);
  });

  it('每层提示词都包含：JSON 模板、输出格式约束、哨兵约定', () => {
    // 字段定义与输出规则在系统提示里；JSON 模板在系统提示（article/comparison）
    // 或任务说明（outcome 的 list/item/value 三段）里
    const templateInTask = new Set(['outcome', 'outcomeValue']);
    for (const [level, text] of Object.entries(PROMPTS)) {
      expect(text, `${level} 缺输出格式约束`).toContain('输出格式');
      expect(text, `${level} 缺哨兵约定`).toContain('NR');
      expect(text, `${level} 缺 quote 要求`).toContain('quote');
      if (!templateInTask.has(level)) expect(text, `${level} 缺 JSON 模板`).toContain('JSON 模板');
    }
    for (const [level, text] of Object.entries(OUTCOME_TASKS)) {
      expect(text, `结局任务 ${level} 缺 quote 要求`).toContain('quote');
      expect(text, `结局任务 ${level} 缺 JSON 模板`).toContain('JSON 模板');
    }
  });

  it('要求模型逐字回传 quote（坐标定位的前提）', () => {
    for (const text of Object.values(PROMPTS)) {
      expect(text).toContain('逐字');
      expect(text).toMatch(/定位失败|会被直接丢弃/);
    }
  });

  it('明确禁止使用模型的既有记忆（防幻觉）', () => {
    for (const text of Object.values(PROMPTS)) {
      expect(text).toMatch(/既有记忆|记忆/);
    }
  });

  it('article 提示词含每个字段的含义与允许取值', () => {
    const t = PROMPTS.article;
    // 关键字段含义
    expect(t).toContain('conditionSystem');
    expect(t).toContain('疾病所属系统分类');
    // 允许取值（编码表）
    expect(t).toContain('`1`=肌肉骨骼和结缔组织疾病');
    expect(t).toContain('`2`=西方：非亚洲国家');
    // 必须填编码而不是中文含义
    expect(t).toContain('必须填编码');
  });

  it('article 提示词把批注要求带进去（这是从 xlsx 提取的）', () => {
    const t = PROMPTS.article;
    // K2 批注：英文期刊查附录1 + 中文期刊规则
    expect(t).toContain('附录1-补充替代医学期刊清单');
    expect(t).toContain('所有中医药类期刊都是补充替代医学期刊');
    // S2 批注：可参考 ICD-11
    expect(t).toContain('ICD-11');
    // V2 批注补全的判定标准
    expect(t).toContain('亚洲国家');
  });

  it('article 提示词排除 gold_meta 字段（不由 LLM 推断）', () => {
    const t = PROMPTS.article;
    expect(t).toContain('不需要你输出的字段');
    expect(t).toContain('literatureNo');
    expect(t).toContain('extractor');
  });

  it('comparison 提示词要求逐比较组输出', () => {
    const t = PROMPTS.comparison;
    expect(t).toContain('comparisons');
    expect(t).toMatch(/每个比较组单独输出/);
    expect(t).toContain('NA');   // 不适用时填 NA
  });

  it('outcome 提示词含变异值类型的优先级规则（来自 T3 批注）', () => {
    // 变异值图例已随数值部分移到 outcomeValue 层
    const t = PROMPTS.outcomeValue;
    expect(t).toContain('标准误（SE）');
    expect(t).toMatch(/只选 1 个|只提取 SE/);
    // 时点划分也在数值层
    expect(t).toContain('endOfTreatment');
    expect(t).toContain('followUpEnd');
    expect(t).toContain('baseline');
  });

  it('outcome 提示词明确要求「每个结局指标一条、不许把多个量表合并」', () => {
    const t = PROMPTS.outcome + OUTCOME_TASKS.list;
    expect(t).toContain('全部结局指标');
    expect(t).toMatch(/分量表/);
    expect(t).toMatch(/不要只输出主要结局|不能只输出主要结局/);
  });
  it('哨兵约定三件套齐全（NR / NA / NE）', () => {
    expect(SENTINELS.NR).toContain('not reported');
    expect(SENTINELS.NA).toContain('not applicable');
    expect(SENTINELS.NE).toBeTruthy();
  });

  it('Markdown 版提示词已落盘，便于人工审阅', () => {
    for (const level of ['article', 'comparison', 'outcome', 'outcomeValue', 'outcomeListTask', 'outcomeItemTask', 'outcomeValueTask']) {
      const p = resolve(ROOT, 'build', 'prompts', `${level}.md`);
      expect(existsSync(p), `${p} 不存在`).toBe(true);
      expect(readFileSync(p, 'utf8').length).toBeGreaterThan(400);
    }
  });

  it('字段清单里出现的每个键都在提示词的 JSON 模板里（模板与字段同步）', () => {
    // 从提示词的模板段里抽出顶层键
    const tpl = PROMPTS.article.slice(PROMPTS.article.indexOf('## JSON 模板'));
    for (const key of ['title', 'journalClass', 'conditionSystem', 'countryClass', 'doi']) {
      expect(tpl, `模板缺 ${key}`).toContain(`"${key}"`);
    }
  });
});

describe('prompts — 与 SKILL 的衔接', () => {
  it('article 提示词里的键都能被 SKILL 的 FIELD_MAP 识别（否则字段会被静默丢弃）', async () => {
    // 这是一个防回归测试：提示词模板与 FIELD_MAP 若不同步，
    // 模型输出的字段会因为"不认识该键"而被忽略，且不会有任何报错。
    const tplSection = PROMPTS.article.slice(
      PROMPTS.article.indexOf('## JSON 模板'),
      PROMPTS.article.indexOf('## 常见错误'),
    );
    const keys = [...tplSection.matchAll(/^\s{2}"([A-Za-z][A-Za-z0-9]*)":/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(10);

    const src = readFileSync(resolve(ROOT, 'packages/skills/src/article-meta.ts'), 'utf8');
    const mapSection = src.slice(src.indexOf('const FIELD_MAP'), src.indexOf('};', src.indexOf('const FIELD_MAP')));
    const mapped = new Set([...mapSection.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]!));

    const missing = keys.filter((k) => !mapped.has(k));
    expect(missing, `提示词模板里的这些键未在 FIELD_MAP 中登记：${missing.join(', ')}`).toEqual([]);
  });
});
