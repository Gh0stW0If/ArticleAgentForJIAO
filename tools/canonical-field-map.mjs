// tools/canonical-field-map.mjs — 金标准字段 → 规范 JSON 键
//
// 为什么需要显式映射表：
//   金标准的中文表头不适合直接当 JSON 键（不稳定、难写代码、易错）。
//   这里把它们映射成稳定的英文键，并作为【唯一真源】供提示词生成与 SKILL 使用。
//
// 字段清单直接来自对 Datas/label/*.xlsx 的实测（见 build/legend/_merged.json）。
// 若检测到 extractor 产出了本表未覆盖的字段，生成器会报错而不是静默漏掉。

/** 文章级（Sheet1 的文章字段 + Sheet2）。 */
export const ARTICLE_FIELDS = [
  // ---- 抽取质控（金标准有，但不作为 LLM 抽取目标：由流程/人工填写） ----
  { key: 'literatureNo', label: '文献编号', comment: 'B2', source: 'gold_meta', desc: '金标准内部编号。英文文献形如 EN001，中文文献形如 CH001。由数据集分配，不由 LLM 推断。' },
  { key: 'extractor', label: '提取人姓名', source: 'gold_meta', desc: '提取执行人。由流程记录，不由 LLM 推断。' },
  { key: 'outliersInfluential', label: 'outliers and influential observations', comment: 'D1', source: 'comments', codes: { '1': 'overall', '2': 'pain', '3': 'non-pain', '4': 'function', '0': 'no OI' }, desc: '该研究属于哪一类分析对象（整体/疼痛/非疼痛/功能/无重要结局）。' },
  // ~~eligibilityCheck（复核合格标准，Sheet1 F 列）~~ —— 已按 202609 规则退役，见 RETIRED_FIELDS。

  // ---- 文献计量 ----
  { key: 'title', label: '题目', source: 'llm', desc: '论文标题，照抄原文（含副标题）。不要翻译、不要改标点。' },
  { key: 'publicationYear', label: '发表年份', source: 'llm', desc: '论文正式发表年份（4 位数字）。注意不是语料目录年份。' },
  { key: 'language', label: '文献语言', source: 'llm', desc: '正文语言。填 English、Chinese 等。' },
  { key: 'journal', label: '期刊名称', comment: 'J2', source: 'llm', desc: '论文中显示的期刊名称（照抄）。' },
  {
    key: 'journalClass', label: '期刊分类', comment: 'K2', source: 'llm',
    codes: { '1': '补充替代医学期刊', '2': '非补充替代医学期刊' },
    requirement: '英文期刊需查询附录1-补充替代医学期刊清单；若是选 1，若不是选 2。中文期刊：所有中医药类期刊都是补充替代医学期刊；非中医药类期刊都不是。',
    desc: '期刊是否属于补充替代医学期刊。',
  },
  {
    key: 'impactFactor2019', label: '2019影响因子', comment: 'L2', source: 'gold_meta',
    desc: '2019 年影响因子。**由程序查 Datas/IF-SCI-2019.xlsx（JCR 2019 SCIE 全刊表）得到，不由模型推断**——'
      + '论文里根本没有这个数，让模型凭记忆答实测 224 篇错 172 篇。'
      + '表里查不到 = 该刊 2019 年未进 SCIE（中文刊、ESCI 刊都在此列）→ 按工作表口径填 0。',
  },
  { key: 'firstAuthor', label: '第一作者姓名', source: 'llm', desc: '第一作者姓名（原文写法）。' },
  { key: 'authorContact', label: '作者联系方式', comment: 'N2', source: 'llm', desc: '按优先顺序取一位作者的邮箱：1) 通讯作者 2) 第一作者 3) 未报告填 NR。' },

  // ---- 资金与注册 ----
  { key: 'funding1', label: '资金1', comment: 'O2', source: 'llm', codes: { '1': '有', '2': '未报告' }, desc: '是否有资金支持。' },
  { key: 'funding2', label: '资金2', comment: 'P2', source: 'llm', codes: { '1': '国家级', '2': 'foundation(基金会)', '3': '省市级', '4': '院校级', '5': 'industry（企业）', '6': '其他', '7': '未报告' }, desc: '资金类型。' },
  { key: 'registrationReported', label: '文章是否报告注册号', comment: 'Q2', source: 'llm', codes: { '1': '是', '2': '否' }, desc: '文章是否报告了试验注册号。' },
  { key: 'registrationIds', label: '(注册号原文)', source: 'llm', desc: '注册号原文，如 ISRCTN60217348、NCT03391986、ChiCTR-10R-14005249。多个用逗号分隔；未报告填 NR。' },

  // ---- 疾病与地区 ----
  { key: 'condition', label: '疾病名称', comment: 'R2', source: 'llm', desc: '标题或纳入标准中的疾病名称，照抄原文。' },
  {
    key: 'conditionSystem', label: '疾病系统', comment: 'S2', source: 'llm',
    codes: {
      '1': '肌肉骨骼和结缔组织疾病', '2': '神经系统', '3': '消化系统', '4': '泌尿生殖系统',
      '5': '精神、行为障碍', '6': '怀孕、分娩和围产期', '7': '皮肤疾病', '8': '呼吸系统',
      '9': '睡眠-觉醒障碍', '10': '循环系统', '11': '眼相关疾病', '12': '内分泌和营养代谢疾病',
      '13': '肿瘤', '14': '病毒性疾病', '15': '损伤', '16': '耳和乳突疾病',
      '17': '针刺麻醉', '18': '围生期',
    },
    requirement: '可参考「附录3-疾病系统分类」，也可参考 ICD-11。',
    desc: '疾病所属系统分类。',
  },
  { key: 'acuteOrSurgery', label: '是否跟手术和操作相关或急性发作性疾病', comment: 'T2', source: 'llm', codes: { '1': '是（episodic）', '2': '否（chronic）' }, desc: '疾病是否与手术操作相关或属急性发作性。' },
  { key: 'country', label: '国家', comment: 'U2', source: 'llm', desc: '招募患者的试验中心所在国家（照抄原文）。' },
  {
    key: 'countryClass', label: '国家分类', comment: 'V2', source: 'llm',
    codes: { '1': '东方：亚洲国家', '2': '西方：非亚洲国家', '3': '东西方都有' },
    requirement: '1=东方：亚洲国家；2=西方：非亚洲国家。多国试验若横跨东西方选 3。',
    desc: '试验中心所在国家的东西方归类。',
  },
  { key: 'trialCenterCount', label: '试验中心的数量', comment: 'W2', source: 'llm', desc: '开展 RCT 的医院/地点数量（填数字）。未报告填 NR。' },

  // ---- 标识 ----
  { key: 'doi', label: '(DOI)', source: 'llm', desc: '论文自身的 DOI（形如 10.1136/acupmed-2015-010950）。**不要填参考文献里的 DOI。**' },
];

