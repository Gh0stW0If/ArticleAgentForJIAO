# 目标结局字典（从金标准 Sheet3 的 OUTCOM + INSTRU 总结）

> 由 `tools/outcome_dictionary.mjs` 生成。数据源：`build/gold/<year>.json` 的结局行
> （原始表 Sheet3 的「结局名称」`OUTCOM` 与「测量工具名称」`INSTRU` 两列）。

## 0. 为什么需要字典

机器按提示词"列出论文报告的**全部**结局指标"，金标准只记它要的那几个 → 大量"多填"（见 `docs/21` §4.5）。
字典的用途有两个，**不要混为一谈**：

| 用途 | 做法 | 预估收益 |
|---|---|---|
| **① 配对** | 评测时用字典把机器列表里的对应行找回来（现在只配上 775 行） | 136 行（字面口径）～ 186 行（概念口径） |
| **② 召回** | 把字典当"必查清单"塞进 `outcome-plan` 提示词，让模型逐项核对 | 针对 147 行缺失（55 篇） |

## 1. 规模

| 指标 | 数值 |
|---|---|
| 金标准有效结局行 | 1112 |
| 不同写法（名称｜工具） | 769 |
| **聚成目标结局概念** | **339** |
| 当前评测对齐配上 | 775（69.7%） |
| ① strict 档（现有字面口径）机器列表里存在 | 911（81.9%） |
| ② synonym 档（+缩写展开） | 925（83.2%） |
| ③ concept 档（+词形近似/内容词相交） | 961（86.4%） |
| ④ 三档都找不到 | 147（13.2%） |

> ⚠️ concept 档会引入假配对（实测：`qulity of life-physcial functioning｜SF-36` 被配到 `spinal functions｜ODI`）。
> **建议：评分用 strict/synonym 档，concept 档只用于召回提示。**

## 2. 目标结局概念（按覆盖行数排序，前 60）

