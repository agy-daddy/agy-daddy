'use strict';

/**
 * 12 Clean-Room MIT Original Tribute Themes (Pure declarative OverlaySceneSpec)
 * Strictly free of forbidden gate colors and external assets.
 */

function makeEyeLayers(lx, rx, y, color = '#0f172a', r = 4.2, highlight = '#ffffff') {
  return [
    {
      id: 'eye-l',
      kind: 'circle',
      cx: lx,
      cy: y,
      r,
      fill: color,
      pivotX: lx,
      pivotY: y,
      motion: { blinkIntervalMs: 3200, states: ['idle', 'thinking', 'walking', 'trotting', 'sprinting', 'approval'] }
    },
    {
      id: 'eye-r',
      kind: 'circle',
      cx: rx,
      cy: y,
      r,
      fill: color,
      pivotX: rx,
      pivotY: y,
      motion: { blinkIntervalMs: 3200, states: ['idle', 'thinking', 'walking', 'trotting', 'sprinting', 'approval'] }
    },
    {
      id: 'eye-hl-l',
      kind: 'circle',
      cx: lx - 1.2,
      cy: y - 1.3,
      r: Math.max(1.2, r * 0.35),
      fill: highlight,
      motion: { states: ['idle', 'thinking', 'walking', 'trotting', 'sprinting', 'approval'] }
    },
    {
      id: 'eye-hl-r',
      kind: 'circle',
      cx: rx - 1.2,
      cy: y - 1.3,
      r: Math.max(1.2, r * 0.35),
      fill: highlight,
      motion: { states: ['idle', 'thinking', 'walking', 'trotting', 'sprinting', 'approval'] }
    },
    {
      id: 'eye-sleep-l',
      kind: 'path',
      d: `M${lx - r} ${y} Q${lx} ${y + 3} ${lx + r} ${y}`,
      fill: 'none',
      stroke: color,
      strokeWidth: 2.2,
      motion: { states: ['sleeping'] }
    },
    {
      id: 'eye-sleep-r',
      kind: 'path',
      d: `M${rx - r} ${y} Q${rx} ${y + 3} ${rx + r} ${y}`,
      fill: 'none',
      stroke: color,
      strokeWidth: 2.2,
      motion: { states: ['sleeping'] }
    }
  ];
}