/** 比较组级（Sheet1 每个 试验组/对照组 配对一行）。 */
export const COMPARISON_FIELDS = [
  { key: 'intervention', label: '干预方法名称', source: 'llm', desc: '试验组接受的干预（照抄原文，如 acupuncture+usual pharmacological treatment）。' },
  { key: 'control', label: '对照组名称', source: 'llm', desc: '对照组接受的干预（照抄原文）。' },
  { key: 'controlType', label: '对照组类型', comment: 'Z2', source: 'llm', codes: { '1': '空白对照或等待组', '2': '非刺入假针刺', '3': '刺入假针刺', '4': '非针刺假针', '5': '假针+其他疗法', '6': '其他' }, desc: '对照组的对照形式。' },
  { key: 'controlTypeConverted', label: '对照组类型转换', comment: 'AA2', source: 'llm', codes: { '1': 'Penetrating needle sham', '2': 'Non-penetrating needle sham', '3': 'Non-needle sham', '4': 'High-intensity control(No sham)', '5': 'usual care control(No sham)', '6': 'Low-intensity control(No sham)' }, desc: '对照组的国际分类（可多选，如 2/5）。' },
  { key: 'comparisonType', label: '比较类型', comment: 'AB2', source: 'llm', codes: { '1': '针刺vs空白对照/等待组', '2': '针刺vs假针/安慰针', '3': '针刺+其他疗法vs其他疗法', '4': '针刺+其他疗法vs假针/安慰针+其他疗法' }, desc: '本组比较的类型。' },

  { key: 'randomizationMethod', label: '随机序列产生方法', comment: 'AC2', source: 'llm', desc: '随机序列产生的具体方法原文描述；未报告填 NR。' },
  { key: 'randomizationClass', label: '随机序列产生方法分类', comment: 'AD2', source: 'llm', codes: { '1': '随机数字表', '2': '计算机随机', '3': '抽签', '4': '掷骰子', '5': '抛硬币', '6': '洗牌/信封', '7': '最小化', '8': '未报告', '9': '其他' }, desc: '随机方法的分类编码。' },
  { key: 'allocationConcealment', label: '分配隐藏方法', comment: 'AE2', source: 'llm', desc: '分配隐藏的具体方法原文；未报告填 NR。' },
  { key: 'allocationClass', label: '分配隐藏方法分类', comment: 'AF2', source: 'llm', codes: { '1': '中心隐藏（电话、网站）', '2': '不透光密封信封', '3': '密封信封', '4': '不透光信封', '5': '未报告', '6': '其他' }, desc: '分配隐藏的分类编码。' },
  { key: 'stratificationBlocking', label: '分层或区组随机', comment: 'AG2', source: 'llm', codes: { '0': '无', '1': '分层/stratification', '2': '区组/block randomization', '3': '分层区组' }, desc: '是否分层或区组随机。' },
  { key: 'blindingParticipants', label: '盲研究对象', comment: 'AH2', source: 'llm', codes: { '1': '是', '2': '否', '3': '未报告' }, desc: '研究对象是否设盲。' },
  { key: 'blindingOutcomeAssessor', label: '盲结局评价者', comment: 'AI2', source: 'llm', codes: { '1': '是', '2': '否', '3': '未报告' }, desc: '结局评价者是否设盲。' },
  { key: 'patientExpectation', label: '患者期望值', comment: 'AJ2', source: 'llm', desc: '文中报告的患者期望值（数值或相关描述）；未报告填 NR。' },
  { key: 'practitionerCommunication', label: '特定的医患交流', comment: 'AK2', source: 'llm', codes: { '1': '是(研究人员允许或鼓励医患交流)', '2': '否(禁止进行医患交流)', '3': '未报告（文中未提及）' }, desc: '研究是否允许/鼓励医患交流。' },

  { key: 'practitionerYears', label: '操作者从事针灸实践时间', comment: 'AL2', source: 'llm', desc: '操作者从业年数（按年填数字）；未报告填 NR。' },
  { key: 'practitionerEducation', label: '针灸师教育或培训分类', comment: 'AM2', source: 'llm', codes: { '1': '中医药或针灸专业教育（学历教育）', '2': '短期培训（非学历教育）', '3': '未报告' }, desc: '操作者受训类型。' },
  { key: 'practitionerSpecialty', label: '操作者临床专业', comment: 'AN2', source: 'llm', codes: { '1': '针灸师', '2': '其他', '3': '未报告' }, desc: '操作者专业背景。' },
  { key: 'acupunctureType', label: '针刺治疗类型', comment: 'AO2', source: 'llm', codes: { '1': '中医针刺', '2': '日本医学针刺', '3': '韩国韩医针刺', '4': '西医针刺', '5': '五行针刺', '6': '头针', '7': '耳针', '8': '干针', '9': '未报告' }, desc: '针刺的医学体系类型。' },
  { key: 'stimulationType', label: '刺激类型', comment: 'AP2', source: 'llm', codes: { '1': '手针', '2': '电针', '3': '激光针', '4': 'TEAS（transeutaneous electrical acupoint stimulation）', '5': '穴位按压' }, desc: '刺激方式。' },
  { key: 'pointSelection', label: '选穴方案', comment: 'AQ2', source: 'llm', codes: { '1': '固定方案', '2': '加减方案', '3': '个体化方案', '4': '未报告' }, desc: '选穴方案的灵活性。' },
  { key: 'pointLocationClass', label: '选穴分类', comment: 'AR2', source: 'llm', codes: { '1': '局部', '2': '远端', '3': '都有' }, desc: '取穴部位。若为非体针类型填 NA。' },
  { key: 'protocolSource', label: '治疗方案来源分类', comment: 'AS2', source: 'llm', codes: { '1': '专家共识', '2': '教材或文献', '3': '临床经验', '4': '多种来源', '5': '未报告' }, desc: '治疗方案的理论来源。' },
  { key: 'frequencyDesc', label: '治疗频次描述（标明单位）', comment: 'AT2', source: 'llm', desc: '治疗频次的原文描述，如 one per week。未报告填 NR。' },
  { key: 'frequencyValue', label: '治疗频次数值', comment: 'AU2', source: 'llm', desc: '频次数值（如 2~3 填 2~3）。' },
  { key: 'frequencyUnit', label: '治疗频次单位', comment: 'AV2', source: 'llm', codes: { '1': '天', '2': '周', '3': '1小时' }, desc: '频次的时间单位。' },
  // ~~frequencyClass（治疗频次分类，Sheet1 AW 列）~~ —— 已按 202609 规则退役，见 RETIRED_FIELDS。
  { key: 'courseDesc', label: '疗程', comment: 'AX2', source: 'llm', desc: '疗程原文描述，如 9 weeks。未报告填 NR。' },
  { key: 'courseValue', label: '疗程数值', comment: 'AY2', source: 'llm', desc: '疗程数值。' },
  { key: 'courseUnit', label: '疗程单位', comment: 'AZ2', source: 'llm', codes: { '1': '天', '2': '周' }, desc: '疗程的时间单位。' },
  { key: 'totalSessions', label: '治疗总次数', comment: 'BA2', source: 'llm', desc: '治疗总次数（以次为单位的数值，如 18）。未报告填 NR。' },
  { key: 'deqi', label: '得气', comment: 'BD2', source: 'llm', codes: { '1': '是', '2': '否', '3': '未报告', '4': '不适用（TEAS、激光针）' }, desc: '是否报告得气。' },
  { key: 'insertionDepthText', label: '进针深度', comment: 'BE2', source: 'llm', desc: '进针深度的原文描述；未报告填 NR；不适用（穴位按压/TEAS/激光针）填 NA。' },
  { key: 'insertionDepthClass', label: '进针深度分类', comment: 'BF2', source: 'llm', codes: { '1': '深刺（≥10mm）', '2': '浅刺（<10mm）', '3': '未报告', '4': '不适用（穴位按压、TEAS、激光针）' }, desc: '进针深度分档。' },
  { key: 'stimulationIntensity', label: '刺激强度', comment: 'BG2', source: 'llm', codes: { '1': '强刺激', '2': '中等刺激', '3': '弱刺激', '4': '未报告' }, requirement: '填写文章报告的刺激强度。', desc: '刺激强度分档。' },
  { key: 'needleRetentionDesc', label: '留针时间', comment: 'BH2', source: 'llm', desc: '留针时间数值（分钟）。未报告填 NR。' },
  { key: 'needleRetentionValue', label: '留针时间数值', comment: 'BI2', source: 'llm', desc: '留针时间数值。' },
  { key: 'needleRetentionUnit', label: '留针时间单位', comment: 'BJ2', source: 'llm', codes: { '1': '分钟', '2': '小时' }, desc: '留针时间单位。' },
  { key: 'needleCountText', label: '针的数目（腧穴）', comment: 'BL2', source: 'llm', desc: '用针数目的原文描述；无法计算时提取原文；TEAS/激光针/穴位按压填 NA。' },
  { key: 'needleCountMin', label: '使用最少针数目', comment: 'BM2', source: 'llm', desc: '最少用针数目（数值）。' },
  { key: 'postInsertionManipulation', label: '进针后针刺操作分类', comment: 'BN2', source: 'llm', codes: { '1': '有', '2': '无', '3': '未报告', '4': '不适用（穴位按压、TEAS、激光针）' }, desc: '进针后是否有提插捻转等操作。' },
  { key: 'needleAngleClass', label: '针刺角度分类', comment: 'BO2', source: 'llm', codes: { '1': '报告', '2': '未报告', '3': '不适用（穴位按压、TEAS、激光针）' }, desc: '是否报告针刺角度。' },
  { key: 'needleDirectionClass', label: '针刺方向分类', comment: 'BP2', source: 'llm', codes: { '1': '报告', '2': '未报告', '3': '不适用（穴位按压、TEAS、激光针）' }, desc: '是否报告针刺方向。' },
  { key: 'maxFollowupDesc', label: '最长随访时间', comment: 'BQ2', source: 'llm', desc: '最长随访时间原文描述；未报告填 NR。' },
  { key: 'maxFollowupValue', label: '最长随访时间数值', comment: 'BR2', source: 'llm', desc: '随访时间数值。' },
  { key: 'maxFollowupUnit', label: '最长随访时间单位', comment: 'BS2', source: 'llm', codes: { '1': '天', '2': '月', '3': '年', '4': '周', '5': '小时' }, desc: '随访时间单位。' },
  { key: 'sexDistribution', label: '性别（男/女）', comment: 'BT2', source: 'llm', desc: '两组性别分布。若不分组报告，总体数量填在第一格，其余填 NA；未报告填 NR。' },
  { key: 'typeOfData', label: '数据类型', comment: 'BV2', source: 'llm', codes: { '1': '均值±标准差', '2': '范围' }, desc: '基线年龄/连续数据的报告形式。' },
  { key: 'priorAcupuncture', label: '受试者既往是否接受过针刺治疗', comment: 'CA2', source: 'llm', codes: { '1': '是', '2': '否', '3': '未报告' }, desc: '既往针刺史。' },
  { key: 'randomizedN', label: '随机样本量', comment: 'CD2', source: 'llm', desc: '试验组随机例数+对照组随机例数（总随机例数）。' },
  { key: 'analyzedN', label: '主要结局时点样本量', comment: 'CE2', source: 'llm', desc: '主要结局采集时点的分析样本量。' },
  { key: 'dropoutTotal', label: '主要结局脱落总人数', comment: 'CI2', source: 'llm', desc: '两组脱落人数之和。' },
  { key: 'missingDataRatio', label: '缺失数据比例', comment: 'CJ2', source: 'llm', desc: '缺失比例 = 缺失人数 / 随机人数。' },
  { key: 'missingDataReported', label: '是否报告了缺失数据(主要结局)', comment: 'CK2', source: 'llm', codes: { '1': 'Yes, state MPD occur (in the main text or in CONSORT flow diagram)', '2': 'Yes, state MPD did not occur (in the main text or in CONSORT flow diagram)', '3': 'No explicit statement' }, desc: '是否明确说明主要结局缺失数据情况。' },
  { key: 'primaryAnalysis', label: 'primary analysis', comment: 'CL2', source: 'llm', codes: { '1': 'Analysis described as intention to treat（含 modified ITT）', '2': 'Analyzed participants for whom outcome data were available in group to which they were randomized', '3': 'Per protocol analysis', '4': 'No explicit statement' }, requirement: '⚠️ 取值表共 4 项；只在论文完全没有交代分析人群时才填 4=No explicit statement。', desc: '主要分析人群。金标准按此 4 值编码。' },
  {
    key: 'missingDataHandling', label: '主要分析中，如何处理缺失数据', comment: 'CM2', source: 'llm',
    codes: {
      '1': 'Data deletion method1 (Complete case analysis)', '2': 'Data deletion method 2 (All available data analysis)',
      '3': 'Mean imputation', '4': 'Last Observation Carrying Forward (LOCF)', '5': 'Regression for MPD',
      '6': 'Multiple imputation (MI)', '7': 'Maximum Likelihood (ML) for MPD', '8': 'Weighting method for MPD',
      '9': 'Combination of more than one method above for MPD', '10': 'Mixed effect model for missing data',
      '11': 'Other, please specify', '12': 'No missing data', '13': 'No explicit statement',
    },
    requirement: '⚠️ 取值表共 13 项（来自单元格批注 CM2）。实测金标准里出现最多的是 13=No explicit statement（119 次）与 12=No missing data（56 次），务必按表选择。',
    desc: '主要分析中如何处理缺失数据。金标准按此 13 值编码。',
  },

  /*
   * ===== 分组字段（试验组 / 对照组各一列）=====
   *
   * ⚠️ 键名沿用了金标准的列名，而金标准的列名与它自己的批注**对不上**——实测（见 tools/field_coverage.mjs
   * 与 docs/08-llm-integration.md）：原始表格里「试验组/对照组」这组表头重复出现 4 次，
   * 归一化时按出现顺序命名，但每一列真正的语义写在它的批注里：
   *
   *   列（金标准键）                        批注（=真实语义）
   *   sex_experimental / sex_control        性别（男/女）
   *   prior_acupuncture_experimental/…      随机例数（治疗前例数）      ← 与键名不符
   *   randomized_n_experimental / …         主要结局时点样本量          ← 与键名不符
   *   analyzed_n_experimental / …           脱落人数                    ← 与键名不符
   *
   * 因此这里**保留金标准键名**（否则评测无法对齐），但把批注语义写进 desc —— 模型按 desc 抽取，
   * 评测按同名对齐。要彻底修正需要同时改金标准与规范清单，属未决事项。
   */
  { key: 'sexExperimental', label: '试验组性别（男/女）', source: 'llm', desc: '试验组的性别分布，按「男/女」填写（如 0/80）。不分组报告时填在试验组一列、对照组填 NA；未报告填 NR。' },
  { key: 'sexControl', label: '对照组性别（男/女）', source: 'llm', desc: '对照组的性别分布，按「男/女」填写。' },
  { key: 'priorAcupunctureExperimental', label: '试验组随机例数', source: 'llm', desc: '试验组的随机例数（治疗前例数）。⚠️ 键名沿用金标准列名 prior_acupuncture_experimental，但该列批注为「随机例数（治疗前例数）」，按批注抽取。未报告填 NR。' },
  { key: 'priorAcupunctureControl', label: '对照组随机例数', source: 'llm', desc: '对照组的随机例数（治疗前例数）。未报告填 NR。' },
  { key: 'randomizedNExperimental', label: '试验组主要结局时点样本量', source: 'llm', desc: '试验组在**主要结局采集时点**的样本量。⚠️ 键名沿用金标准列名 randomized_n_experimental，但该列批注为「主要结局时点样本量」，按批注抽取。未报告填 NR。' },
  { key: 'randomizedNControl', label: '对照组主要结局时点样本量', source: 'llm', desc: '对照组在主要结局采集时点的样本量。未报告填 NR。' },
  { key: 'analyzedNExperimental', label: '试验组脱落人数', source: 'llm', desc: '试验组的脱落人数。⚠️ 键名沿用金标准列名 analyzed_n_experimental，但该列批注为「脱落人数」，按批注抽取。未报告填 NR。' },
  { key: 'analyzedNControl', label: '对照组脱落人数', source: 'llm', desc: '对照组的脱落人数。未报告填 NR。' },
  { key: 'baselineCatExperimentalNeg', label: '试验组基线值（-）', source: 'llm', desc: '基线连续变量（如年龄）在试验组的取值。列标题为「试验组-」，其语义由同段「数据类型」列（typeOfData）的图例决定。未报告填 NR。' },
  { key: 'baselineCatExperimentalPos', label: '试验组基线值（+）', source: 'llm', desc: '基线连续变量在试验组的另一侧取值（列标题「试验组+」）。若原文只有一个数值，本列省略或填 NA。' },
  { key: 'baselineCatControlNeg', label: '对照组基线值（-）', source: 'llm', desc: '基线连续变量（如年龄）在对照组的取值。未报告填 NR。' },
  { key: 'baselineCatControlPos', label: '对照组基线值（+）', source: 'llm', desc: '基线连续变量在对照组的另一侧取值（列标题「对照组+」）。只有一个数值时省略或填 NA。' },
  // ~~needleRetentionClass（留针时间分类，Sheet1 BK 列）~~、
  // ~~totalSessionsClassA / totalSessionsClassB（治疗总次数分类，Sheet1 BB/BC 列）~~
  // —— 三个 *_class 字段已按 202609 规则退役，见 RETIRED_FIELDS。
];

