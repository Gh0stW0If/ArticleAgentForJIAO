/**
 * 设计令牌（配色 / 圆角 / 阴影）——取自设计参考图的**真实像素**。
 *
 * 采样方式：`tools/_png_sample.mjs`（自写的极简 PNG 解码器 + 区域颜色直方图），
 * 而不是凭肉眼猜。取到的关键值：
 *
 *   墨色（标题、logo 底、激活 chip 底）  #1b212b
 *   琥珀主色（章节标签、卡片左边条）      #c17a2e / #d4903f
 *   琥珀浅底（确认按钮、提示条）          #faecd8 / #fffbeb
 *   画布底（PDF 区）                      #edf0f4
 *   面板底（右栏）                        #f5f7fa
 *   卡片 / 顶栏 / 工具栏                  #ffffff
 *   分隔线                                #e9ecf1 / #dedfe2 / #cacdd1
 *   四个动作按钮文字色                    蓝 #3b82f6、琥珀 #d4903f、靛 #6366f1、翠 #059669
 *
 * 约定：组件里**只用这里的令牌**，不再散落硬编码色值——否则下一次调整又得到处翻。
 */

export const T = {
  /* 文字 */
  ink: '#1b212b',
  text: '#323b4a',
  muted: '#646b76',
  faint: '#818ea1',

  /* 表面 */
  bg: '#ffffff',
  canvas: '#edf0f4',
  panel: '#f5f7fa',
  soft: '#f5f7fa',

  /* 线与描边 */
  border: '#e9ecf1',
  borderStrong: '#dedfe2',
  borderFaint: '#cacdd1',

  /* 主色（琥珀）+ 浅底 */
  amber: '#c17a2e',
  amberBright: '#d4903f',
  amberTint: '#faecd8',
  amberSoft: '#fffbeb',

  /* 语义色（与参考图的四个动作按钮一致） */
  blue: '#3b82f6',
  indigo: '#6366f1',
  emerald: '#059669',
  red: '#dc2626',
  cyan: '#0891b2',
} as const;

/** 圆角（参考图：卡片 12 / 按钮 6 / chip 全圆 / 输入 6 / 页卡 8）。 */
export const R = {
  card: 12,
  btn: 6,
  pill: 999,
  input: 6,
  page: 8,
} as const;

/** 阴影：卡片是"几乎看不出但确实存在"的一层，页面卡片略深。 */
export const SH = {
  card: '0 1px 2px rgba(27,33,43,.05), 0 2px 6px rgba(27,33,43,.06)',
  page: '0 2px 10px rgba(27,33,43,.10)',
  pop: '0 8px 28px rgba(27,33,43,.18)',
} as const;

/** 8% 透明度的同色浅底（用于按钮/徽标，比写死浅色更不容易有色差）。 */
export const tint = (color: string, alpha = '14'): string => `${color}${alpha}`;

/** 主按钮：实心（导入文章这类"唯一主动作"）。 */
export const primaryBtn = (color: string = T.amber): React.CSSProperties => ({
  fontSize: 12,
  padding: '5px 12px',
  borderRadius: R.btn,
  cursor: 'pointer',
  background: color,
  color: '#fff',
  border: `1px solid ${color}`,
  fontWeight: 500,
  whiteSpace: 'nowrap',
});

/** 次级按钮 / 图标按钮：浅底 + 同色描边（参考图里的 编辑/定位/框选/确认）。 */
export const ghostBtn = (color: string = T.muted): React.CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: R.btn,
  cursor: 'pointer',
  background: tint(color, '12'),
  color,
  border: `1px solid ${tint(color, '40')}`,
  whiteSpace: 'nowrap',
});

/** 卡片容器。 */
export const card = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: T.bg,
  border: `1px solid ${T.border}`,
  borderRadius: R.card,
  boxShadow: SH.card,
  ...extra,
});

/** 输入框 / 下拉。 */
export const input = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: T.bg,
  color: T.text,
  border: `1px solid ${T.borderStrong}`,
  borderRadius: R.input,
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
  ...extra,
});

/** 徽标（NR / 人工修改 / 编码推导…）。 */
export const badge = (color: string): React.CSSProperties => ({
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: R.pill,
  background: tint(color, '14'),
  color,
  border: `1px solid ${tint(color, '3a')}`,
  whiteSpace: 'nowrap',
});

/** 字段来源 → 左边条颜色 + 徽标文案。 */
export const PROVENANCE: Record<string, { color: string; label: string }> = {
  model: { color: '#94a3b8', label: 'LLM' },
  human: { color: T.amber, label: '人工' },
  deterministic: { color: T.cyan, label: '编码推导' },
  external: { color: T.indigo, label: 'Crossref' },
};
