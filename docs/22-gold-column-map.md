# 金标准字段 ↔ 原始表格列 对照表

> 由 `tools/gold_column_map.mjs` 生成（数据源：`build/gold/<year>.json` + `build/legend/<year>.json`）。
> 列字母/中文表头/编码表以 **2020** 年文件为准；列号随年份有漂移，见 §6。

## 0. 三层结构（行粒度已对原始 xlsx 逐行核实）

| 金标准层 | 原始工作表 | **一行 = 什么** | 2020 实例 | 说明 |
|---|---|---|---|---|
| `article.*` | **Sheet1 左半**（2020 版 A–V 列） | —— | 20 篇文章 | 文章元信息 |
| `comparison.*` | **Sheet1 右半**（W–CK 列） | **1 个比较组** | 27 行 → 20 篇 | 与文章级**同一张表同一行**，靠列区分；多臂文章用编号后缀区分（`2020-02-01` / `2020-02-02`） |
| `study.*` | **Sheet2** | **1 篇文章** | 20 行 → 20 篇 | 结局分类（文本） |
| `outcome.*` / `followUp.*` / `timepoints.*` | **Sheet3** | **1 个（比较组 × 结局）** | 132 行 → 27 个 study_id | 5 行表头、152 列、列名是英文代码；同一 id 多行即多个结局 |

**逐行实测**（`tools/_sheet_rowcount.mjs`）：

| 年 | 篇数 | Sheet1 数据行（=比较组） | Sheet2 数据行 | Sheet3 数据行（=结局） |
|---|---|---|---|---|
| 2015 | 6 | 9 | 6 | 22 |
| 2019 | 19 | 25 | 19 | 72 |
| 2020 | 20 | 27 | 20 | 132 |
| 2025 | 33（32 个编号） | 40 | 33（32 个编号） | 166 |

> ⚠️ `2025-02` 是**两篇论文共用一个编号**（Sheet1 第 4、5 行、Sheet2 第 3、4 行），
> 见 `docs/21` §6.1 —— 所以 2025 的 Sheet3 行数 ≠ 篇数×结局数 的直觉算法。
> 另外 Sheet3 的「一行」绑定的是**某个比较组**，靠 `文献编号` 的 `-01/-02` 后缀区分（2020 起如此）。

## 1. Sheet1 · 文章级

