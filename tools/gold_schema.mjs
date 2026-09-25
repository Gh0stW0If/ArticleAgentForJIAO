// tools/gold_schema.mjs — 规范 schema（唯一真源）
//
// ===== 设计依据（全部实测，见 build/gold_inspect/HEADERS.txt / _labelsets.json）=====
// 1. 2015–2025 全部年份字段名与顺序【完全一致】；2020 起表头整体右移 1 列（锚点 B→A）。
//    → 必须“按标签锚定”，不能硬编码列号。
// 2. Sheet3 的 152 个编码列（首 STUDYID、末 FRDCONUM）在所有年份逐列一致，
//    编码行 = 表头最后一行，锚点是 "STUDYID"。
// 3. Sheet1 的 试验组/对照组 段存在【重复标签】(各出现 4 次)，是分组表头
//    → 该段必须按“组内位置”映射，不能靠标签唯一匹配。
//
// ===== 三层粒度 =====
//   article      YYYY-NN      Sheet1 文章级 + Sheet2（每篇 1 行）
//   comparison   YYYY-NN-K    Sheet1 每行 = 一个 试验组/对照组 配对
//   outcome      YYYY-NN-K    Sheet3 每行 = 一个结局 × 时点

// ---------------------------------------------------------------------------
// Sheet3：151 个编码列，顺序实测（2015 与 2025 逐列一致）
// ---------------------------------------------------------------------------
export const SHEET3_COLUMNS = [
  'STUDYID','ARMNU','STDATA','CONST','SUBCONST','PVALRAG','PVALNUM','OUTCOM',
  'INSTRU','RANGE','MDIRE','MUNIT','MTYPE','IFADJ','POTIMPO','SPECO',
  // 基线期 B
  'BTESTI','BTVARI','BIESTI','BILVARI','BIUVARI','BNINTE','BCESTI','BCLVARI','BCUVARI','BNCONT',
  'BDEST','BDLVAR','BDUVAR','BINEVE','BINUM','BCNEVE','BCNUM',
  'BOR','BORCIL','BORCIU','BRR','BRRCIL','BRRCIU','BRD','BRDCIL','BRDCIU','BHR','BHRCIL','BHRCIU',
  'BRADACLA',
  'BRDINFRI','BRDINSEC','BRDINTHI','BRDINFOR','BRDINFIF','BRDINSIX','BRDINNUM',
  'BRDCOFRI','BRDCOSEC','BRDCOTHI','BRDCOFOR','BRDCOFIF','BRDCOSIX','BRDCONUM',
  // 疗程结束时 E
  'ETESTI','ETVARI','EIESTI','EILVARI','EIUVARI','ENINTE','ECESTI','ECLVARI','ECUVARI','ENCONT',
  'EDEST','EDLVAR','EDUVAR','EINEVE','EINUM','ECNEVE','ECNUM',
  'EOR','EORCIL','EORCIU','ERR','ERRCIL','ERRCIU','ERD','ERDCIL','ERDCIU','EHR','EHRCIL','EHRCIU',
  'ERADACLA',
  'ERDINFRI','ERDINSEC','ERDINTHI','ERDINFOR','ERDINFIF','ERDINSIX','ERDINNUM',
  'ERDCOFRI','ERDCOSEC','ERDCOTHI','ERDCOFOR','ERDCOFIF','ERDCOSIX','ERDCONUM',
  // 随访元信息
  'FOLTIM','FOLTIMN','FOLTIMU',
  // 随访结束时 F
  'FTESTI','FTVARI','FIESTI','FILVARI','FIUVARI','FNINTE','FCESTI','FCLVARI','FCUVARI','FNCONT',
  'FDEST','FDLVAR','FDUVAR','FINEVE','FINUM','FCNEVE','FCNUM',
  'FOR','FORCIL','FORCIU','FRR','FRRCIL','FRRCIU','FRD','FRDCIL','FRDCIU','FHR','FHRCIL','FHRCIU',
  'FRADACLA',
  'FRDINFRI','FRDINSEC','FRDINTHI','FRDINFOR','FRDINFIF','FRDINSIX','FRDINNUM',
  'FRDCOFRI','FRDCOSEC','FRDCOTHI','FRDCOFOR','FRDCOFIF','FRDCOSIX','FRDCONUM',
];