/** Sheet2 的文章级结局分类（值为描述文本）。 */
export const STUDY_OUTCOME_FIELDS = [
  { key: 'primaryOutcome', label: '主要结局或第1个出现的患者重要结局', source: 'llm', desc: '主要结局（或第一个出现的患者重要结局）的名称与测量工具。' },
  { key: 'outcomePain', label: '疼痛类', source: 'llm', desc: '疼痛类结局的名称/工具。未报告填 NR。' },
  { key: 'outcomeNonPain', label: '非疼痛症状类结局', source: 'llm', desc: '非疼痛症状类结局。未报告填 NR。' },
  { key: 'outcomeFunction', label: '功能类结局', source: 'llm', desc: '功能类结局。未报告填 NR。' },
  { key: 'outcomeQualityOfLife', label: '生活质量类结局', source: 'llm', desc: '生活质量类结局。未报告填 NR。' },
  { key: 'outcomeImportantEvents', label: '重要事件类结局', source: 'llm', desc: '重要事件类结局（如死亡、复发）。未报告填 NR。' },
  { key: 'outcomeMortality', label: '死亡率', source: 'llm', desc: '死亡率相关数据。未报告填 NR。' },
  {
    key: 'outcomeRemarks', label: '备注', source: 'llm',
    desc: '结局分类的备注。**没有特别要说明的就填 `NR`**——实测金标准这一列在已比对年份里'
      + '全部写的是 NR，而机器此前完全没有输出该列，52 处全被判"漏"。',
  },
];