const BUILTIN_THEMES = [
  {
    id: 'daddy-orb',
    name: { 'zh-CN': '紫晶脉冲灵', en: 'Agy Pulse Sprite' },
    description: { 'zh-CN': '跟随宿主主题强调色的双环悬浮几何小精灵', en: 'Floating dual-ring geometric sprite synced to host accent' },
    accentHex: '#a78bfa',
    usesHostAccent: true,
    scene: {
      sceneId: 'daddy-orb',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 28, y: 24, width: 104, height: 112 },
      particles: { preset: 'sparks', color: '#c4b5fd' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 138, rx: 32, ry: 8, fill: '#0f172a', opacity: 0.25 },
        {
          id: 'outer-ring', kind: 'circle', cx: 80, cy: 82, r: 46,
          fill: 'none', stroke: '#a78bfa', strokeWidth: 3.5, opacity: 0.55,
          pivotX: 80, pivotY: 82, motion: { rotAmpDeg: 18, rotFreqHz: 0.8, bobAmpY: 4, bobFreqHz: 1.2 }
        },
        {
          id: 'core', kind: 'circle', cx: 80, cy: 82, r: 34,
          fill: '#7c3aed', stroke: '#ddd6fe', strokeWidth: 2.5,
          pivotX: 80, pivotY: 82, motion: { bobAmpY: 5, bobFreqHz: 1.4 }
        },
        {
          id: 'ear-l', kind: 'path', d: 'M52 56 L42 32 L66 48 Z',
          fill: '#a78bfa', stroke: '#ede9fe', strokeWidth: 1.5,
          pivotX: 56, pivotY: 50, motion: { rotAmpDeg: 8, rotFreqHz: 1.8, bobAmpY: 5, bobFreqHz: 1.4 }
        },
        {
          id: 'ear-r', kind: 'path', d: 'M108 56 L118 32 L94 48 Z',
          fill: '#a78bfa', stroke: '#ede9fe', strokeWidth: 1.5,
          pivotX: 104, pivotY: 50, motion: { rotAmpDeg: -8, rotFreqHz: 1.8, bobAmpY: 5, bobFreqHz: 1.4 }
        },
        {
          id: 'visor', kind: 'rect', x: 54, y: 68, width: 52, height: 26, cornerRadius: 13,
          fill: '#1e1b4b', stroke: '#c4b5fd', strokeWidth: 1.5,
          motion: { bobAmpY: 5, bobFreqHz: 1.4 }
        },
        ...makeEyeLayers(68, 92, 81, '#ede9fe', 4.5, '#a78bfa')
      ]
    }
  },
  {
    id: 'abyssal-whale',
    name: { 'zh-CN': '深海算力鲸', en: 'Abyssal Whale' },
    description: { 'zh-CN': '深海钴蓝渐变流线小鲸鱼，流式吐字头顶喷水花', en: 'Cobalt stream-lined whale with data spout bubbles' },
    accentHex: '#60a5fa',
    scene: {
      sceneId: 'abyssal-whale',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 20, y: 34, width: 120, height: 96 },
      particles: { preset: 'bubbles', color: '#93c5fd' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 136, rx: 38, ry: 8, fill: '#0f172a', opacity: 0.24 },
        {
          id: 'tail', kind: 'path', d: 'M116 86 Q138 72 144 58 Q134 78 144 96 Q130 94 116 90 Z',
          fill: '#1d4ed8', stroke: '#93c5fd', strokeWidth: 1.5,
          pivotX: 118, pivotY: 88, motion: { rotAmpDeg: 14, rotFreqHz: 2.2, bobAmpY: 4, bobFreqHz: 1.3 }
        },
        {
          id: 'body', kind: 'path', d: 'M30 88 C30 56 58 46 84 48 C110 50 124 68 122 92 C120 112 96 118 72 118 C46 118 30 108 30 88 Z',
          fill: '#2563eb', stroke: '#93c5fd', strokeWidth: 2,
          motion: { bobAmpY: 4.5, bobFreqHz: 1.3 }
        },
        {
          id: 'belly', kind: 'path', d: 'M36 94 C44 108 66 114 90 110 C104 108 114 100 116 94 C98 100 62 100 36 94 Z',
          fill: '#dbeafe', motion: { bobAmpY: 4.5, bobFreqHz: 1.3 }
        },
        {
          id: 'spout', kind: 'path', d: 'M72 48 Q66 30 56 26 M74 48 Q82 28 92 26',
          fill: 'none', stroke: '#60a5fa', strokeWidth: 3,
          motion: { bobAmpY: 7, bobFreqHz: 2.6, states: ['walking', 'trotting', 'sprinting', 'approval'] }
        },
        ...makeEyeLayers(54, 76, 82, '#0f172a', 3.8, '#ffffff')
      ]
    }
  },
  {
    id: 'sunny-sponge',
    name: { 'zh-CN': '阳光海绵块', en: 'Sunny Sponge' },
    description: { 'zh-CN': '波浪边明黄多孔方块精灵，带快乐表情与泡泡', en: 'Sunny wavy yellow block sprite with bouncy bubbles' },
    accentHex: '#facc15',
    scene: {
      sceneId: 'sunny-sponge',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 34, y: 26, width: 92, height: 112 },
      particles: { preset: 'bubbles', color: '#fef08a' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 140, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.24 },
        {
          id: 'body', kind: 'rect', x: 44, y: 36, width: 72, height: 78, cornerRadius: 12,
          fill: '#facc15', stroke: '#ca8a04', strokeWidth: 2.2,
          pivotX: 80, pivotY: 75, motion: { bobAmpY: 5, bobFreqHz: 1.7, rotAmpDeg: 4, rotFreqHz: 1.7 }
        },
        { id: 'pore-1', kind: 'circle', cx: 55, cy: 48, r: 4, fill: '#eab308', motion: { bobAmpY: 5, bobFreqHz: 1.7 } },
        { id: 'pore-2', kind: 'circle', cx: 105, cy: 52, r: 3.5, fill: '#eab308', motion: { bobAmpY: 5, bobFreqHz: 1.7 } },
        {
          id: 'trousers', kind: 'rect', x: 44, y: 94, width: 72, height: 20, cornerRadius: 4,
          fill: '#78350f', stroke: '#451a03', strokeWidth: 1.5, motion: { bobAmpY: 5, bobFreqHz: 1.7 }
        },
        { id: 'tie', kind: 'path', d: 'M80 96 L75 108 L80 114 L85 108 Z', fill: '#dc2626', motion: { bobAmpY: 5, bobFreqHz: 1.7 } },
        { id: 'eye-bg-l', kind: 'circle', cx: 67, cy: 66, r: 9, fill: '#ffffff', stroke: '#0f172a', strokeWidth: 1.4, motion: { bobAmpY: 5, bobFreqHz: 1.7 } },
        { id: 'eye-bg-r', kind: 'circle', cx: 93, cy: 66, r: 9, fill: '#ffffff', stroke: '#0f172a', strokeWidth: 1.4, motion: { bobAmpY: 5, bobFreqHz: 1.7 } },
        ...makeEyeLayers(67, 93, 66, '#0284c7', 4.2, '#ffffff'),
        { id: 'smile', kind: 'path', d: 'M64 81 Q80 92 96 81', fill: 'none', stroke: '#78350f', strokeWidth: 2.2, motion: { bobAmpY: 5, bobFreqHz: 1.7 } }
      ]
    }
  },
  {
    id: 'nimble-mouse',
    name: { 'zh-CN': '机灵芝士鼠', en: 'Nimble Mouse' },
    description: { 'zh-CN': '暖褐圆耳小仓鼠，抱奶酪欢快奔跑', en: 'Warm brown round-eared mouse clutching golden cheese' },
    accentHex: '#f59e0b',
    scene: {
      sceneId: 'nimble-mouse',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 30, y: 32, width: 100, height: 106 },
      particles: { preset: 'sparks', color: '#fde68a' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 138, rx: 34, ry: 7, fill: '#0f172a', opacity: 0.25 },
        {
          id: 'tail', kind: 'path', d: 'M110 112 Q136 106 138 82 Q139 70 128 66',
          fill: 'none', stroke: '#f472b6', strokeWidth: 4,
          pivotX: 110, pivotY: 112, motion: { rotAmpDeg: 14, rotFreqHz: 2.5 }
        },
        { id: 'ear-l', kind: 'circle', cx: 52, cy: 52, r: 16, fill: '#b45309', stroke: '#78350f', strokeWidth: 2, motion: { bobAmpY: 4, bobFreqHz: 2.0 } },
        { id: 'ear-l-in', kind: 'circle', cx: 52, cy: 52, r: 9, fill: '#fbcfe8', motion: { bobAmpY: 4, bobFreqHz: 2.0 } },
        { id: 'ear-r', kind: 'circle', cx: 104, cy: 52, r: 16, fill: '#b45309', stroke: '#78350f', strokeWidth: 2, motion: { bobAmpY: 4, bobFreqHz: 2.0 } },
        { id: 'ear-r-in', kind: 'circle', cx: 104, cy: 52, r: 9, fill: '#fbcfe8', motion: { bobAmpY: 4, bobFreqHz: 2.0 } },
        {
          id: 'body', kind: 'ellipse', cx: 78, cy: 92, rx: 36, ry: 34,
          fill: '#b45309', stroke: '#78350f', strokeWidth: 2,
          motion: { bobAmpY: 4.5, bobFreqHz: 2.0 }
        },
        { id: 'belly', kind: 'ellipse', cx: 78, cy: 104, rx: 22, ry: 18, fill: '#fde68a', motion: { bobAmpY: 4.5, bobFreqHz: 2.0 } },
        ...makeEyeLayers(65, 91, 82, '#0f172a', 4, '#ffffff'),
        { id: 'nose', kind: 'circle', cx: 78, cy: 90, r: 3.2, fill: '#f43f5e', motion: { bobAmpY: 4.5, bobFreqHz: 2.0 } },
        { id: 'cheese', kind: 'path', d: 'M90 106 L112 98 L110 118 Z', fill: '#facc15', stroke: '#ca8a04', strokeWidth: 1.5, motion: { bobAmpY: 5, bobFreqHz: 2.0 } }
      ]
    }
  },
  {
    id: 'aegis-visor',
    name: { 'zh-CN': '赤金机甲盔', en: 'Aegis Visor' },
    description: { 'zh-CN': '钛红赤金科幻面甲，眼缝带冰蓝 HUD 扫描光', en: 'Crimson-gold mecha helmet with ice-cyan HUD visor' },
    accentHex: '#eab308',
    scene: {
      sceneId: 'aegis-visor',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 34, y: 24, width: 92, height: 112 },
      particles: { preset: 'sparks', color: '#67e8f9' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 138, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.25 },
        {
          id: 'helmet', kind: 'path', d: 'M44 60 L54 30 L106 30 L116 60 L112 108 L92 126 L68 126 L48 108 Z',
          fill: '#dc2626', stroke: '#7f1d1d', strokeWidth: 2.2,
          motion: { bobAmpY: 4, bobFreqHz: 1.2 }
        },
        {
          id: 'faceplate', kind: 'path', d: 'M56 54 L104 54 L100 102 L88 118 L72 118 L60 102 Z',
          fill: '#eab308', stroke: '#854d0e', strokeWidth: 1.8,
          motion: { bobAmpY: 4, bobFreqHz: 1.2 }
        },
        { id: 'brow', kind: 'path', d: 'M56 66 L74 72 L86 72 L104 66', fill: 'none', stroke: '#7f1d1d', strokeWidth: 3, motion: { bobAmpY: 4, bobFreqHz: 1.2 } },
        {
          id: 'hud-l', kind: 'rect', x: 59, y: 74, width: 16, height: 6, cornerRadius: 2,
          fill: '#67e8f9', stroke: '#ecfeff', strokeWidth: 1,
          motion: { bobAmpY: 4, bobFreqHz: 1.2, blinkIntervalMs: 4200 }
        },
        {
          id: 'hud-r', kind: 'rect', x: 85, y: 74, width: 16, height: 6, cornerRadius: 2,
          fill: '#67e8f9', stroke: '#ecfeff', strokeWidth: 1,
          motion: { bobAmpY: 4, bobFreqHz: 1.2, blinkIntervalMs: 4200 }
        },
        { id: 'reactor', kind: 'circle', cx: 80, cy: 106, r: 5, fill: '#67e8f9', stroke: '#0891b2', strokeWidth: 1.5, motion: { bobAmpY: 4, bobFreqHz: 1.2 } }
      ]
    }
  },
  {
    id: 'cyber-neko',
    name: { 'zh-CN': '霓虹义体猫', en: 'Cyber Neko' },
    description: { 'zh-CN': '曜石黑紫机械耳小猫，单侧全息瞄准镜与光纤尾', en: 'Obsidian cyber-cat with holographic monocle and fiber tail' },
    accentHex: '#c084fc',
    scene: {
      sceneId: 'cyber-neko',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 32, y: 28, width: 96, height: 110 },
      particles: { preset: 'matrix', color: '#2dd4bf' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 138, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.25 },
        {
          id: 'tail', kind: 'path', d: 'M108 114 Q138 104 134 74',
          fill: 'none', stroke: '#2dd4bf', strokeWidth: 4,
          pivotX: 108, pivotY: 114, motion: { rotAmpDeg: 16, rotFreqHz: 2.0 }
        },
        { id: 'ear-l', kind: 'path', d: 'M48 64 L44 30 L72 52 Z', fill: '#1e1b4b', stroke: '#c084fc', strokeWidth: 2, motion: { bobAmpY: 4, bobFreqHz: 1.5 } },
        { id: 'ear-r', kind: 'path', d: 'M112 64 L116 30 L88 52 Z', fill: '#1e1b4b', stroke: '#c084fc', strokeWidth: 2, motion: { bobAmpY: 4, bobFreqHz: 1.5 } },
        { id: 'body', kind: 'ellipse', cx: 80, cy: 90, rx: 36, ry: 34, fill: '#1e1b4b', stroke: '#c084fc', strokeWidth: 2.2, motion: { bobAmpY: 4, bobFreqHz: 1.5 } },
        { id: 'monocle', kind: 'rect', x: 84, y: 74, width: 18, height: 12, cornerRadius: 4, fill: '#14b8a6', opacity: 0.75, stroke: '#5eead4', strokeWidth: 1.5, motion: { bobAmpY: 4, bobFreqHz: 1.5 } },
        ...makeEyeLayers(66, 93, 80, '#e9d5ff', 4, '#2dd4bf')
      ]
    }
  },
  {
    id: 'arcade-chomp',
    name: { 'zh-CN': '街机像素豆', en: 'Arcade Chomp' },
    description: { 'zh-CN': '8-bit 经典像素圆豆与伴飞像素小灵', en: '8-bit retro chomper with pixel companion dot' },
    accentHex: '#facc15',
    scene: {
      sceneId: 'arcade-chomp',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 26, y: 34, width: 108, height: 98 },
      particles: { preset: 'pixels', color: '#fde047' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 74, cy: 136, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.25 },
        {
          id: 'chomp-body', kind: 'path', d: 'M74 82 L108 60 A40 40 0 1 0 108 104 Z',
          fill: '#facc15', stroke: '#a16207', strokeWidth: 2.2,
          pivotX: 74, pivotY: 82, motion: { bobAmpY: 4, bobFreqHz: 1.8, rotAmpDeg: 6, rotFreqHz: 3.0 }
        },
        { id: 'chomp-eye', kind: 'circle', cx: 74, cy: 58, r: 4.5, fill: '#0f172a', motion: { bobAmpY: 4, bobFreqHz: 1.8 } },
        {
          id: 'pellet', kind: 'rect', x: 118, y: 76, width: 10, height: 10, cornerRadius: 2,
          fill: '#f43f5e', stroke: '#fda4af', strokeWidth: 1.5,
          motion: { swayAmpX: 6, swayFreqHz: 2.2, bobAmpY: 3, bobFreqHz: 2.2 }
        }
      ]
    }
  },
  {
    id: 'astro-shiba',
    name: { 'zh-CN': '星航柴犬', en: 'Astro Shiba' },
    description: { 'zh-CN': '透明宇航头盔与氧气喷射背包小柴犬', en: 'Space-helmet Shiba Inu with dual thruster backpack' },
    accentHex: '#d97706',
    scene: {
      sceneId: 'astro-shiba',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 28, y: 24, width: 104, height: 114 },
      particles: { preset: 'exhaust', color: '#a78bfa' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 140, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.24 },
        { id: 'jetpack', kind: 'rect', x: 40, y: 74, width: 18, height: 42, cornerRadius: 6, fill: '#94a3b8', stroke: '#475569', strokeWidth: 1.8, motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'suit', kind: 'rect', x: 52, y: 84, width: 56, height: 42, cornerRadius: 14, fill: '#f8fafc', stroke: '#94a3b8', strokeWidth: 2, motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'ear-l', kind: 'path', d: 'M56 54 L50 32 L70 46 Z', fill: '#d97706', motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'ear-r', kind: 'path', d: 'M104 54 L110 32 L90 46 Z', fill: '#d97706', motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'head', kind: 'circle', cx: 80, cy: 66, r: 26, fill: '#d97706', motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'cheeks', kind: 'ellipse', cx: 80, cy: 76, rx: 20, ry: 12, fill: '#fef3c7', motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        ...makeEyeLayers(70, 90, 64, '#0f172a', 3.6, '#ffffff'),
        { id: 'nose', kind: 'circle', cx: 80, cy: 72, r: 3, fill: '#0f172a', motion: { bobAmpY: 5, bobFreqHz: 1.4 } },
        { id: 'dome', kind: 'circle', cx: 80, cy: 64, r: 34, fill: '#e0f2fe', opacity: 0.25, stroke: '#bae6fd', strokeWidth: 2.2, motion: { bobAmpY: 5, bobFreqHz: 1.4 } }
      ]
    }
  },
  {
    id: 'vapor-dolphin',
    name: { 'zh-CN': '蒸汽波海豚', en: 'Vapor Dolphin' },
    description: { 'zh-CN': '粉紫镭射渐变海豚与落日透视网格底座', en: 'Synthwave magenta-violet dolphin over retro horizon sun' },
    accentHex: '#ec4899',
    scene: {
      sceneId: 'vapor-dolphin',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 26, y: 26, width: 108, height: 110 },
      particles: { preset: 'stars', color: '#f472b6' },
      layers: [
        { id: 'sun', kind: 'circle', cx: 80, cy: 78, r: 44, fill: '#f43f5e', opacity: 0.35 },
        { id: 'grid-1', kind: 'path', d: 'M32 114 L128 114 M24 124 L136 124 M40 134 L120 134', fill: 'none', stroke: '#ec4899', strokeWidth: 1.8, opacity: 0.7 },
        {
          id: 'dolphin', kind: 'path', d: 'M34 94 C44 60 82 48 108 66 C118 74 124 88 134 96 C122 98 112 96 106 90 C94 102 68 104 48 96 L34 104 Z',
          fill: '#8b5cf6', stroke: '#f472b6', strokeWidth: 2.2,
          pivotX: 80, pivotY: 84, motion: { bobAmpY: 6, bobFreqHz: 1.5, rotAmpDeg: 7, rotFreqHz: 1.5 }
        },
        { id: 'fin', kind: 'path', d: 'M72 60 L82 40 L88 58 Z', fill: '#ec4899', motion: { bobAmpY: 6, bobFreqHz: 1.5 } },
        ...makeEyeLayers(60, 74, 82, '#fdf4ff', 3.2, '#ec4899')
      ]
    }
  },
  {
    id: 'cli-phantom',
    name: { 'zh-CN': '终端光标灵', en: 'CLI Phantom' },
    description: { 'zh-CN': '极客暗黑终端窗口幻化小幽灵，带荧光绿光标', en: 'Dark terminal ghost sprite with glowing emerald prompt' },
    accentHex: '#22c55e',
    scene: {
      sceneId: 'cli-phantom',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 32, y: 26, width: 96, height: 112 },
      particles: { preset: 'matrix', color: '#4ade80' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 138, rx: 30, ry: 7, fill: '#0f172a', opacity: 0.3 },
        {
          id: 'cloak', kind: 'path', d: 'M44 74 C44 42 60 32 80 32 C100 32 116 42 116 74 L116 122 L102 112 L90 124 L80 112 L70 124 L58 112 L44 122 Z',
          fill: '#18181b', stroke: '#22c55e', strokeWidth: 2.2,
          motion: { bobAmpY: 5, bobFreqHz: 1.3 }
        },
        ...makeEyeLayers(67, 93, 68, '#22c55e', 4.2, '#bbf7d0'),
        { id: 'prompt', kind: 'path', d: 'M62 88 L72 94 L62 100', fill: 'none', stroke: '#22c55e', strokeWidth: 2.5, motion: { bobAmpY: 5, bobFreqHz: 1.3 } },
        { id: 'cursor', kind: 'rect', x: 78, y: 95, width: 14, height: 4, cornerRadius: 1, fill: '#4ade80', motion: { bobAmpY: 5, bobFreqHz: 1.3, blinkIntervalMs: 1100 } }
      ]
    }
  },
  {
    id: 'graffiti-cub',
    name: { 'zh-CN': '街头涂鸦熊', en: 'Graffiti Cub' },
    description: { 'zh-CN': '圆耳潮流积木关节小熊，撞色几何涂鸦徽章', en: 'Art-toy geometric bear with pop-art asymmetrical accents' },
    accentHex: '#f43f5e',
    scene: {
      sceneId: 'graffiti-cub',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 32, y: 22, width: 96, height: 118 },
      particles: { preset: 'pixels', color: '#f43f5e' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 140, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.24 },
        { id: 'ear-l', kind: 'circle', cx: 52, cy: 40, r: 12, fill: '#f43f5e', stroke: '#18181b', strokeWidth: 2, motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        { id: 'ear-r', kind: 'circle', cx: 108, cy: 40, r: 12, fill: '#8b5cf6', stroke: '#18181b', strokeWidth: 2, motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        { id: 'torso', kind: 'rect', x: 52, y: 86, width: 56, height: 42, cornerRadius: 10, fill: '#18181b', stroke: '#eab308', strokeWidth: 2, motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        { id: 'badge', kind: 'path', d: 'M72 98 L88 98 L80 116 Z', fill: '#eab308', motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        { id: 'head', kind: 'rect', x: 48, y: 40, width: 64, height: 48, cornerRadius: 18, fill: '#f8fafc', stroke: '#18181b', strokeWidth: 2.2, motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        { id: 'slash', kind: 'path', d: 'M84 42 L108 66 L108 50 L96 42 Z', fill: '#f43f5e', motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } },
        ...makeEyeLayers(66, 94, 64, '#18181b', 4, '#ffffff'),
        { id: 'snout', kind: 'ellipse', cx: 80, cy: 76, rx: 10, ry: 6, fill: '#8b5cf6', motion: { bobAmpY: 3.5, bobFreqHz: 1.5 } }
      ]
    }
  },
  {
    id: 'arcane-cat',
    name: { 'zh-CN': '奥术黑猫', en: 'Arcane Cat' },
    description: { 'zh-CN': '星月紫巫师帽与发光魔杖的二次元黑猫学徒', en: 'Mystic black cat apprentice with wizard hat and glowing wand' },
    accentHex: '#8b5cf6',
    scene: {
      sceneId: 'arcane-cat',
      viewBox: { width: 160, height: 160 },
      fps: { active: 30, idle: 12, sleep: 4 },
      hitBox: { x: 28, y: 18, width: 104, height: 122 },
      particles: { preset: 'stars', color: '#fde047' },
      layers: [
        { id: 'shadow', kind: 'ellipse', cx: 80, cy: 140, rx: 32, ry: 7, fill: '#0f172a', opacity: 0.26 },
        {
          id: 'tail', kind: 'path', d: 'M106 116 Q134 106 130 78',
          fill: 'none', stroke: '#1e1b4b', strokeWidth: 5,
          pivotX: 106, pivotY: 116, motion: { rotAmpDeg: 14, rotFreqHz: 1.8 }
        },
        { id: 'body', kind: 'ellipse', cx: 80, cy: 100, rx: 30, ry: 32, fill: '#18181b', stroke: '#6d28d9', strokeWidth: 1.8, motion: { bobAmpY: 4, bobFreqHz: 1.4 } },
        { id: 'head', kind: 'circle', cx: 80, cy: 76, r: 26, fill: '#18181b', stroke: '#6d28d9', strokeWidth: 1.8, motion: { bobAmpY: 4, bobFreqHz: 1.4 } },
        { id: 'hat-brim', kind: 'ellipse', cx: 80, cy: 52, rx: 38, ry: 9, fill: '#6d28d9', stroke: '#a78bfa', strokeWidth: 1.5, motion: { bobAmpY: 4, bobFreqHz: 1.4 } },
        { id: 'hat-cone', kind: 'path', d: 'M56 50 L82 14 L104 50 Z', fill: '#5b21b6', stroke: '#a78bfa', strokeWidth: 1.5, motion: { bobAmpY: 4, bobFreqHz: 1.4 } },
        ...makeEyeLayers(70, 90, 76, '#facc15', 4.2, '#ffffff'),
        { id: 'wand', kind: 'path', d: 'M108 108 L130 78', fill: 'none', stroke: '#a16207', strokeWidth: 3, motion: { bobAmpY: 5, bobFreqHz: 2.0, rotAmpDeg: 10, rotFreqHz: 2.0 } },
        { id: 'wand-star', kind: 'circle', cx: 132, cy: 76, r: 6, fill: '#fde047', stroke: '#f59e0b', strokeWidth: 1.5, motion: { bobAmpY: 5, bobFreqHz: 2.0 } }
      ]
    }
  }
];

function getBuiltinThemes() {
  return BUILTIN_THEMES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    accentHex: t.accentHex,
    usesHostAccent: Boolean(t.usesHostAccent),
    builtin: true,
    scene: t.scene
  }));
}

function getBuiltinThemeById(themeId) {
  const clean = String(themeId || '').trim();
  return BUILTIN_THEMES.find((t) => t.id === clean) || BUILTIN_THEMES[0];
}

module.exports = {
  BUILTIN_THEMES,
  getBuiltinThemes,
  getBuiltinThemeById
};