/** 顶层字段（非时点块）→ 规范 JSON 路径。
 *
 * 命名陷阱（实测）：Sheet3 的列名虽为 `STUDYID`，内容却是
 * 「文献编号 + 结局序号」（如 EN009-1），并非 YYYY-NN 形式的文章号。
 * 文章号在 Sheet3 的 A 列，由 normalizer 单独读取写入 article_id / row_id。
 */
export const SHEET3_TOP_MAP = {
  STUDYID: 'literature_code',
  ARMNU: 'arm_number',
  // STDATA（Sheet3 E 列「特殊数据情况」）已退役 —— 见 RETIRED_FIELDS
  CONST: 'outcome.construct_code',
  SUBCONST: 'outcome.subconstruct_code',
  PVALRAG: 'outcome.p_value_range',
  PVALNUM: 'outcome.p_value',
  OUTCOM: 'outcome.name',
  INSTRU: 'outcome.instrument',
  RANGE: 'outcome.measurement_range',
  MDIRE: 'outcome.measurement_direction',
  MUNIT: 'outcome.measurement_unit',
  MTYPE: 'outcome.measurement_type',
  IFADJ: 'outcome.baseline_adjusted',
  POTIMPO: 'outcome.primary_outcome_timepoint',
  // SPECO（Sheet3 R 列「结局特殊类别」）已退役 —— 见 RETIRED_FIELDS
  FOLTIM: 'follow_up.description',
  FOLTIMN: 'follow_up.value',
  FOLTIMU: 'follow_up.unit',
};

/** 时点块前缀 → 规范块名 + 中文标签。 */
export const TIMEPOINT_BLOCKS = {
  B: { name: 'baseline', label: '基线期' },
  E: { name: 'end_of_treatment', label: '疗程结束时' },
  F: { name: 'follow_up_end', label: '随访结束时（≥80%数据的最长时间点）' },
};

/** 块内编码键（去掉时点前缀）→ 块内 JSON 路径。 */
export const BLOCK_FIELD_MAP = {
  // 连续型结局
  TESTI: 'continuous.estimate_type',
  TVARI: 'continuous.variance_type',
  IESTI: 'continuous.experimental.estimate',
  ILVARI: 'continuous.experimental.ci_lower',
  IUVARI: 'continuous.experimental.ci_upper',
  NINTE: 'continuous.experimental.n',
  CESTI: 'continuous.control.estimate',
  CLVARI: 'continuous.control.ci_lower',
  CUVARI: 'continuous.control.ci_upper',
  NCONT: 'continuous.control.n',
  // 二分类结局
  DEST: 'binary.difference_estimate',
  DLVAR: 'binary.difference_ci_lower',
  DUVAR: 'binary.difference_ci_upper',
  INEVE: 'binary.experimental.events',
  INUM: 'binary.experimental.n',
  CNEVE: 'binary.control.events',
  CNUM: 'binary.control.n',
  OR: 'binary.or', ORCIL: 'binary.or_ci_lower', ORCIU: 'binary.or_ci_upper',
  RR: 'binary.rr', RRCIL: 'binary.rr_ci_lower', RRCIU: 'binary.rr_ci_upper',
  RD: 'binary.rd', RDCIL: 'binary.rd_ci_lower', RDCIU: 'binary.rd_ci_upper',
  HR: 'binary.hr', HRCIL: 'binary.hr_ci_lower', HRCIU: 'binary.hr_ci_upper',
  // 分类（等级资料）
  RADACLA: 'categorical.classification_method',
  DINFRI: 'categorical.experimental.cat1', DINSEC: 'categorical.experimental.cat2',
  DINTHI: 'categorical.experimental.cat3', DINFOR: 'categorical.experimental.cat4',
  DINFIF: 'categorical.experimental.cat5', DINSIX: 'categorical.experimental.cat6',
  DINNUM: 'categorical.experimental.n',
  DCOFRI: 'categorical.control.cat1', DCOSEC: 'categorical.control.cat2',
  DCOTHI: 'categorical.control.cat3', DCOFOR: 'categorical.control.cat4',
  DCOFIF: 'categorical.control.cat5', DCOSIX: 'categorical.control.cat6',
  DCONUM: 'categorical.control.n',
};