/**
 * 结局级（Sheet3）：按「时点块」组织，避免 152 个平铺键。
 * 与 build/gold 的结构一致（见 docs/02-gold-schema.md）。
 */
export const OUTCOME_TOP_FIELDS = [
  { key: 'literatureCode', label: '文献编号(带结局序号)', code: 'STUDYID', source: 'gold_meta', desc: '形如 EN009-1 的文献编号+结局序号。由编号规则推导，不从 PDF 抽取（PDF 里根本不存在该编号）。' },
  { key: 'armNumber', label: '研究组别的数量', code: 'ARMNU', source: 'gold_meta', codes: { '1': '双臂', '2': '多臂', '3': '多试验组', '4': '多对照组' }, desc: '本研究涉及的组别结构。**由比较组数量确定性推导**（1 个比较组=双臂，≥2 个=多臂），不由模型推断。' },
  // ~~specialDataFlag（特殊数据情况，Sheet3 E 列）~~ —— 已按 202609 规则退役，见 RETIRED_FIELDS。
  { key: 'construct', label: 'construct', code: 'CONST', comment: 'F1', source: 'llm', codes: { '1': 'Pains', '2': 'Other symptoms excluding pains', '3': 'Functions', '4': 'Quality of Life', '5': 'Major events', '6': 'primary outcomes' }, desc: '结局所属的 construct 大类。' },
  {
    key: 'subconstruct', label: 'subconstruct', code: 'SUBCONST', comment: 'G1', source: 'llm',
    /*
     * ⚠️ 这张表来自 Sheet3 的 SUBCONST 图例（build/legend/_merged.json）。
     * 之前这里**没有 codes**、只写"取值见批注"，于是模型无表可选 → 2015 年 16 组结局全部答 NR，
     * 语义判定里 `subconstruct_code` 的加权得分因此是 **0%**（实测最差字段）。
     */
    codes: {
      '1': 'All Major events', '2': 'Musculoskeletal functions', '3': 'Nerve functions',
      '4': 'Mental, behavioural or neurodevelopmental disorders',
      '5': 'Postoperative gastrointestinal functions', '6': 'Postoperative urinary function',
      '7': 'Other functions', '8': 'Respiratory system',
      '9': 'Eye, ear, nose and throat system disorders', '10': 'The circulatory system',
      '11': 'Skin symptoms', '12': 'The perinatal period',
      '13': 'Other symptoms which are difficult to be classified',
    },
    requirement: '⚠️ 必须填上表编码（1~13），不要填英文/中文含义；确实无法归类时才填 13。',
    desc: '更细的结局子类（按系统的功能/症状分类）。',
  },
  { key: 'pValueRange', label: 'P值', code: 'PVALRAG', comment: 'H1', source: 'llm', codes: { '1': 'P<0.05', '2': 'P>0.05' }, desc: 'P 值所属区间。' },
  { key: 'pValue', label: 'P值数值', code: 'PVALNUM', source: 'llm', desc: 'P 值具体数值（如 0.001）。未报告填 NR。' },
  { key: 'outcomeName', label: '结局名称', code: 'OUTCOM', source: 'llm', desc: '结局名称（照抄原文）。' },
  { key: 'instrument', label: '测量工具名称', code: 'INSTRU', source: 'llm', desc: '测量工具/量表名称（如 VAS、SF-12、HDRS）。' },
  { key: 'measurementRange', label: '测量范围', code: 'RANGE', comment: 'L3', source: 'llm', desc: '量表的取值范围（如 0-100）。如报告请填写；不适用填 NA；未报告填 NR。' },
  { key: 'measurementDirection', label: '测量方向', code: 'MDIRE', comment: 'M3', source: 'llm', codes: { '1': '数值越大，结果越好', '0': '数值越小，结果越好' }, desc: '量表方向。' },
  { key: 'measurementUnit', label: '测量单位', code: 'MUNIT', source: 'llm', desc: '测量单位（如 分、人、mm）。无单位填 NA。' },
  { key: 'measurementType', label: '测量类型', code: 'MTYPE', comment: 'O1', source: 'llm', codes: { '1': '估计值', '2': '组间差值', '3': '发生事件数', '4': 'OR', '5': 'RR', '6': 'RD', '7': 'HR', '8': '等级资料' }, desc: '数值的报告形式。' },
  { key: 'baselineAdjusted', label: '基线是否调整', code: 'IFADJ', comment: 'P1', source: 'llm', codes: { '1': '是', '2': '否', '3': '不清楚' }, desc: '分析是否对基线做了调整。' },
  { key: 'primaryOutcomeTimepoint', label: '主要结局测量时点', code: 'POTIMPO', comment: 'Q1', source: 'llm', codes: { '0': '非主要结局', '1': '治疗结束后', '2': '随访', '3': '治疗结束后和随访都有', '4': '未报告' }, desc: '该结局的测量时点相对主要结局的关系。' },

  // ---- 该结局的随访时间（与比较组的「最长随访时间」分开记录，两者可能不同）----
  { key: 'followUpDescription', label: '本结局随访时间描述', source: 'llm', desc: '本结局最后一次测量时间的原文描述（如 42 weeks）。未报告填 NR。' },
  { key: 'followUpValue', label: '本结局随访时间数值', source: 'llm', desc: '随访时间数值。' },
  { key: 'followUpUnit', label: '本结局随访时间单位', source: 'llm', codes: { '1': '天', '2': '月', '3': '年', '4': '周', '5': '小时' }, desc: '随访时间单位。' },
];