| 概念 | 行数 | 关键词 | 金标准代表写法 |
|---|---|---|---|
| O001 | 45 | pain management first trimester abortion maximum visual analogue | 1.pain management during first trimester｜maximum pain, VAS |
| O002 | 35 | fibromyalgia visual analogue global quality life analog labor | fibromyalgia｜VAS |
| O003 | 22 | carpal tunnel syndrome pain intensity numeric rating labor | carpal tunnel syndrome pain intensity｜the numeric rating scale(NRS) |
| O004 | 22 | generic health related quality life short form physical | 13.generic health-related quality of lif｜Short-Form (SF)-12②Physical compon |
| O005 | 21 | quality life whoqol bref who overall psychological health | quality of life｜WHOQOL-BREF(WHO Quality of Life-BR |
| O006 | 18 | pain bpi severity interference worst average | pain｜BPI pain severity score |
| O007 | 16 | sleep quality psqi latency duartion disturbance | Sleep quality｜PSQI |
| O008 | 14 | depression beck inventory depres anxiety hospital | depression｜3. BDI, Beck depression inventory; |
| O009 | 14 | pain gill sensory short form mpq | pain｜McGill Sensory |
| O010 | 14 | nausea degree functional living emesi flie activity cook | Nausea degree｜Functional Living Index‑Emesis (FL |
| O011 | 13 | quality life swal swallow related migraine specific restrict | 4. quality of life｜SWAL- QOL: Swallowing-Related Qual |
| O012 | 13 | physical function womac subscale pain stiffnes change | physical function｜2.WOMAC function |
| O013 | 12 | emesi vomit incidence postoperat nausea severity within clinical | emesis /2.vomiting｜total incidence of vomiting |
| O014 | 12 | labor pain visual analogue neuralgia shoulder average knee | 1. labor pain｜VAS |
| O015 | 12 | mental domain health quality life pacqlq physical discomfort | mental domains｜SF-12v2 |
| O016 | 12 | stres visual analogue nausea emesi vomit significant overall | stress｜VAS |
| O017 | 12 | affect gill evaluat | Affective｜Affective McGill |
| O018 | 11 | depression anxiety hospital hamilton rating somatiz | depression｜HADS: Hospital Anxiety and Depress |
| O019 | 10 | level depression hdrs hamilton rating hetero evalu scal | level of depression｜HDRS: Hamilton Depression Rating h |
| O020 | 10 | pain related impairment emotion depression zung self rating | 10. pain-related impairment of emotion｜SDS: Zung Self-rating Depression S |
| O021 | 9 | motor function fma upper limb lower shangtianmin rating | motor function｜FMA upper limb |
| O022 | 8 | quality life pac change patient constip worr concern | quality of life｜PAC-QOL：Change in Patient Assessme |
| O023 | 8 | sleep pittsburgh isi quality psqi | 4. Sleep｜Pittsburgh sleep score |
| O024 | 8 | pain verbal numeric rating night percentage days nprs | pain｜VNRS |
| O025 | 8 | patient comfort gcq psychological phc social | 1. Patient comfort score｜The Comfort Scale：questionnaire GC |
| O026 | 8 | anxiety spielberger state trait inventory stai | anxiety｜Spielberger’s State-Trait Anxiety  |
| O027 | 8 | insomnia severity isi psqi sleep change baseline ess | Insomnia Severity｜ISI |
| O028 | 7 | quality life physical mental euro dimension component summary | quality of life｜SF12:①Physical |
| O029 | 7 | cognit function mini mental state examin mmse | 1.Cognitive Function｜Mini-Mental State Examination (MMS |
| O030 | 7 | pain latent visual analogue active transition postpartum uteru | Pain-latent｜VAS |
| O031 | 7 | retch rhod acute nausea vomit invr delayed scor | retching｜Rhodes total |
| O032 | 7 | anxiety sati hdrs state | Anxiety｜SATI-SA |
| O033 | 6 | cancer related fatigue intensity visual analogue headache cfs | 1. cancer-related fatigue intensity｜VAS |
| O034 | 6 | function postoperat flatu time first ileu passage gastrointestinal | function(postoperative flatus)｜6.time of the first postoperative  |
| O035 | 6 | pain womac propofol | pain｜1. WOMAC pain |
| O036 | 6 | postoperat nausea severity numeric rating pain rest scal | 1.postoperative nausea severity｜NRS:numeric rating scale |
| O037 | 6 | dyspepsia symptom response rate elimin ndi | dyspepsia symptom｜Response rate |
| O038 | 6 | sedation pssi side effect global satisfaction cssi | sedation instrument｜PSSI: sedation side effects |
| O039 | 6 | quality life pal overall physical discomfort subscale psychosocial | quality of life｜PAL-QOL-overall score |
| O040 | 6 | anxiety hama bai | anxiety｜HAMA |
| O041 | 6 | pain mean number migraine days proportion participant reduction | pain｜the mean number of migraine days |
| O042 | 6 | cfs physical cognit cancer fatigue emotional fatigure | CFS-physical｜CFS-physical |
| O043 | 6 | miscellaneou gill | miscellaneous｜McGill miscellaneous |
| O044 | 6 | function roland morrisa | function｜roland morrisa |
| O045 | 6 | emotional functionality idb | Emotional Functionality｜IDB |
| O046 | 6 | psychosocial factor sbst | Psychosocial Factors｜SBST |
| O047 | 6 | global perceived effect gpe | Global Perceived Effect Scale｜GPE |
| O048 | 6 | acr | ACR 20｜ACR 20 |
| O049 | 6 | stroke specific quality life aphasia composite mean physical | Stroke-Specific Quality of Life Scale｜Stroke-Specific Quality of Life Sc |
| O050 | 6 | social contact functional living emesi flie personal difficult | Social contact｜Functional Living Index‑Emesis (FL |
| O051 | 6 | leg visual analogue groin back pain | leg-Visual Analogue Scale (VAS) for leg,｜leg-Visual Analogue Scale (VAS) fo |
| O052 | 6 | change baseline ibs quality life health worry subscale | Change from baseline in total IBS-QOL｜IBS-QOL |
| O053 | 6 | northwick park neck pain npq | Score of Northwick Park Neck Pain Questi｜Score of Northwick Park Neck Pain  |
| O054 | 6 | somatiz scl depression | Somatization｜SCL-90 |
| O055 | 6 | anxiety scl hostility phobic | Anxiety｜SCL-90 |
| O056 | 5 | constip related change mean spontaneou bowel movement number | 3.Constipation-Related｜Change in mean spontaneous bowel m |
| O057 | 5 | physical domaim function functional capacity fiq | physical domaims｜SF-12v2 |
| O058 | 5 | virtro fertiliz clinical pregnancy rate | 1.in virtro fertilization｜Clinical pregnancy rate |
| O059 | 5 | anxiety visual analogue average headache severity urinary symptom | anxiety｜VAS-A: VAS for anxiety |
| O060 | 5 | disability odi oswestry change baseline days | Disability｜ODI |

（完整 339 个见 `build/outcome_dictionary.json`）

## 3. 机器确实没抽到的 147 行

| 文章 | 金标准行号 | 金标准写法 |
|---|---|---|
| 2015-02 | 3 | self- assess the severity of their nasal｜Juniper sneezing score :① Juniper sneezing score |
| 2016-07 | 1 | emesis /2.vomiting｜total incidence of vomiting |
| 2016-12 | 1 | 1. pain｜intraoperative sufentanil consumption |
| 2016-12 | 2 | 1. pain｜intraoperative sufentanil consumption |
| 2016-15 | 1 | vomiting｜5.incidence of postoperative vomiting |
| 2016-15 | 2 | vomiting｜5.incidence of postoperative vomiting |
| 2016-15 | 3 | vomiting｜5.incidence of postoperative vomiting |
| 2016-15 | 4 | function(postoperative flatus)｜6.time of the first postoperative flatus |
| 2016-15 | 5 | function(postoperative flatus)｜6.time of the first postoperative flatus |
| 2016-15 | 6 | function(postoperative flatus)｜6.time of the first postoperative flatus |
| 2017-08 | 1 | 1. nausea, vomiting and retching in early pregnancy:｜Pregnancy-Unique Quantification of Emesis(PUQE):④PUQE score |
| 2017-08 | 2 | 1. nausea, vomiting and retching in early pregnancy:｜Pregnancy-Unique Quantification of Emesis(PUQE):nausea |
| 2017-13 | 5 | physical domaims｜SF-12v2 |
| 2017-13 | 6 | physical domaims｜SF-12v2 |
| 2017-13 | 7 | mental domains｜SF-12v2 |
| 2017-13 | 8 | mental domains｜SF-12v2 |
| 2017-15 | 1 | 1.Pregnancy｜1.Pregnancy rates |
| 2017-15 | 2 | 1.Pregnancy｜1.Pregnancy rates |
| 2018-04 | 2 | 3.Neck active range of motion-ROTATION｜3.Neck active range of motion-ROTATION |
| 2018-09 | 11 | migraine｜specific quality-of-life questionnaire(MSQ),restrictive subscale |
| 2018-09 | 12 | migraine｜specific quality-of-life questionnaire(MSQ),restrictive subscale |
| 2018-09 | 13 | 8..migraine-specific quality-of-life questionnaire｜MSQ Score, Emotional Functional Subscal |
| 2018-09 | 14 | 8..migraine-specific quality-of-life questionnaire｜MSQ Score, Emotional Functional Subscal |
| 2018-09 | 15 | Migraine｜1Frequency of Migraine Attack |
| 2018-09 | 16 | Migraine｜1Frequency of Migraine Attack |
| 2018-10 | 1 | 3.postoperative vomiting｜incidence of Vomiting |
| 2018-10 | 2 | 3.postoperative vomiting｜incidence of Vomiting |
| 2018-10 | 3 | 1.postoperative nausea severity｜NRS:numeric rating scale |
| 2018-10 | 4 | 1.postoperative nausea severity｜NRS:numeric rating scale |
| 2018-12 | 1 | dosage of opioid medications｜Medication and Pain Diaries |
| 2018-12 | 2 | dosage of opioid medications｜Medication and Pain Diaries |
| 2019-01 | 2 | physical function｜SF-36 |
| 2019-01 | 3 | mental function｜SF-36 |
| 2019-02 | 2 | 3.nausea,｜Number of patients experiencing nausea per day |
| 2019-05 | 1 | pain｜7.FACT-B single items：①pain |
| 2019-05 | 2 | nausea｜9..FACT-B single items：③nausea |
| 2019-05 | 4 | sleep｜8.FACT-B single items：②sleep |
| 2019-12 | 3 | 7.depression｜Goldberg depression scale rating 0‐9. Score ≥2 indicates the presence of depression; |
| 2019-12 | 4 | 7.depression｜Goldberg depression scale rating 0‐9. Score ≥2 indicates the presence of depression; |
| 2020-04 | 2 | Fatigue｜PFS |
| 2020-04 | 3 | Sleep quality｜PSQI |
| 2020-04 | 4 | depresssive｜PHQ |
| 2020-04 | 5 | health-related QoL.｜PCS |
| 2020-04 | 6 | health-related QoL.｜MCS |
| 2020-06 | 7 | alertness/sedation｜OOA/S |
| 2020-06 | 8 | alertness/sedation｜OOA/S |
| 2020-17 | 3 | function｜BI |
| 2020-20 | 19 | depression｜BDI-II |
| 2020-20 | 20 | depression｜BDI-II |
| 2020-20 | 21 | anxiety｜BAI |
| 2020-20 | 22 | anxiety｜BAI |
| 2021-11 | 7 | Neonatal evaluation｜Apgar score |
| 2021-11 | 8 | Neonatal evaluation｜Apgar score |
| 2021-20 | 1 | res_x0002_ponders, defined as those with a reduction of at least 6 points from baseline in the NIH-CPSI total score｜res_x0002_ponders, defined as those with a reduction of at least 6 points from baseline in the NIH-CPSI total score |
| 2021-20 | 8 | Hospital Anxiety and Depression｜HADS |
| 2022-06 | 11 | BPI PROMIS PI_x0002_SF｜BPI PROMIS PI_x0002_SF |
| 2022-06 | 12 | BPI PROMIS PI_x0002_SF｜BPI PROMIS PI_x0002_SF |
| 2022-13 | 2 | pain｜NRS |
| 2022-16 | 19 | QoL｜Urine leakage |
| 2022-18 | 2 | pain｜VAS |
| 2022-18 | 3 | pain｜WOAMC-pain |
| 2022-18 | 4 | funciton｜WOAMC-stiffness |
| 2022-18 | 5 | funciton｜WOAMC-funciton |
| 2022-19 | 7 | SF-36PH｜SF-36PH |
| 2022-19 | 8 | SF-36MH｜SF-36MH |
| 2022-20 | 9 | feeling of fullness in the rectum｜VASQ-feeling of fullness in the rectum |
| 2023-03 | 3 | Patient satisfaction score:｜Patient satisfaction score: |
| 2023-15 | 9 | HAMA｜HAMA |
| 2023-15 | 10 | HAMA｜HAMA |
| 2023-17 | 3 | Bristol Stool Scale｜Bristol Stool Scale |
| 2023-18 | 3 | VAS｜VAS |
| 2023-19 | 5 | APECE II score｜APECE II score |
| 2023-23 | 4 | mBI｜mBI |
| 2023-23 | 5 | mRS｜mRS |
| 2023-26 | 1 | N-PASS scores｜N-PASS scores |
| 2023-27 | 11 | CDAI｜CDAI |
| 2023-27 | 12 | CDAI｜CDAI |
| 2023-27 | 13 | SDAI｜SDAI |
| 2023-27 | 14 | SDAI｜SDAI |
| 2023-29 | 1 | VAS score of operator satisfaction｜VAS |
| 2023-29 | 2 | VAS score of patient satisfaction｜VAS |
| 2023-29 | 3 | KPS value｜KPS value |
| 2023-29 | 4 | quality of life｜EQ-5D-3L index |
| 2024-01 | 4 | orgasm｜FAFI-orgasm |
| 2024-01 | 5 | satifaciton｜FAFI-satifaciton |
| 2024-01 | 6 | dyspareunia｜FAFI-dyspareunia |
| 2024-01 | 7 | FAFI total score｜FAFI total score |
| 2024-01 | 8 | marital satisfaction｜Enrich Marital Satisfaction Scale |
| 2024-03 | 1 | XQ score｜XQ score |
| 2024-03 | 2 | XQ score｜XQ score |
| 2024-10 | 8 | National Institutes of Health Stroke Scale｜National Institutes of Health Stroke Scale |
| 2024-10 | 9 | Stroke-Specific Quality of Life Scale｜Stroke-Specific Quality of Life Scale |
| 2024-10 | 10 | Stroke and Aphasia Quality of Life Scale–39-Composite score｜Stroke and Aphasia Quality of Life Scale–39-Composite score |
| 2024-10 | 11 | Stroke and Aphasia Quality of Life Scale–39-mean score｜Stroke and Aphasia Quality of Life Scale–39-mean score |
| 2024-10 | 12 | Stroke and Aphasia Quality of Life Scale–39-Physical score｜Stroke and Aphasia Quality of Life Scale–39-Physical score |
| 2024-10 | 13 | Stroke and Aphasia Quality of Life Scale–39-Communication score｜Stroke and Aphasia Quality of Life Scale–39-Communication score |
| 2024-10 | 14 | Stroke and Aphasia Quality of Life Scale–39-Psychological score｜Stroke and Aphasia Quality of Life Scale–39-Psychological score |
| 2024-10 | 15 | Health Scale of Traditional Chinese Medicine score｜Health Scale of Traditional Chinese Medicine score |
| 2024-21 | 1 | MoCA score｜MoCA score |
| 2024-21 | 2 | Visual space/execution｜MoCA score |
| 2024-21 | 3 | name｜MoCA score |
| 2024-21 | 4 | notice｜MoCA score |
| 2024-21 | 5 | langue｜MoCA score |
| 2024-22 | 2 | JOA (Japanese Orthopedic Association) score｜JOA (Japanese Orthopedic Association) score |
| 2024-28 | 3 | EQ-5D-5L general health score at discharge｜EQ-5D-5L general health score at discharge |
| 2024-28 | 4 | EQ-5D-5L general health score at discharge｜EQ-5D-5L general health score at discharge |
| 2024-29 | 3 | WOMAC-stiffness｜WOMAC |
| 2024-29 | 4 | WOMAC-physical function｜WOMAC |
| 2024-29 | 5 | SF-6D utility｜SF-6D |
| 2025-01 | 1 | NIHSS score change (baseline to day 14)｜NIHSS score change (baseline to day 14) |
| 2025-01 | 3 | BI score change｜BI score change |
| 2025-01 | 4 | mRS change｜mRS change |
| 2025-03 | 6 | WHOQOL_x0002_Psychological domain｜WHOQOL_Psychological domain |
| 2025-03 | 7 | WHOQOL-Social domain｜WHOQOL-Social domain |
| 2025-03 | 8 | WHOQOL_x0002_Environmen｜WHOQOL_Environmen |
| 2025-04 | 5 | Fear-Avoidance (FABQ)｜FABQ |
| 2025-04 | 6 | Anxiety (PROMIS T-score)｜PROMIS-29 |
| 2025-04 | 7 | Depression (PROMIS T-score)｜PROMIS-29 |
| 2025-04 | 8 | Fatigue (PROMIS T-score)｜PROMIS-29 |
| 2025-04 | 9 | Sleep Disturbance (PROMIS T-score)｜PROMIS-29 |
| 2025-06 | 3 | WHOQOL-BREF total score｜WHOQOL-BREF |
| 2025-06 | 4 | WHOQOL-BREF Physical domain｜WHOQOL-BREF |
| 2025-06 | 5 | WHOQOL-BREF Psychological domain｜WHOQOL-BREF |
| 2025-06 | 6 | WHOQOL-BREF Social domain｜WHOQOL-BREF |
| 2025-06 | 7 | WHOQOL-BREF Environmental domain｜WHOQOL-BREF |
| 2025-06 | 8 | NSNS (Newcastle Nursing Satisfaction Scale)｜NSNS |
| 2025-08 | 5 | SF-12 total score｜SF-12 |
| 2025-08 | 6 | SF-12 total score｜SF-12 |
| 2025-08 | 7 | PCS, physical component score｜PCS, physical component score |
| 2025-08 | 8 | PCS, physical component score｜PCS, physical component score |
| 2025-08 | 9 | MCS, mental component score;｜MCS, mental component score; |
| 2025-08 | 10 | MCS, mental component score;｜MCS, mental component score; |
| 2025-10 | 1 | MoCA｜MoCA |
| 2025-10 | 2 | MoCA｜MoCA |
| 2025-16 | 1 | PIPP scores｜PIPP scores |
| 2025-19 | 4 | EQ-5D-5L change (baseline to 3 days)｜EQ-5D-5L |
| 2025-24 | 1 | General comfort score during anesthesia recovery｜General comfort score during anesthesia recovery |
| 2025-24 | 2 | Anesthesia recovery anxiety visual score｜Anesthesia recovery anxiety visual score |
| 2025-25 | 1 | Intestinal motility recovery index｜Intestinal motility recovery index |
| 2025-25 | 10 | QoR-15-mental health｜QoR-15-mental health |
| 2025-25 | 11 | QoR-15-social funcitoning｜QoR-15-social funcitoning |
| 2025-25 | 12 | QoR-15-role emotional｜QoR-15-role emotional |
| 2025-25 | 14 | QoR-15-general health oerceptions｜QoR-15-general health oerceptions |
| 2025-25 | 15 | QoR-15-vitality｜QoR-15-vitality |
| 2025-30 | 2 | DIQL｜DIQL |
| 2025-32 | 2 | SAS｜SAS |
| 2025-32 | 3 | SDS｜SDS |