// ---------------------------------------------------------------------------
// Sheet1
// ---------------------------------------------------------------------------
/** 文章级字段。labels = 用于锚定列的标签（多别名以兼容年份变体）。 */
export const ARTICLE_FIELDS = [
  { key: 'literature_no', labels: ['文献编号'] },
  { key: 'extractor', labels: ['提取人姓名'] },
  { key: 'outliers_influential', labels: ['outliers and influential observations'] },
  // 已退役（202609 规则 Sheet1 F 列）——见 tools/canonical-field-map.mjs 的 RETIRED_FIELDS
  // { key: 'eligibility_check', labels: ['复核合格标准'] },
  { key: 'title', labels: ['题目'] },
  { key: 'publication_year', labels: ['发表年份'] },
  { key: 'language', labels: ['文献语言'] },
  { key: 'journal', labels: ['期刊名称'] },
  { key: 'journal_class', labels: ['期刊分类'] },
  { key: 'impact_factor_2019', labels: ['2019影响因子'] },
  { key: 'first_author', labels: ['第一作者姓名'] },
  { key: 'author_contact', labels: ['作者联系方式'] },
  { key: 'funding_1', labels: ['资金1'] },
  { key: 'funding_2', labels: ['资金2'] },
  { key: 'registration_reported', labels: ['文章是否报告注册号'] },
  { key: 'condition', labels: ['疾病名称'] },
  { key: 'condition_system', labels: ['疾病系统'] },
  { key: 'acute_or_surgery', labels: ['是否跟手术和操作相关或急性发作性疾病'] },
  { key: 'country', labels: ['国家'] },
  { key: 'country_class', labels: ['国家分类'] },
  { key: 'trial_center_count', labels: ['试验中心的数量', '试验中心'] },
];