/** 时点块内的字段（前缀 B=基线 / E=疗程结束 / F=随访结束）。 */
export const TIMEPOINT_FIELDS = [
  { key: 'estimateType', code: 'TESTI', comment: 'S3', source: 'llm', codes: { '1': '均数', '2': '中位数', '3': '组内差值' }, desc: '估计值类型。' },
  {
    key: 'varianceType', code: 'TVARI', comment: 'T3', source: 'llm',
    codes: { '1': '标准误（SE）', '2': '95%可信区间（CI）', '3': '标准差（SD）', '4': '四分位间距（IQR）', '5': '全距（range）', '6': 'P值', '7': 'QR' },
    requirement: '注意：1) 报告多个者只选 1 个；2) 按上述顺序依次优选。例如同时报告 SE 和 95%CI，只提取 SE。',
    desc: '变异值的类型。',
  },
  { key: 'experimentalEstimate', code: 'IESTI', source: 'llm', desc: '试验组估计值。' },
  { key: 'experimentalCiLower', code: 'ILVARI', source: 'llm', desc: '试验组变异值下限。' },
  { key: 'experimentalCiUpper', code: 'IUVARI', source: 'llm', desc: '试验组变异值上限。' },
  { key: 'experimentalN', code: 'NINTE', source: 'llm', desc: '试验组例数。' },
  { key: 'controlEstimate', code: 'CESTI', source: 'llm', desc: '对照组估计值。' },
  { key: 'controlCiLower', code: 'CLVARI', source: 'llm', desc: '对照组变异值下限。' },
  { key: 'controlCiUpper', code: 'CUVARI', source: 'llm', desc: '对照组变异值上限。' },
  { key: 'controlN', code: 'NCONT', source: 'llm', desc: '对照组例数。' },

  /*
   * ===== 二分类结局（binary）=====
   * 全语料实测：binary 块里的键只有 experimental{events,n} / control{events,n} /
   * difference_estimate / difference_ci_lower / difference_ci_upper。
   * 只适用于「事件数/人数」型结局（如有效/无效、发生/未发生）。
   */
  { key: 'experimentalEvents', source: 'llm', desc: '【二分类】试验组发生事件的人数。' },
  { key: 'controlEvents', source: 'llm', desc: '【二分类】对照组发生事件的人数。' },
  { key: 'differenceEstimate', source: 'llm', desc: '【二分类/组间】组间差值（率差或均值差）的估计值。' },
  { key: 'differenceCiLower', source: 'llm', desc: '【二分类/组间】组间差值的 95%CI 下限。' },
  { key: 'differenceCiUpper', source: 'llm', desc: '【二分类/组间】组间差值的 95%CI 上限。' },

  /*
   * ===== 等级资料（categorical）=====
   * 只适用于被当作等级资料报告的结局（如疗效等级 治愈/显效/有效/无效）。
   */
  { key: 'classificationMethod', source: 'llm', desc: '【等级资料】等级划分方法的原文描述（如 治愈/显效/有效/无效）。' },
  { key: 'cat1Experimental', source: 'llm', desc: '【等级资料】试验组第 1 等级人数。' },
  { key: 'cat2Experimental', source: 'llm', desc: '【等级资料】试验组第 2 等级人数。' },
  { key: 'cat3Experimental', source: 'llm', desc: '【等级资料】试验组第 3 等级人数。' },
  { key: 'cat4Experimental', source: 'llm', desc: '【等级资料】试验组第 4 等级人数。' },
  { key: 'cat5Experimental', source: 'llm', desc: '【等级资料】试验组第 5 等级人数。' },
  { key: 'cat6Experimental', source: 'llm', desc: '【等级资料】试验组第 6 等级人数。' },
  { key: 'cat1Control', source: 'llm', desc: '【等级资料】对照组第 1 等级人数。' },
  { key: 'cat2Control', source: 'llm', desc: '【等级资料】对照组第 2 等级人数。' },
  { key: 'cat3Control', source: 'llm', desc: '【等级资料】对照组第 3 等级人数。' },
  { key: 'cat4Control', source: 'llm', desc: '【等级资料】对照组第 4 等级人数。' },
  { key: 'cat5Control', source: 'llm', desc: '【等级资料】对照组第 5 等级人数。' },
  { key: 'cat6Control', source: 'llm', desc: '【等级资料】对照组第 6 等级人数。' },
];

