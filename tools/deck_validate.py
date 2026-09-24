# tools/deck_validate.py — 校验生成的 PPTX：XML 良构 + 关系完整 + 渲染成 PNG 供人眼检查
#
# 用法：
#   python tools/deck_validate.py                        # 只做静态校验
#   python tools/deck_validate.py --render               # 再用 PowerPoint 导出 PNG
#
# 为什么单独有这一步：make_deck.mjs 只能保证 ZIP/XML 结构自洽，
# 「PowerPoint 能否打开、版面有没有压字/出框」必须真渲染一次才知道。

import sys
import os
import glob
import zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PPTX = glob.glob(os.path.join(ROOT, 'build', 'deck', '*.pptx'))
if not PPTX:
    print('FAIL: 没找到 build/deck/*.pptx，请先运行 node tools/make_deck.mjs')
    sys.exit(1)
PPTX = PPTX[0]
OUT = os.path.join(ROOT, 'build', 'deck', 'png')

print(f'file: {PPTX}  ({(os.path.getsize(PPTX)/1024):.1f} KB)')

ok = True
with zipfile.ZipFile(PPTX) as z:
    bad = z.testzip()
    if bad:
        print(f'  FAIL zip.testzip -> {bad}')
        ok = False
    names = z.namelist()
    print(f'  entries: {len(names)}')

    # 1) 所有 xml/rels 必须良构
    parsed = {}
    for n in names:
        if n.endswith(('.xml', '.rels')):
            try:
                parsed[n] = ET.fromstring(z.read(n))
            except ET.ParseError as e:
                print(f'  FAIL XML {n}: {e}')
                ok = False
    print(f'  well-formed xml/rels: {len(parsed)}/{sum(1 for n in names if n.endswith((".xml", ".rels")))}')

    # 2) presentation.xml 里引用的每个 rId 都得在 rels 里存在
    P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
    R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
    pres = parsed['ppt/presentation.xml']
    rels = parsed['ppt/_rels/presentation.xml.rels']
    rel_ids = {r.get('Id') for r in rels}
    rid_used = {e.get(R + 'id') for e in pres.iter() if e.get(R + 'id')}
    missing = rid_used - rel_ids
    if missing:
        print(f'  FAIL presentation.xml 引用了不存在的 rId: {sorted(missing)}')
        ok = False
    slide_ids = [e.get(R + 'id') for e in pres.iter(f'{P}sldId')]
    print(f'  slides referenced: {len(slide_ids)}')

    # 3) 每张幻灯片都要有对应的 xml + rels，且几何都在画布内
    sldSz = pres.find(f'{P}sldSz')
    CW, CH = int(sldSz.get('cx')), int(sldSz.get('cy'))
    A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
    k = 9525
    off_canvas = []
    for i in range(1, len(slide_ids) + 1):
        s = f'ppt/slides/slide{i}.xml'
        if s not in names:
            print(f'  FAIL 缺少 {s}')
            ok = False
            continue
        if s.replace('slides/', 'slides/_rels/') + '.rels' not in names:
            print(f'  FAIL 缺少 {s} 的 rels')
            ok = False
        for xfrm in parsed[s].iter(f'{A}xfrm'):
            o, e = xfrm.find(f'{A}off'), xfrm.find(f'{A}ext')
            if o is None or e is None:
                continue
            x, y = int(o.get('x')) // k, int(o.get('y')) // k
            w, h = int(e.get('cx')) // k, int(e.get('cy')) // k
            if x < -2 or y < -2 or x > 1280 or y > 720 or w > 1400 or h > 900:
                off_canvas.append((i, x, y, w, h))
    if off_canvas:
        print(f'  WARN 有形状超出画布(1280x720): {off_canvas[:6]}')
    else:
        print('  geometry: 所有形状均在 1280x720 画布内')

print('STATIC:', 'PASS' if ok else 'FAIL')

if '--render' not in sys.argv:
    sys.exit(0 if ok else 1)

# 4) 用 PowerPoint COM 真渲染成 PNG（PowerPoint 会直接暴露「需要修复」这类问题）
try:
    import win32com.client  # noqa
except ImportError:
    print('RENDER: 跳过 —— 未安装 pywin32（pip install pywin32）')
    sys.exit(0 if ok else 1)

import shutil
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT, exist_ok=True)

app = win32com.client.Dispatch('PowerPoint.Application')
pres_ = app.Presentations.Open(PPTX, WithWindow=False)
n = pres_.Slides.Count
pres_.Export(OUT, 'PNG', 1280, 720)
pres_.Close()
app.Quit()
pngs = sorted(glob.glob(os.path.join(OUT, '*.PNG')) + glob.glob(os.path.join(OUT, '*.png')))
print(f'RENDER: {n} 张幻灯片 -> {len(pngs)} 个 PNG  @ {OUT}')