/** 比较组级字段。重复标签段用 group+groupIndex。 */
export const COMPARISON_FIELDS = [
  { key: 'intervention', labels: ['干预方法名称'] },
  { key: 'control', labels: ['对照组名称'] },
  { key: 'control_type', labels: ['对照组类型'] },
  { key: 'control_type_converted', labels: ['对照组类型转换'] },
  { key: 'comparison_type', labels: ['比较类型'] },
  { key: 'randomization_method', labels: ['随机序列产生方法'] },
  { key: 'randomization_class', labels: ['随机序列产生方法分类'] },
  { key: 'allocation_concealment', labels: ['分配隐藏方法'] },
  { key: 'allocation_class', labels: ['分配隐藏方法分类'] },
  { key: 'stratification_blocking', labels: ['分层或区组随机'] },
  { key: 'blinding_participants', labels: ['盲研究对象'] },
  { key: 'blinding_outcome_assessor', labels: ['盲结局评价者'] },
  { key: 'patient_expectation', labels: ['患者期望值'] },
  { key: 'practitioner_communication', labels: ['特定的医患交流'] },
  { key: 'practitioner_years', labels: ['操作者从事针灸实践时间(单位：年，year)'] },
  { key: 'practitioner_education', labels: ['针灸师教育或培训分类'] },
  { key: 'practitioner_specialty', labels: ['操作者临床专业'] },
  { key: 'acupuncture_type', labels: ['针刺治疗类型'] },
  { key: 'stimulation_type', labels: ['刺激类型'] },
  { key: 'point_selection', labels: ['选穴方案'] },
  { key: 'point_location_class', labels: ['选穴分类'] },
  { key: 'protocol_source', labels: ['治疗方案来源分类'] },
  { key: 'frequency_desc', labels: ['治疗频次描述（标明单位）'] },
  { key: 'frequency_value', labels: ['治疗频次数值'] },
  { key: 'frequency_unit', labels: ['治疗频次单位'] },
  // 已退役（202609 规则 Sheet1 AW 列）——见 RETIRED_FIELDS
  // { key: 'frequency_class', labels: ['治疗频次分类'] },
  { key: 'course_desc', labels: ['疗程（单位：天）'] },
  { key: 'course_value', labels: ['疗程数值'] },
  { key: 'course_unit', labels: ['疗程单位'] },
  { key: 'total_sessions', labels: ['治疗总次数'] },
  // 已退役（202609 规则 Sheet1 BB / BC 列）——见 RETIRED_FIELDS
  // { key: 'total_sessions_class_a', labels: ['治疗总次数治疗分类'] },
  // { key: 'total_sessions_class_b', labels: ['治疗总次数分类'] },
  { key: 'deqi', labels: ['得气'] },
  { key: 'insertion_depth_text', labels: ['进针深度 （单位：毫米, mm）'] },
  { key: 'insertion_depth_class', labels: ['进针深度分类'] },
  { key: 'stimulation_intensity', labels: ['刺激强度'] },
  { key: 'needle_retention_desc', labels: ['留针时间 (单位：分钟, min）'] },
  { key: 'needle_retention_value', labels: ['留针时间数值（留针时间）'] },
  { key: 'needle_retention_unit', labels: ['留针时间单位（留针时间）'] },
  // 已退役（202609 规则 Sheet1 BK 列）——见 RETIRED_FIELDS
  // { key: 'needle_retention_class', labels: ['留针时间分类'] },
  { key: 'needle_count_text', labels: ['针的数目（腧穴）'] },
  { key: 'needle_count_min', labels: ['使用最少针数目'] },
  { key: 'post_insertion_manipulation', labels: ['进针后针刺操作分类'] },
  { key: 'needle_angle_class', labels: ['针刺角度分类'] },
  { key: 'needle_direction_class', labels: ['针刺方向分类'] },
  { key: 'max_followup_desc', labels: ['最长随访时间'] },
  { key: 'max_followup_value', labels: ['最长随访时间数值'] },
  { key: 'max_followup_unit', labels: ['最长随访时间单位'] },
  // ---- 重复标签段：试验组/对照组 各出现 4 次 ----
  // groupIndex 0 = 性别分布
  { key: 'sex_experimental', group: '试验组', groupIndex: 0 },
  { key: 'sex_control', group: '对照组', groupIndex: 0 },
  { key: 'type_of_data', labels: ['数据类型'] },
  // 基线分类变量（试验组-/+、对照组-/+）——由 BV「数据类型」的图例决定语义
  { key: 'baseline_cat_experimental_neg', labels: ['试验组-'] },
  { key: 'baseline_cat_experimental_pos', labels: ['试验组+'] },
  { key: 'baseline_cat_control_neg', labels: ['对照组-'] },
  { key: 'baseline_cat_control_pos', labels: ['对照组+'] },
  { key: 'prior_acupuncture', labels: ['受试者既往是否接受过针刺治疗'] },
  { key: 'prior_acupuncture_experimental', group: '试验组', groupIndex: 1 },
  { key: 'prior_acupuncture_control', group: '对照组', groupIndex: 1 },
  { key: 'randomized_n', labels: ['随机样本量'] },
  { key: 'randomized_n_experimental', group: '试验组', groupIndex: 2 },
  { key: 'randomized_n_control', group: '对照组', groupIndex: 2 },
  { key: 'analyzed_n_experimental', group: '试验组', groupIndex: 3 },
  { key: 'analyzed_n_control', group: '对照组', groupIndex: 3 },
  { key: 'dropout_total', labels: ['主要结局脱落总人数'] },
  { key: 'missing_data_ratio', labels: ['缺失数据比例'] },
  { key: 'missing_data_reported', labels: ['是否报告了缺失数据(主要结局)'] },
  { key: 'primary_analysis', labels: ['primary analysis'] },
  { key: 'missing_data_handling', labels: ['主要分析中，如何处理缺失数据'] },
];

// ---------------------------------------------------------------------------
// Sheet2：文章级结局分类
// ---------------------------------------------------------------------------
export const STUDY_FIELDS = [
  { key: 'literature_no', labels: ['文献编号'] },
  { key: 'title', labels: ['题目'] },
  { key: 'extractor', labels: ['提取人'] },
  { key: 'primary_outcome', labels: ['主要结局或第1个出现的患者重要结局', '主要结局(英文)'] },
  { key: 'outcome_pain', labels: ['疼痛类'] },
  { key: 'outcome_nonpain', labels: ['非疼痛症状类结局', '非疼痛症状类'] },
  { key: 'outcome_function', labels: ['功能类结局', '功能类'] },
  { key: 'outcome_qol', labels: ['生活质量类结局', '生活质量类'] },
  { key: 'outcome_events', labels: ['重要事件类结局', '重要事件类'] },
  { key: 'outcome_mortality', labels: ['死亡率'] },
  { key: 'remarks', labels: ['备注'] },
];

/** 缺失/特殊标记。 */
export const SENTINELS = {
  NR: 'not_reported',
  NA: 'not_applicable',
};