/**
 * ===== 已退役字段（202609 规则）=====
 *
 * 来源：`Datas/design/文章计划 整理 202609/03 第一篇 第一次提取excel的3个sheet3说明.docx`
 * 的「规则类别归并」：
 *
 *   - Sheet1：删除（5 列）E、F、AW、BB、BC；另 AW / BB / BC / **BK** 在逐行表格里标注
 *     「不要了 / 删除」。逐行表格给 6 列，汇总列表写 5 列（漏掉 BK）——
 *     实测口径以逐行表格为准，**6 列全删**（已与需求方确认）。
 *   - Sheet3：删除 E（特殊数据情况）、R（结局特殊类别）。
 *
 * 退役的含义：**既不再抽取，也不参与评测**。
 *   1. 不在这里的字段清单里 → 提示词不会要求模型输出（prompt_gen 只认上面的数组）；
 *   2. `tools/gold_schema.mjs` 同步删除对应金标准字段 → 评测不再把它们计入分母。
 * 否则「金标准里有、我们不再抽」会被判成漏抽，白白拉低准确率。
 *
 * ⚠️ 原始表格 `Datas/label/*.xlsx` 里的这些列**依然存在**，我们不改数据；
 * 只是提取与评分不再覆盖它们。列字母为 2015–2019 版布局（2020 起整体左移一列）。
 */
