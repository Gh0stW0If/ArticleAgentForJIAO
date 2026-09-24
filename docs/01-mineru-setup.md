# MinerU 本地部署记录（已验证可用）

> 环境：Windows / AMD Ryzen 5 5600 / 32GB RAM / **RTX 2060 6GB**（Turing sm_75）
> 结论：**MinerU 3.4.5 + pipeline 后端 + GPU 已在本地跑通**，11 页 PDF 耗时 ~46 秒。

## 1. 网络限制（决定了整套安装路径）

| 目标 | 状态 | 影响 |
|---|---|---|
| `pypi.org` | 直连 SSL 会断 | 必须用镜像 |
| **`pypi.tuna.tsinghua.edu.cn`** | 列表页 200，但**下载 `/packages/...` 返回 403** | ❌ 不可用，别再试 |
| **`mirrors.aliyun.com`** | ✅ 完全可用 | **主镜像** |
| `github.com` / `raw.githubusercontent.com` | ❌ 不通 | 不能用 GitHub Release 安装 |
| `huggingface.co` | ❌ 不通 | 模型必须走 ModelScope |
| `www.modelscope.cn` | ✅ 可用 | 模型源 |
| `download.pytorch.org` | 索引页 200，但**下载跳 `download-r2.pytorch.org` 时 TLS handshake EOF** | ❌ 官方 torch 装不了 |
| **`mirrors.aliyun.com/pytorch-wheels/`** | ✅ 可用 | **CUDA torch 来源** |
| **`mirror.nju.edu.cn/github-release/`** | ✅ 可用 | python-build-standalone 来源 |

> 关键教训：清华镜像的 403 会让 pip 报出误导性的 `No matching distribution found`，看起来像包不存在，实际是下载被拒。**遇到该报错先用 `mirrors.aliyun.com` 复核。**

## 2. Python 版本陷阱

- 系统只有 **Python 3.14.6**，而 `mineru` 声明 `Requires-Python: >=3.10,<3.14`。
- pip 在 3.14 下对 `mineru` 一律报 `No matching distribution found`（版本被过滤，不是网络问题）。
- 另外 **PyMuPDF 没有 3.14 的 wheel**，源码编译也失败 → 别用 PyMuPDF。

**解决**：用 `uv` 装独立 Python 3.12，不污染系统 Python。

## 3. 安装步骤（可复现）

```powershell
# 1) uv（从系统 3.14 装，uv 本身与 Python 版本无关）
python -m pip install uv --index-url https://mirrors.aliyun.com/pypi/simple/

$uv  = "C:\Users\Administrator\AppData\Local\Python\pythoncore-3.14-64\Scripts\uv.exe"
$env:UV_DEFAULT_INDEX           = "https://mirrors.aliyun.com/pypi/simple/"
$env:UV_PYTHON_INSTALL_MIRROR   = "https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/"

# 2) Python 3.12.14 + venv（装在项目内 runtime/mineru）
& $uv python install 3.12
& $uv venv runtime/mineru --python 3.12

# 3) CUDA torch —— 必须用阿里云 pytorch-wheels 的【直接 wheel URL】
#    uv 不认 download.pytorch.org 风格的 --extra-index-url，且官方 CDN 会被 TLS 阻断
& $uv pip install --python runtime/mineru/Scripts/python.exe `
    "https://mirrors.aliyun.com/pytorch-wheels/cu126/torch-2.9.1+cu126-cp312-cp312-win_amd64.whl" `
    "https://mirrors.aliyun.com/pytorch-wheels/cu126/torchvision-0.24.1+cu126-cp312-cp312-win_amd64.whl"

# 4) MinerU（注意：必须先装 torch，否则会从 PyPI 拉到 CPU 版 torch）
& $uv pip install --python runtime/mineru/Scripts/python.exe "mineru[pipeline]==3.4.5"

# 5) MinerU 3.4.5 的打包遗漏：缺 six，否则 pipeline 后端 import 直接崩
& $uv pip install --python runtime/mineru/Scripts/python.exe six

# 6) pipeline 模型（走 ModelScope）
$env:MINERU_MODEL_SOURCE = "modelscope"
runtime/mineru/Scripts/mineru-models-download.exe -s modelscope -m pipeline
```

### 踩过的坑
1. **torch 版本会被静默降级**：先装 `mineru[pipeline]` 会从 PyPI 拉到 `torch==2.14.0+cpu`（CUDA 不可用）。**必须先装 CUDA torch。**
2. **`uv pip install --extra-index-url` 无效**：uv 不接受 pytorch 那种索引，必须给 wheel 直链。
3. **`six` 缺失**：mineru 3.4.5 的依赖声明不全，装完仍差 `six`。
4. 自定义 wheel 文件名里的 `+` 在镜像 HTML 里是 `&#43;`，拼直链时需解码。

## 4. 验证结果

```
torch          : 2.9.1+cu126
cuda_available : True
built cuda     : 12.6
device         : NVIDIA GeForce RTX 2060
vram           : 6.0 GB, sm_75
matmul test    : OK
mineru         : 3.4.5
```

解析 `Datas/articles/2015/-2015-01.pdf`（11 页）：

```powershell
$env:MINERU_MODEL_SOURCE = "local"   # 模型已下载，避免每次联网校验
mineru -p "Datas\articles\2015\-2015-01.pdf" -o build\mineru_test -b pipeline -m txt
```

**耗时 45.8 秒 / 11 页，显存占用可控。**