| 列 | 原始表头 | 金标准键 | 编码表/图例 |
|---|---|---|---|
| A | 文献编号 | `literature_no` |  |
| B | 提取人姓名 | `extractor` |  |
| C | outliers and influential observations | `outliers_influential` | {"0":"no OI","1":"overall","2":"pain","3":"non-pain","4":"function"} |
| E | 复核合格标准 | `eligibility_check` | ●合格，填写1。 ●不合格，写明排除原因。(请选择) A.非随机 B.非针刺干预措施 C.不符合比较组要求 D.无患者重要结局 |
| F | 题目 | `title` |  |
| G | 发表年份 | `publication_year` |  |
| H | 文献语言 | `language` |  |
| I | 期刊名称 | `journal` | 文献中显示的期刊名称 |
| J | 期刊分类 | `journal_class` | {"1":"补充替代医学期刊","2":"非补充替代医学期刊"} |
| K | 2019影响因子 | `impact_factor_2019` | {"1":"英文文献，查询：附录2-2019影响因子。","2":"中文文献，影响因子均填写0。"} |
| L | 第一作者姓名 | `first_author` |  |
| M | 作者联系方式 | `author_contact` | {"1":"通讯作者","2":"第一作者","3":"未报告，填写NR"} |
| N | 资金1 | `funding_1` | {"1":"有","2":"未报告"} |
| O | 资金2 | `funding_2` | {"1":"国家级","2":"foundation(基金会)","3":"省市级","4":"院校级","5":"industry（企业）","6":"其他","7":"未报告"} |
| P | 文章是否报告注册号 | `registration_reported` | {"1":"是","2":"否"} |
| Q | 疾病名称 | `condition` | 标题或纳入标准中的疾病名称 |
| R | 疾病系统 | `condition_system` | {"1":"肌肉骨骼和结缔组织疾病","2":"神经系统","3":"消化系统","4":"泌尿生殖系统","5":"精神、行为障碍","6":"怀孕、分娩和围产期","7":"皮肤疾病","8":"呼吸系统","9":"睡眠-觉醒障碍", |
| S | 是否跟手术和操作相关或急性发作性疾病 | `acute_or_surgery` | {"1":"是（episodic）","2":"否（chronic）"} |
| T | 国家 | `country` | 招募患者的试验中心所在地（国家）。 |
| U | 国家分类 | `country_class` | {"1":"东方","2":"西方","3":"东西方都有"} |
| V | 试验中心的数量 | `trial_center_count` | 填写开展RCT的医院/地点的数量。 |

## 2. Sheet1 · 比较组级

| 列 | 原始表头 | 金标准键 | 编码表/图例 |
|---|---|---|---|
| W | 干预方法名称 | `intervention` | 干预方法（试验组） |
| X | 对照组名称 | `control` | 对照方式（对照组） |
| Y | 对照组类型 | `control_type` | {"1":"空白对照或等待组","2":"非刺入假针刺","3":"刺入假针刺","4":"非针刺假针","5":"假针+其他疗法","6":"其他"} |
| Z | 对照组类型转换 | `control_type_converted` | {"1":"Penetrating needle sham","2":"Non-penetrating needle sham","3":"Non-needle sham","4":"High-intensity control(No sh |
| AA | 比较类型 | `comparison_type` | {"1":"针刺vs空白对照 /等待组","2":"针刺vs假针/安慰针","3":"针刺+其他疗法vs其他疗法","4":"针刺+其他疗法vs假针/安慰针+其他疗法"} |
| AB | 随机序列产生方法 | `randomization_method` | ● 若有，填写随机序列产生的具体方法。 ● 若未报告，填写NR。 |
| AC | 随机序列产生方法分类 | `randomization_class` | {"1":"随机数字表","2":"计算机随机","3":"抽签","4":"掷骰子","5":"抛硬币","6":"洗牌/信封","7":"最小化","8":"未报告","9":"其他"} |
| AD | 分配隐藏方法 | `allocation_concealment` | ● 若有，提取分配隐藏的具体方法。 ● 若未报告，填写NR。 |
| AE | 分配隐藏方法分类 | `allocation_class` | {"1":"中心隐藏（电话、网站）","2":"不透光密封信封","3":"密封信封","4":"不透光信封","5":"未报告","6":"其他"} |
| AF | 分层或区组随机 | `stratification_blocking` | {"0":"无","1":"分层/stratification","2":"区组/block randomization","3":"分层区组"} |
| AG | 盲研究对象 | `blinding_participants` | {"1":"是","2":"否","3":"未报告"} |
| AH | 盲结局评价者 | `blinding_outcome_assessor` | {"1":"是","2":"否","3":"未报告"} |
| AI | 患者期望值 | `patient_expectation` | ● 若文中报告患者期望值，请填写具体数值或提取相关描述。 ● 若若未报告，填写NR。 |
| AJ | 特定的医患交流 | `practitioner_communication` | {"1":"是","2":"否","3":"未报告"} |
| AK | 操作者从事针灸实践时间(单位：年，year) | `practitioner_years` | ● 若文中明确报告操作者从业时间，则填写具体数值（以年为单位）； ● 若未报告，填写NR。 |
| AL | 针灸师教育或培训分类 | `practitioner_education` | {"1":"中医药或针灸专业教育（学历教育）","2":"短期培训（非学历教育）","3":"未报告"} |
| AM | 操作者临床专业 | `practitioner_specialty` | {"1":"针灸师","2":"其他","3":"未报告"} |
| AN | 针刺治疗类型 | `acupuncture_type` | {"1":"中医针刺","2":"日本医学针刺","3":"韩国韩医针刺","4":"西医针刺","5":"五行针刺","6":"头针","7":"耳针","8":"干针","9":"未报告"} |
| AO | 刺激类型 | `stimulation_type` | {"1":"手针","2":"电针","3":"激光针","4":"TEAS（transeutaneous electrical acupoint stimulation）","5":"穴位按压"} |
| AP | 选穴方案 | `point_selection` | {"1":"固定方案","2":"加减方案","3":"个体化方案","4":"未报告"} |
| AQ | 选穴分类 | `point_location_class` | {"1":"局部","2":"远端","3":"都有 ● 若为其他针刺类型，填写NA。"} |
| AR | 治疗方案来源分类 | `protocol_source` | {"1":"专家共识","2":"教材或文献","3":"临床经验","4":"多种来源","5":"未报告"} |
| AS | 治疗频次描述（标明单位） | `frequency_desc` | ● 若文中明确报告治疗频次，则填写具体描述； ● 若未报告，填写NR。 |
| AT | 治疗频次数值 | `frequency_value` |  |
| AU | 治疗频次单位 | `frequency_unit` | {"1":"天","2":"周 3=1小时"} |
| AV | 治疗频次分类 | `frequency_class` | {"1":"低频次","2":"高频次"} |
| AW | 疗程（单位：天） | `course_desc` | ● 若文中明确报告疗程，则填写具体描述； ● 若未报告，填写NR。 |
| AX | 疗程数值 | `course_value` |  |
| AY | 疗程单位 | `course_unit` | {"1":"天","2":"周"} |
| AZ | 治疗总次数 | `total_sessions` | ● 若文中明确报告了治疗总次数，则填写具体数值（以次为单位）；例：18。 ● 若文章未报告，则填写NR。 |
| BA | 治疗总次数治疗分类 | `total_sessions_class_a` | {"1":"手术+穴位按压","2":"手术+非穴位按压","3":"慢性+穴位按压","4":"慢性+非穴位按压"} |
| BB | 治疗总次数分类 | `total_sessions_class_b` | 1high 2low |
| BC | 得气 | `deqi` | {"1":"是","2":"否","3":"未报告","4":"不适用（TEAS、激光针）"} |
| BD | 进针深度 （单位：毫米, mm） | `insertion_depth_text` | ● 若报告，提取文中进针深度的具体描述； ● 若未报告，填写“NR”。 ● 若不适用（穴位按压、TEAS、激光针），填写NA。 |
| BE | 进针深度分类 | `insertion_depth_class` | {"1":"深刺（≥10mm）","2":"浅刺（<10mm）","3":"未报告","4":"不适用（穴位按压、TEAS、激光针）"} |
| BF | 刺激强度 | `stimulation_intensity` | {"1":"强刺激","2":"中等刺激","3":"弱刺激","4":"未报告"} |
| BG | 留针时间 (单位：分钟, min） | `needle_retention_desc` | ● 若报告，提取文中留针时间的数值（以分钟为单位）； ● 若未报告，填写“NR”。 |
| BH | 留针时间数值（留针时间） | `needle_retention_value` |  |
| BI | 留针时间单位（留针时间） | `needle_retention_unit` | {"1":"分钟","2":"小时"} |
| BJ | 留针时间分类 | `needle_retention_class` | {"1":"手术+非穴位按压","2":"慢性病+非穴位按压"} |
| BK | 针的数目（腧穴） | `needle_count_text` | ● 若可计算，填写用针的数目； ● 若无法计算，提取原文描述。 ● 若未报告，填写NR。 ●若为TEAS、激光针或穴位按压，填写“NA”。 |
| BL | 使用最少针数目 | `needle_count_min` |  |
| BM | 进针后针刺操作分类 | `post_insertion_manipulation` | {"1":"有","2":"无","3":"未报告","4":"不适用（穴位按压、TEAS、激光针）"} |
| BN | 针刺角度分类 | `needle_angle_class` | {"1":"报告","2":"未报告","3":"不适用（穴位按压、TEAS、激光针）"} |
| BO | 针刺方向分类 | `needle_direction_class` | {"1":"报告项","2":"未报告","3":"不适用（穴位按压、TEAS、激光针）"} |
| BP | 最长随访时间 | `max_followup_desc` | ● 若文中明确报告最长随访时间，则填写具体描述； ● 若未报告，填写NR |
| BQ | 最长随访时间数值 | `max_followup_value` |  |
| BR | 最长随访时间单位 | `max_followup_unit` | {"1":"天","2":"月","3":"年","4":"周","5":"小时"} |
| BS | 试验组 | `sex_experimental` | 性别（男/女） ● 若不分组报告，总体报告性别（男/女）数量，只填写第一格，其他空格填写NA。 ● 若未报告，填写NR。 |
| BT | 对照组 | `sex_control` |  |
| BU | 数据类型 | `type_of_data` | 年龄（男/女） ● 若不分组报告，总体报告年龄，填写至试验组，其他空格填写NA。 ● 若未报告，填写NR。 |
| BV | 试验组- | `baseline_cat_experimental_neg` |  |
| BW | 试验组+ | `baseline_cat_experimental_pos` |  |
| BX | 对照组- | `baseline_cat_control_neg` |  |
| BY | 对照组+ | `baseline_cat_control_pos` |  |
| BZ | 受试者既往是否接受过针刺治疗 | `prior_acupuncture` | {"1":"是","2":"否","3":"未报告"} |
| CA | 试验组 | `prior_acupuncture_experimental` | 随机例数（治疗前例数） |
| CB | 对照组 | `prior_acupuncture_control` |  |
| CC | 随机样本量 | `randomized_n` | 试验组随机例数+对照组随机例数 |
| CD | 试验组 | `randomized_n_experimental` | 主要结局时点样本量（at the time point of the primary outcome collection） |
| CE | 对照组 | `randomized_n_control` |  |
| CF | 试验组 | `analyzed_n_experimental` | 脱落人数 |
| CG | 对照组 | `analyzed_n_control` |  |
| CH | 主要结局脱落总人数 | `dropout_total` | 试验组脱落人数+对照组脱落人数 |
| CI | 缺失数据比例 | `missing_data_ratio` | #mpd/#randomized |
| CJ | 是否报告了缺失数据(主要结局) | `missing_data_reported` | {"1":"Yes, state MPD occur (in the main text or in CONSORT flow diagram)","2":"Yes, state MPD did not occur (in the main |
| CK | primary analysis | `primary_analysis` | {"1":"Analysis described as intention to treat Analysis described as modified intention to treat","2":"Analyzed particip |
| CL | 主要分析中，如何处理缺失数据 | `missing_data_handling` | 1=Data deletion method1 (Complete case analysis, This means ignoring the missing data and only analyze the data has all |

## 3. Sheet2 · study 级（结局分类）

| 列（2015） | 列（2016+） | 原始表头 | 金标准键 |
|---|---|---|---|
| A | A | 文献编号 | `literature_no` |
| C | B | 题目 | `title` |
| D | — | 提取人 | `extractor` |
| E | C | 主要结局或第1个出现的患者重要结局 | `primary_outcome` |
| F | D | 疼痛类 | `outcome_pain` |
| G | E | 非疼痛症状类结局 | `outcome_nonpain` |
| H | F | 功能类结局 | `outcome_function` |
| I | G | 生活质量类结局 | `outcome_qol` |
| J | H | 重要事件类结局 | `outcome_events` |
| K | I | 死亡率 | `outcome_mortality` |
| L | J | 备注 | `remarks` |

> ⚠️ Sheet2 也是**两版布局**：2015 比 2016 起多一列 `提取人`（D），2016 起所有列左移一位。`extractor` 只在 2015 的表里有列 —— 所以它显示为「—」。

## 4. Sheet3 · 结局自身列

| 列 | 列代码 | 原始表头 | 金标准键（我们评测用的名字） | 编码表 |
|---|---|---|---|---|
| A | `STUDYID` | 文献编号 | `literature_code` |  |
| C | `ARMNU` | 研究组别的数量 | `arm_number` | {"1":"双臂","2":"多臂","3":"多试验组","4":"多对照组"} |
| D | `STDATA` | 特殊数据情况 | `special_data_flag` | {"1":"无法确定数据","2":"等级资料 无法转化二分类","3":"等级转二分类","4":"排除"} |
| E | `CONST` | construct | `outcome.construct_code` |  |
| F | `SUBCONST` | subconstruct | `outcome.subconstruct_code` | {"1":"All Major events","2":"Musculoskeletal functions","3":"Nerve functions","4":"Mental, behaviour |
| G | `PVALRAG` | P值范围 | `outcome.p_value_range` | {"1":"P<0.05","2":"P>0.05"} |
| H | `PVALNUM` | P值数值 | `outcome.p_value` |  |
| I | `OUTCOM` | 结局名称 | `outcome.name` |  |
| J | `INSTRU` | 测量工具名称 | `outcome.instrument` |  |
| K | `RANGE` | 测量范围 | `outcome.measurement_range` |  |
| L | `MDIRE` | 测量方向 | `outcome.measurement_direction` |  |
| M | `MUNIT` | 测量单位 | `outcome.measurement_unit` |  |
| N | `MTYPE` | 测量类型 | `outcome.measurement_type` | {"1":"估计值","2":"组间差值","3":"发生事件数","4":"OR","5":"RR","6":"RD","7":"HR","8":"等级资料"} |
| O | `IFADJ` | 基线是否调整 | `outcome.baseline_adjusted` | {"1":"是","2":"否","3":"不清楚"} |
| P | `POTIMPO` | 主要结局测量时点 | `outcome.primary_outcome_timepoint` | {"0":"非主要结局","1":"治疗结束后","2":"随访","3":"治疗结束后和随访都有","4":"未报告"} |
| Q | `SPECO` | 结局特殊类别 | `outcome.special_category` | {"1":"主要结局,for both analysis","2":"主要结局，only for overall analysis","3":"同时属于功能和生活质量结局"} |
| DB | `FOLTIM` | 随访时间 | `followUp.description` |  |
| DC | `FOLTIMN` | 随访时间数值 | `followUp.value` |  |
| DD | `FOLTIMU` | 随访时间单位 | `followUp.unit` | {"1":"天","2":"月","3":"年","4":"周","5":"小时"} |

## 5. Sheet3 · 三个时点块的列（B / E / F 前缀）

列的命名规则：**块字母 + 字段码**。

- `B` = **基线期**（`baseline`）
- `E` = **疗程结束时**（`end_of_treatment`）
- `F` = **随访结束时（≥80%数据的最长时间点）**（`follow_up_end`）

| 列 | 列代码 | 原始表头（分组/字段） | 评测里的字段名 |
|---|---|---|---|
| R | `BTESTI` | 基线期 / 连续型变量 / 估计值类型 | `baseline.continuous.estimate_type` |
| S | `BTVARI` | 变异值的类型 | `baseline.continuous.variance_type` |
| T | `BIESTI` | 试验组 / 估计值 | `baseline.continuous.experimental.estimate` |
| U | `BILVARI` | 变异值（下限） | `baseline.continuous.experimental.ci_lower` |
| V | `BIUVARI` | 变异值（上限） | `baseline.continuous.experimental.ci_upper` |
| W | `BNINTE` | 例数 | `baseline.continuous.experimental.n` |
| X | `BCESTI` | 对照组 / 估计值 | `baseline.continuous.control.estimate` |
| Y | `BCLVARI` | 变异值（下限） | `baseline.continuous.control.ci_lower` |
| Z | `BCUVARI` | 变异值（上限） | `baseline.continuous.control.ci_upper` |
| AA | `BNCONT` | 例数 | `baseline.continuous.control.n` |
| AB | `BDEST` | 组间差值的估计值 | `baseline.binary.difference_estimate` |
| AC | `BDLVAR` | 组间差值的变异值（下限） | `baseline.binary.difference_ci_lower` |
| AD | `BDUVAR` | 组间差值的变异值（上限） | `baseline.binary.difference_ci_upper` |
| AE | `BINEVE` | 二分类变量 / 试验组 / 发生事件数 | `baseline.binary.experimental.events` |
| AF | `BINUM` | 例数 | `baseline.binary.experimental.n` |
| AG | `BCNEVE` | 对照组 / 发生事件数 | `baseline.binary.control.events` |
| AH | `BCNUM` | 例数 | `baseline.binary.control.n` |
| AI | `BOR` | OR | `baseline.binary.or` |
| AJ | `BORCIL` | 95%CI（下限） | `baseline.binary.or_ci_lower` |
| AK | `BORCIU` | 95%CI（上限） | `baseline.binary.or_ci_upper` |
| AL | `BRR` | RR | `baseline.binary.rr` |
| AM | `BRRCIL` | 95%CI（下限） | `baseline.binary.rr_ci_lower` |
| AN | `BRRCIU` | 95%CI（上限） | `baseline.binary.rr_ci_upper` |
| AO | `BRD` | RD | `baseline.binary.rd` |
| AP | `BRDCIL` | 95%CI（下限） | `baseline.binary.rd_ci_lower` |
| AQ | `BRDCIU` | 95%CI（上限） | `baseline.binary.rd_ci_upper` |
| AR | `BHR` | HR | `baseline.binary.hr` |
| AS | `BHRCIL` | 95%CI（下限） | `baseline.binary.hr_ci_lower` |
| AT | `BHRCIU` | 95%CI（上限） | `baseline.binary.hr_ci_upper` |
| AU | `BRADACLA` | 分类方法 | `baseline.categorical.classification_method` |
| AV | `BRDINFRI` | 等级资料 / 试验组 / 1 | `baseline.categorical.experimental.cat1` |
| AW | `BRDINSEC` | 2 | `baseline.categorical.experimental.cat2` |
| AX | `BRDINTHI` | 3 | `baseline.categorical.experimental.cat3` |
| AY | `BRDINFOR` | 4 | `baseline.categorical.experimental.cat4` |
| AZ | `BRDINFIF` | 5 | `baseline.categorical.experimental.cat5` |
| BA | `BRDINSIX` | 6 | `baseline.categorical.experimental.cat6` |
| BB | `BRDINNUM` | 例数 | `baseline.categorical.experimental.n` |
| BC | `BRDCOFRI` | 对照组 / 1 | `baseline.categorical.control.cat1` |
| BD | `BRDCOSEC` | 2 | `baseline.categorical.control.cat2` |
| BE | `BRDCOTHI` | 3 | `baseline.categorical.control.cat3` |
| BF | `BRDCOFOR` | 4 | `baseline.categorical.control.cat4` |
| BG | `BRDCOFIF` | 5 | `baseline.categorical.control.cat5` |
| BH | `BRDCOSIX` | 6 | `baseline.categorical.control.cat6` |
| BI | `BRDCONUM` | 例数 | `baseline.categorical.control.n` |
| BJ | `ETESTI` | 疗程结束时 / 连续结局 / 估计值类型 | `end_of_treatment.continuous.estimate_type` |
| BK | `ETVARI` | 变异值的类型 | `end_of_treatment.continuous.variance_type` |
| BL | `EIESTI` | 试验组 / 估计值 | `end_of_treatment.continuous.experimental.estimate` |
| BM | `EILVARI` | 变异值（下限） | `end_of_treatment.continuous.experimental.ci_lower` |
| BN | `EIUVARI` | 变异值（上限） | `end_of_treatment.continuous.experimental.ci_upper` |
| BO | `ENINTE` | 例数 | `end_of_treatment.continuous.experimental.n` |
| BP | `ECESTI` | 对照组 / 估计值 | `end_of_treatment.continuous.control.estimate` |
| BQ | `ECLVARI` | 变异值（下限） | `end_of_treatment.continuous.control.ci_lower` |
| BR | `ECUVARI` | 变异值（上限） | `end_of_treatment.continuous.control.ci_upper` |
| BS | `ENCONT` | 例数 | `end_of_treatment.continuous.control.n` |
| BT | `EDEST` | 组间差值的估计值 | `end_of_treatment.binary.difference_estimate` |
| BU | `EDLVAR` | 组间差值的变异值（下限） | `end_of_treatment.binary.difference_ci_lower` |
| BV | `EDUVAR` | 组间差值的变异值（上限） | `end_of_treatment.binary.difference_ci_upper` |
| BW | `EINEVE` | 二分类变量 / 试验组 / 发生事件数 | `end_of_treatment.binary.experimental.events` |
| BX | `EINUM` | 例数 | `end_of_treatment.binary.experimental.n` |
| BY | `ECNEVE` | 对照组 / 发生事件数 | `end_of_treatment.binary.control.events` |
| BZ | `ECNUM` | 例数 | `end_of_treatment.binary.control.n` |
| CA | `EOR` | OR | `end_of_treatment.binary.or` |
| CB | `EORCIL` | 95%CI（下限） | `end_of_treatment.binary.or_ci_lower` |
| CC | `EORCIU` | 95%CI（上限） | `end_of_treatment.binary.or_ci_upper` |
| CD | `ERR` | RR | `end_of_treatment.binary.rr` |
| CE | `ERRCIL` | 95%CI（下限） | `end_of_treatment.binary.rr_ci_lower` |
| CF | `ERRCIU` | 95%CI（上限） | `end_of_treatment.binary.rr_ci_upper` |
| CG | `ERD` | RD | `end_of_treatment.binary.rd` |
| CH | `ERDCIL` | 95%CI（下限） | `end_of_treatment.binary.rd_ci_lower` |
| CI | `ERDCIU` | 95%CI（上限） | `end_of_treatment.binary.rd_ci_upper` |
| CJ | `EHR` | HR | `end_of_treatment.binary.hr` |
| CK | `EHRCIL` | 95%CI（下限） | `end_of_treatment.binary.hr_ci_lower` |
| CL | `EHRCIU` | 95%CI（上限） | `end_of_treatment.binary.hr_ci_upper` |
| CM | `ERADACLA` | 分类方法 | `end_of_treatment.categorical.classification_method` |
| CN | `ERDINFRI` | 等级资料 / 试验组 / 1 | `end_of_treatment.categorical.experimental.cat1` |
| CO | `ERDINSEC` | 2 | `end_of_treatment.categorical.experimental.cat2` |
| CP | `ERDINTHI` | 3 | `end_of_treatment.categorical.experimental.cat3` |
| CQ | `ERDINFOR` | 4 | `end_of_treatment.categorical.experimental.cat4` |
| CR | `ERDINFIF` | 5 | `end_of_treatment.categorical.experimental.cat5` |
| CS | `ERDINSIX` | 6 | `end_of_treatment.categorical.experimental.cat6` |
| CT | `ERDINNUM` | 例数 | `end_of_treatment.categorical.experimental.n` |
| CU | `ERDCOFRI` | 对照组 / 1 | `end_of_treatment.categorical.control.cat1` |
| CV | `ERDCOSEC` | 2 | `end_of_treatment.categorical.control.cat2` |
| CW | `ERDCOTHI` | 3 | `end_of_treatment.categorical.control.cat3` |
| CX | `ERDCOFOR` | 4 | `end_of_treatment.categorical.control.cat4` |
| CY | `ERDCOFIF` | 5 | `end_of_treatment.categorical.control.cat5` |
| CZ | `ERDCOSIX` | 6 | `end_of_treatment.categorical.control.cat6` |
| DA | `ERDCONUM` | 例数 | `end_of_treatment.categorical.control.n` |
| DE | `FTESTI` | 随访结束时（≥80%数据的最长时间点） / 连续变量 / 估计值类型 | `follow_up_end.continuous.estimate_type` |
| DF | `FTVARI` | 变异值的类型 | `follow_up_end.continuous.variance_type` |
| DG | `FIESTI` | 试验组 / 估计值 | `follow_up_end.continuous.experimental.estimate` |
| DH | `FILVARI` | 变异值（下限） | `follow_up_end.continuous.experimental.ci_lower` |
| DI | `FIUVARI` | 变异值（上限） | `follow_up_end.continuous.experimental.ci_upper` |
| DJ | `FNINTE` | 例数 | `follow_up_end.continuous.experimental.n` |
| DK | `FCESTI` | 对照组 / 估计值 | `follow_up_end.continuous.control.estimate` |
| DL | `FCLVARI` | 变异值（下限） | `follow_up_end.continuous.control.ci_lower` |
| DM | `FCUVARI` | 变异值（上限） | `follow_up_end.continuous.control.ci_upper` |
| DN | `FNCONT` | 例数 | `follow_up_end.continuous.control.n` |
| DO | `FDEST` | 组间差值的估计值 | `follow_up_end.binary.difference_estimate` |
| DP | `FDLVAR` | 组间差值的变异值（下限） | `follow_up_end.binary.difference_ci_lower` |
| DQ | `FDUVAR` | 组间差值的变异值（上限） | `follow_up_end.binary.difference_ci_upper` |
| DR | `FINEVE` | 二分类变量 / 试验组 / 发生事件数 | `follow_up_end.binary.experimental.events` |
| DS | `FINUM` | 例数 | `follow_up_end.binary.experimental.n` |
| DT | `FCNEVE` | 对照组 / 发生事件数 | `follow_up_end.binary.control.events` |
| DU | `FCNUM` | 例数 | `follow_up_end.binary.control.n` |
| DV | `FOR` | OR | `follow_up_end.binary.or` |
| DW | `FORCIL` | 95%CI（下限） | `follow_up_end.binary.or_ci_lower` |
| DX | `FORCIU` | 95%CI（上限） | `follow_up_end.binary.or_ci_upper` |
| DY | `FRR` | RR | `follow_up_end.binary.rr` |
| DZ | `FRRCIL` | 95%CI（下限） | `follow_up_end.binary.rr_ci_lower` |
| EA | `FRRCIU` | 95%CI（上限） | `follow_up_end.binary.rr_ci_upper` |
| EB | `FRD` | RD | `follow_up_end.binary.rd` |
| EC | `FRDCIL` | 95%CI（下限） | `follow_up_end.binary.rd_ci_lower` |
| ED | `FRDCIU` | 95%CI（上限） | `follow_up_end.binary.rd_ci_upper` |
| EE | `FHR` | HR | `follow_up_end.binary.hr` |
| EF | `FHRCIL` | 95%CI（下限） | `follow_up_end.binary.hr_ci_lower` |
| EG | `FHRCIU` | 95%CI（上限） | `follow_up_end.binary.hr_ci_upper` |
| EH | `FRADACLA` | 等级资料 / 分类方法 | `follow_up_end.categorical.classification_method` |
| EI | `FRDINFRI` | 试验组 / 1 | `follow_up_end.categorical.experimental.cat1` |
| EJ | `FRDINSEC` | 2 | `follow_up_end.categorical.experimental.cat2` |
| EK | `FRDINTHI` | 3 | `follow_up_end.categorical.experimental.cat3` |
| EL | `FRDINFOR` | 4 | `follow_up_end.categorical.experimental.cat4` |
| EM | `FRDINFIF` | 5 | `follow_up_end.categorical.experimental.cat5` |
| EN | `FRDINSIX` | 6 | `follow_up_end.categorical.experimental.cat6` |
| EO | `FRDINNUM` | 例数 | `follow_up_end.categorical.experimental.n` |
| EP | `FRDCOFRI` | 对照组 / 1 | `follow_up_end.categorical.control.cat1` |
| EQ | `FRDCOSEC` | 2 | `follow_up_end.categorical.control.cat2` |
| ER | `FRDCOTHI` | 3 | `follow_up_end.categorical.control.cat3` |
| ES | `FRDCOFOR` | 4 | `follow_up_end.categorical.control.cat4` |
| ET | `FRDCOFIF` | 5 | `follow_up_end.categorical.control.cat5` |
| EU | `FRDCOSIX` | 6 | `follow_up_end.categorical.control.cat6` |
| EV | `FRDCONUM` | 例数 | `follow_up_end.categorical.control.n` |

## 6. 列位置跨年漂移：**两版布局**

原始表格在 2019 → 2020 之间**删掉了一列**，之后所有列左移一位。所以同一个字段在两版里列号不同：

| 层 | 原始表头 | 键 | 2015–2019 | 2020–2025 |
|---|---|---|---|---|
| article | outliers and influential observations | `outliers_influential` | D | C |
| article | 复核合格标准 | `eligibility_check` | F | E |
| article | 题目 | `title` | G | F |
| article | 发表年份 | `publication_year` | H | G |
| article | 文献语言 | `language` | I | H |
| article | 期刊名称 | `journal` | J | I |
| article | 期刊分类 | `journal_class` | K | J |
| article | 2019影响因子 | `impact_factor_2019` | L | K |
| article | 第一作者姓名 | `first_author` | M | L |
| article | 作者联系方式 | `author_contact` | N | M |
| article | 资金1 | `funding_1` | O | N |
| article | 资金2 | `funding_2` | P | O |
| article | 文章是否报告注册号 | `registration_reported` | Q | P |
| article | 疾病名称 | `condition` | R | Q |
| article | 疾病系统 | `condition_system` | S | R |
| article | 是否跟手术和操作相关或急性发作性疾病 | `acute_or_surgery` | T | S |
| article | 国家 | `country` | U | T |
| article | 国家分类 | `country_class` | V | U |
| article | 试验中心的数量 | `trial_center_count` | W | V |
| comparison | 干预方法名称 | `intervention` | X | W |
| comparison | 对照组名称 | `control` | Y | X |
| comparison | 对照组类型 | `control_type` | Z | Y |
| comparison | 对照组类型转换 | `control_type_converted` | AA | Z |
| comparison | 比较类型 | `comparison_type` | AB | AA |

共 **87** 个字段受影响（列名不变、列号变）。完整清单见 `build/gold_column_map.json` 的 `drift`。

> 例外：`文献编号` 始终在 **A** 列（它是第一列，不受移位影响）。

## 7. 覆盖核对：原始表里有、但金标准 json 没收录的列

Sheet1 未被收录 **2** 列：

| 列 | 原始表头 | 编码数 |
|---|---|---|
| D | construct | 0 |
| CM | 备注 | 0 |

Sheet3 未被收录 **1** 列（前 30）：

| 列 | 列代码 | 原始表头 |
|---|---|---|
| B | `OI` | OI |

## 8. 与 `tools/canonical-field-map.mjs` 的关系（⚠️ 批注引用是旧版布局）

- 提示词/编码器的真源是 **`tools/canonical-field-map.mjs`**（人工维护），不是自动提取的 legend。
  `legendFor()` 在 `LEGENDS` 未命中时回退到它；`totalSessionsClassB` 只有 `desc`、**没有 `codes`** ——
  这就是 `docs/21` §2.1 那个"整列 0%"的直接原因，修就在这一行。
- 它里面的 `comment`（如 `N2`、`K2`、`D1`）用的是 **2015–2019 版布局**：
  2020 起整体左移一列，所以 2020–2025 的「依据：单元格批注 X2」会指到隔壁列（如 `authorContact` 写 N2、实际 M2）。
- 各年真值：见 `build/gold_column_map.json` 的 `layoutByYear`。

### 8.1 报告生成器的列字母（已修）

`tools/lib/field_labels.mjs` 负责把字段名翻成"工作簿第几列"，给医生的报告全靠它。它曾有两处**整体偏差**：

| 问题 | 原因 | 修法 |
|---|---|---|
| Sheet1 的列字母是 **2015–2019 版**布局 | 合并各年定义时"先出现的优先"，2015 排最前 | 改成"最新年份优先"，并附注旧版字母 |
| Sheet3 的列字母**少算一位**（如 OUTCOM 写成 H 列，真实 I 列） | 用 `anchorCol + outcome_columns.indexOf(code)` 推算，而 `outcome_columns`（151 项）漏了 `OI` 列（工作表共 152 列） | 改以 **legend 的真实单元格坐标**为准，推算只作兜底（兜底时补回 OI 那一列） |

验证：`node tools/_label_check.mjs`（逐字段打印列字母）。

## 9. ⚠️ 评测口径提醒

- 时点块里的 `experimental` / `control` 两组，在 `tools/llm_eval.mjs` 里**共用同一个字段名**
  （递归时不改 `scope`），所以 `end_of_treatment.continuous.estimate` 这类字段是**两组合并**的统计，不是单组。
- `followUp.*`（结局级随访三列）在原始表里是 Sheet3 的 **DB/DC/DD**，与 `comparison.max_followup_*`（Sheet1 的 BP/BQ/BR）**不是同一列**。
- `comparison.analyzed_n_experimental/_control` 的列名与内容不符（列名 analyzed N、内容为脱落人数），见 `docs/21` §6。
- ⚠️ **`binary.difference_*` 的组名写错了**：`tools/gold_schema.mjs:96-98` 把 Sheet3 的
  `DEST`/`DLVAR`/`DUVAR`（原始表头「组间差值的估计值 / 变异值（下限/上限）」）映射成 `binary.difference_*`，
  但这三列在表里位于**连续型变量**区块中（前接 `BNCONT` 对照组例数、后接 `BINEVE` 二分类事件数）。
  实测 **151 个时点块**里这三列装的**全是连续型均数差**（BDI 均数差 `-1.56`、EQ-5D `-0.01`、FSS `-0.43`），
  同块二分类计数全为空 → 应归 `continuous.difference_*`。金标准与流水线用的是同一套名字，**不影响评分**，但命名误导。