export const RETIRED_FIELDS = [
  { sheet: 'Sheet1', col: 'E', key: '(construct)', label: 'construct', reason: '规则明列删除；原本即未收录进金标准字段' },
  { sheet: 'Sheet1', col: 'F', key: 'eligibilityCheck', label: '复核合格标准', reason: '规则明列删除（原为 gold_meta，不由模型抽取）' },
  { sheet: 'Sheet1', col: 'AW', key: 'frequencyClass', label: '治疗频次分类', reason: '规则标「不要了」' },
  { sheet: 'Sheet1', col: 'BB', key: 'totalSessionsClassA', label: '治疗总次数治疗分类', reason: '规则标「不要了」' },
  { sheet: 'Sheet1', col: 'BC', key: 'totalSessionsClassB', label: '治疗总次数分类', reason: '规则标「不要了」（且该列无编码表，实测整列 0%）' },
  { sheet: 'Sheet1', col: 'BK', key: 'needleRetentionClass', label: '留针时间分类', reason: '逐行表格标「不要了」；汇总列表漏计，已确认按逐行执行' },
  { sheet: 'Sheet3', col: 'E', key: 'specialDataFlag', label: '特殊数据情况', reason: '规则明列删除' },
  { sheet: 'Sheet3', col: 'R', key: 'specialCategory', label: '结局特殊类别', reason: '规则明列删除；原本只在金标准里、未抽取' },
];

/**
 * 退役字段的规范键集合。
 *
 * 用途：**挡住旧抽取产物里的遗留字段**。
 * 本次是"只改代码、没重跑抽取"，所以 `build/extraction/*` 里那些列还在；
 * 界面的兜底循环会把清单外的键原样显示出来（标题就是 `totalSessionsClassA`
 * 这种驼峰键），看起来像是"标题没对上原文"，其实是**已退役的残留**。
 * 退役是需求方明确定的，所以这里按规范键直接挡掉，而不是留着让人猜。
 */
export const RETIRED_KEYS = new Set(
  RETIRED_FIELDS.map((f) => f.key).filter((k) => /^[A-Za-z]/.test(k)),
);

/** LLM 不负责的字段来源说明。 */
export const SOURCE_LABELS = {
  llm: '由 LLM 从 PDF 抽取',
  gold_meta: '由数据集/流程填写（不由 LLM 推断）',
  comments: '取值依据单元格批注',
};