### 输出文件

| 文件 | 用途 |
|---|---|
| `<name>.md` | 49KB，标题层级 + 公式 + 表格的 Markdown |
| **`<name>_content_list.json`** | **136 个扁平条目**，含 `bbox`/`page_idx`/`type` — **管线的首选输入** |
| `<name>_content_list_v2.json` | 按页组织（11 页），富文本 span（`equation_inline` 带 LaTeX） |
| `<name>_middle.json` | 1.4MB，完整中间表示（版面 + span + 坐标） |
| `<name>_model.json` | 282KB，模型原始输出 |
| `<name>_layout.pdf` / `_span.pdf` | 版面可视化，**便于人工核对抽取结果** |
| `images/*.jpg` | 8 张切图（表格/图），**多模态识别图表的输入** |

### `content_list.json` 条目类型分布（136 条）

```
text: 80   header: 16   footer: 13   page_number: 10
table: 6   page_footnote: 5   aside_text: 3   list: 2   image: 1
```

`header`/`footer`/`page_number` 共 39 条属于页眉页脚噪声 → **清洗规则直接可写**。

### 表格抽取实况（对比之前的失败）

```
table[0] page_idx=3  caption=["Table 1 Descriptive analysis of baseline clinical ..."]
         table_body = 5584 字符完整 HTML（含 colspan）
         table_footnote = ["FIQ, Fibromyalgia Impact Questionnaire test score; ..."]
table[1] page_idx=4  table_body = 0 字符  caption=[""]     ← 跨页续表，需要拼接
```

**关键发现：6 个表格中 5 个有完整 HTML，1 个是跨页续表（空 body）。**
对比此前 `.article_agent_hybrid` 里 PyMuPDF 的 6 个表格**全部为空**、公式 `status: unavailable` —— 现在拿到的是完整表格 HTML 与 `\chi ^ { 2 }` 这类 LaTeX 公式。**需求 2「图表信息稳定」的根因（MinerU 从未真正启用）已解决。**

→ 但**跨页表格拼接**必须自己实现，这是下一步要专门处理的点。

### 公式

`content_list_v2.json` 中以内联 span 形式给出，例：`{"type":"equation_inline","content":"\\chi ^ { 2 }"}`。
模型目录含 **PP-FormulaNet_plus-M.pth（617MB）**，即公式识别模型。

## 5. 模型与配置位置

```
mineru.json : C:\Users\Administrator\mineru.json
pipeline    : C:\Users\Administrator\.cache\modelscope\models\OpenDataLab--PDF-Extract-Kit-1.0\snapshots\master
vlm         : (空 — 未下载 VLM 模型)
model-source: modelscope
```

## 6. 后端选择（待定，需实测显存）

MinerU 3.4.5 支持 `pipeline` / `vlm-engine` / `hybrid-engine`（默认 `hybrid-engine`）。
**当前只验证了 `pipeline`。** RTX 2060 只有 6GB 显存，VLM 后端能否装下需要实测。

建议：**以 `pipeline` 为主**（离线、确定性、表格/公式已可用），VLM/hybrid 作为对照实验，而不是主路径。
理由：数据抽取任务最重要的是**可追溯、可复现、不产生幻觉**；VLM 对数值型证据（事件数、CI 上下限）有编造风险。

## 7. 媒体保真：表格与图片一张都不能丢（上游硬要求）

要求：MinerU 流程**必须保留所有表格与图片信息**。这条不能靠"读代码觉得没丢"来保证，
因此加了可复现的审计：`pnpm mineru:media`（`tools/mineru_media_audit.mjs`），按篇逐层计数

```
_middle.json 顶层 table/image 块  →  MiniDoc 块（type=table/figure）  →  各 SKILL 材料窗口
```

任一层数量下降就报错并指出丢在哪一层。当前 2015 六篇结果：

| 文章 | 原始（表/图） | MiniDoc | 材料可达 |
|---|---|---|---|
| 2015-01 | 7（6/1） | 7 | 7 |
| 2015-02 | 6（4/2） | 6 | 6 |
| 2015-03 | 5（3/2） | 5 | 5 |
| 2015-04 | 6（6/0） | 6 | 6 |
| 2015-05 | 4（2/2） | 4 | 4 |
| 2015-06 | 5（2/3） | 5 | 5 |

**审计过程中真抓到过两次丢媒体**（都已修，并补了回归测试）：

1. **`references` 章节里的补充材料表被当噪声丢掉**。补充材料常排在参考文献之后，
   MinerU 于是把 `eTable 1` 归到 `references` 章节。实测 2015-02 的
   `eTable 1 Symptom scores at baseline, at end of treatment…`（3300 字符的结局数据表）
   就是这样整张消失的。
   修法：真表格用 caption 特征单独放行（`Table 2` / `eTable 1` / `Supplementary Table 3`），
   只排除"参考文献列表被误判成表"的那类伪表格（无 caption、窄网格）。

2. **超容量裁剪时"从后往前丢"把补充材料表优先丢掉**。原先的实现按块序从尾部丢，
   看似合理，但论文的最后往往正是补充材料表。
   修法：**先丢正文块，表格与图片留到最后**；只有材料几乎全是媒体时才继续丢媒体。

另外 `text` 为空的表块也不能丢：MinerU 偶尔给出 `text=''` 但自带 `html`/`grid`/切图的表
（实测 2015-01 第 5 页就有这样的块），判据必须是 `text || grid || html || imagePath` 四者之一非空。
