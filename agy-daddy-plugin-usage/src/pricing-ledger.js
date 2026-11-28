'use strict';

const USD_TO_CNY_RATE = 7.25;

const CURRENCY_SYMBOLS = Object.freeze({
  USD: '$',
  CNY: '¥',
  JPY: '¥',
  HKD: 'HK$',
  EUR: '€',
  GBP: '£',
  SGD: 'S$',
  TRY: '₺',
  NGN: '₦',
  TWD: 'NT$',
  PHP: '₱',
  INR: '₹',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'AU$',
  MYR: 'RM ',
  KRW: '₩',
  NZD: 'NZ$',
  THB: '฿',
  VND: '₫',
  IDR: 'Rp ',
  PKR: '₨ ',
  MXN: '$',
  ARS: '$',
  CLP: '$',
  COP: '$',
  PEN: 'S/ ',
  CHF: 'CHF ',
  UAH: '₴',
  PLN: 'zł ',
  SEK: 'kr ',
  NOK: 'kr ',
  DKK: 'kr ',
  CZK: 'Kč ',
  HUF: 'Ft ',
  RON: 'lei ',
  ZAR: 'R ',
  EGP: 'E£ ',
  KES: 'KSh ',
  AED: 'AED ',
  SAR: 'SAR ',
  ILS: '₪ '
});

const SUBSCRIPTION_REGIONS_PRESET = Object.freeze([
  { id: 'TW', name: '中国台湾', flag: '🇹🇼', currency: 'TWD', symbol: 'NT$', monthlyPrice: 650, rateToCNY: 0.21, aliases: ['tw', 'ntd', 'twd', 'taiwan', '台湾', '中国台湾', '台区'] },
  { id: 'HK', name: '中国香港', flag: '🇭🇰', currency: 'HKD', symbol: 'HK$', monthlyPrice: 158.00, rateToCNY: 0.857, aliases: ['hk', 'hong kong', '香港', '中国香港', '港区'] },
  { id: 'JP', name: '日本', flag: '🇯🇵', currency: 'JPY', symbol: '¥', monthlyPrice: 2900, rateToCNY: 0.0425, aliases: ['jp', 'japan', '日本', '日区'] },
  { id: 'KR', name: '韩国', flag: '🇰🇷', currency: 'KRW', symbol: '₩', monthlyPrice: 29000, rateToCNY: 0.0051, aliases: ['kr', 'korea', 'south korea', '韩国', '韩区'] },
  { id: 'AU', name: '澳大利亚 (澳区)', flag: '🇦🇺', currency: 'AUD', symbol: 'AU$', monthlyPrice: 32.99, rateToCNY: 4.45, aliases: ['au', 'aud', 'australia', '澳大利亚', '澳洲', '澳区'] },
  { id: 'NZ', name: '新西兰', flag: '🇳🇿', currency: 'NZD', symbol: 'NZ$', monthlyPrice: 34.99, rateToCNY: 4.05, aliases: ['nz', 'nzd', 'new zealand', '新西兰'] },
  { id: 'SG', name: '新加坡', flag: '🇸🇬', currency: 'SGD', symbol: 'S$', monthlyPrice: 27.99, rateToCNY: 5.12, aliases: ['sg', 'singapore', '新加坡', '星洲'] },
  { id: 'MY', name: '马来西亚', flag: '🇲🇾', currency: 'MYR', symbol: 'RM ', monthlyPrice: 97.99, rateToCNY: 1.55, aliases: ['my', 'myr', 'malaysia', '马来西亚', '大马'] },
  { id: 'TH', name: '泰国', flag: '🇹🇭', currency: 'THB', symbol: '฿', monthlyPrice: 750, rateToCNY: 0.20, aliases: ['th', 'thb', 'thailand', '泰国'] },
  { id: 'VN', name: '越南', flag: '🇻🇳', currency: 'VND', symbol: '₫', monthlyPrice: 489000, rateToCNY: 0.00028, aliases: ['vn', 'vnd', 'vietnam', '越南'] },
  { id: 'ID', name: '印度尼西亚', flag: '🇮🇩', currency: 'IDR', symbol: 'Rp ', monthlyPrice: 309000, rateToCNY: 0.00044, aliases: ['id', 'idr', 'indonesia', '印度尼西亚', '印尼'] },
  { id: 'PH', name: '菲律宾', flag: '🇵🇭', currency: 'PHP', symbol: '₱', monthlyPrice: 1100, rateToCNY: 0.117, aliases: ['ph', 'php', 'philippines', '菲律宾'] },
  { id: 'IN', name: '印度', flag: '🇮🇳', currency: 'INR', symbol: '₹', monthlyPrice: 1950, rateToCNY: 0.076, aliases: ['in', 'inr', 'india', '印度', '印区'] },
  { id: 'PK', name: '巴基斯坦', flag: '🇵🇰', currency: 'PKR', symbol: '₨ ', monthlyPrice: 5600, rateToCNY: 0.024, aliases: ['pk', 'pkr', 'pakistan', '巴基斯坦'] },
  { id: 'US', name: '美国', flag: '🇺🇸', currency: 'USD', symbol: '$', monthlyPrice: 19.99, rateToCNY: 6.72, aliases: ['us', 'usa', 'united states', '美国', '美区'] },
  { id: 'CA', name: '加拿大', flag: '🇨🇦', currency: 'CAD', symbol: 'CA$', monthlyPrice: 26.99, rateToCNY: 4.88, aliases: ['ca', 'cad', 'canada', '加拿大'] },
  { id: 'MX', name: '墨西哥', flag: '🇲🇽', currency: 'MXN', symbol: '$', monthlyPrice: 395, rateToCNY: 0.36, aliases: ['mx', 'mxn', 'mexico', '墨西哥'] },
  { id: 'BR', name: '巴西', flag: '🇧🇷', currency: 'BRL', symbol: 'R$', monthlyPrice: 96.99, rateToCNY: 1.18, aliases: ['br', 'brl', 'brazil', '巴西'] },
  { id: 'TR', name: '土耳其', flag: '🇹🇷', currency: 'TRY', symbol: '₺', monthlyPrice: 869.99, rateToCNY: 0.133, aliases: ['tr', 'try', 'turkey', '土耳其', '土区'] },
  { id: 'AR', name: '阿根廷', flag: '🇦🇷', currency: 'ARS', symbol: '$', monthlyPrice: 19999, rateToCNY: 0.0065, aliases: ['ar', 'ars', 'argentina', '阿根廷'] },
  { id: 'CL', name: '智利', flag: '🇨🇱', currency: 'CLP', symbol: '$', monthlyPrice: 18990, rateToCNY: 0.0072, aliases: ['cl', 'clp', 'chile', '智利'] },
  { id: 'CO', name: '哥伦比亚', flag: '🇨🇴', currency: 'COP', symbol: '$', monthlyPrice: 84900, rateToCNY: 0.0016, aliases: ['co', 'cop', 'colombia', '哥伦比亚'] },
  { id: 'PE', name: '秘鲁', flag: '🇵🇪', currency: 'PEN', symbol: 'S/ ', monthlyPrice: 76.90, rateToCNY: 1.82, aliases: ['pe', 'pen', 'peru', '秘鲁'] },
  { id: 'GB', name: '英国', flag: '🇬🇧', currency: 'GBP', symbol: '£', monthlyPrice: 18.99, rateToCNY: 8.75, aliases: ['gb', 'uk', 'gbp', 'united kingdom', '英国', '英区'] },
  { id: 'EU', name: '欧洲/欧盟 (德法意西荷等)', flag: '🇪🇺', currency: 'EUR', symbol: '€', monthlyPrice: 21.99, rateToCNY: 7.52, aliases: ['eu', 'eur', 'euro', 'europe', '欧洲', '欧盟', '德国', '法国', '意大利', '西班牙', '荷兰'] },
  { id: 'CH', name: '瑞士', flag: '🇨🇭', currency: 'CHF', symbol: 'CHF ', monthlyPrice: 17.00, rateToCNY: 7.85, aliases: ['ch', 'chf', 'switzerland', '瑞士'] },
  { id: 'UA', name: '乌克兰', flag: '🇺🇦', currency: 'UAH', symbol: '₴', monthlyPrice: 900, rateToCNY: 0.162, aliases: ['ua', 'uah', 'ukraine', '乌克兰'] },
  { id: 'PL', name: '波兰', flag: '🇵🇱', currency: 'PLN', symbol: 'zł ', monthlyPrice: 97.99, rateToCNY: 1.72, aliases: ['pl', 'pln', 'poland', '波兰'] },
  { id: 'SE', name: '瑞典', flag: '🇸🇪', currency: 'SEK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.65, aliases: ['se', 'sek', 'sweden', '瑞典'] },
  { id: 'NO', name: '挪威', flag: '🇳🇴', currency: 'NOK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.63, aliases: ['no', 'nok', 'norway', '挪威'] },
  { id: 'DK', name: '丹麦', flag: '🇩🇰', currency: 'DKK', symbol: 'kr ', monthlyPrice: 169, rateToCNY: 1.01, aliases: ['dk', 'dkk', 'denmark', '丹麦'] },
  { id: 'CZ', name: '捷克', flag: '🇨🇿', currency: 'CZK', symbol: 'Kč ', monthlyPrice: 529, rateToCNY: 0.30, aliases: ['cz', 'czk', 'czech', '捷克'] },
  { id: 'HU', name: '匈牙利', flag: '🇭🇺', currency: 'HUF', symbol: 'Ft ', monthlyPrice: 8990, rateToCNY: 0.0185, aliases: ['hu', 'huf', 'hungary', '匈牙利'] },
  { id: 'RO', name: '罗马尼亚', flag: '🇷🇴', currency: 'RON', symbol: 'lei ', monthlyPrice: 109.99, rateToCNY: 1.51, aliases: ['ro', 'ron', 'romania', '罗马尼亚'] },
  { id: 'NG', name: '尼日利亚', flag: '🇳🇬', currency: 'NGN', symbol: '₦', monthlyPrice: 28500, rateToCNY: 0.0042, aliases: ['ng', 'ngn', 'nigeria', '尼日利亚', '尼区'] },
  { id: 'ZA', name: '南非', flag: '🇿🇦', currency: 'ZAR', symbol: 'R ', monthlyPrice: 429.99, rateToCNY: 0.38, aliases: ['za', 'zar', 'south africa', '南非'] },
  { id: 'EG', name: '埃及', flag: '🇪🇬', currency: 'EGP', symbol: 'E£ ', monthlyPrice: 999, rateToCNY: 0.136, aliases: ['eg', 'egp', 'egypt', '埃及'] },
  { id: 'KE', name: '肯尼亚', flag: '🇰🇪', currency: 'KES', symbol: 'KSh ', monthlyPrice: 2800, rateToCNY: 0.052, aliases: ['ke', 'kes', 'kenya', '肯尼亚'] },
  { id: 'AE', name: '阿联酋', flag: '🇦🇪', currency: 'AED', symbol: 'AED ', monthlyPrice: 76.99, rateToCNY: 1.83, aliases: ['ae', 'aed', 'uae', 'emirates', '阿联酋', '迪拜'] },
  { id: 'SA', name: '沙特阿拉伯', flag: '🇸🇦', currency: 'SAR', symbol: 'SAR ', monthlyPrice: 85.99, rateToCNY: 1.79, aliases: ['sa', 'sar', 'saudi', '沙特', '沙特阿拉伯'] },
  { id: 'IL', name: '以色列', flag: '🇮🇱', currency: 'ILS', symbol: '₪ ', monthlyPrice: 79.90, rateToCNY: 1.85, aliases: ['il', 'ils', 'israel', '以色列'] },
  { id: 'CN', name: '中国大陆 (CNY)', flag: '🇨🇳', currency: 'CNY', symbol: '¥', monthlyPrice: 140.00, rateToCNY: 1.0, aliases: ['cn', 'cny', 'china', '中国', '人民币', '国内'] }
]);

function findRegionPreset(regionQuery) {
  if (!regionQuery || typeof regionQuery !== 'string') return null;
  const q = regionQuery.trim().toLowerCase();
  if (!q) return null;
  return SUBSCRIPTION_REGIONS_PRESET.find((r) => (
    r.id.toLowerCase() === q ||
    r.name.toLowerCase() === q ||
    r.aliases.some((a) => a.toLowerCase() === q || q.includes(a.toLowerCase()))
  )) || null;
}

function convertToCNY(amount, currency, regionQuery = null) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
  const num = Number(amount);
  if (num === 0) return 0;
  let cur = String(currency || '').trim().toUpperCase();
  if (cur === 'NTD') cur = 'TWD';
  if (cur === 'CNY') return Number(num.toFixed(2));
  if (cur === 'USD') return Number((num * USD_TO_CNY_RATE).toFixed(2));

  let preset = findRegionPreset(regionQuery);
  if (!preset || (cur && preset.currency !== cur)) {
    preset = SUBSCRIPTION_REGIONS_PRESET.find((r) => r.currency === cur) || null;
  }
  const rate = preset ? preset.rateToCNY : null;
  if (!rate) return null;
  return Number((num * rate).toFixed(2));
}

const GEMINI_PRICING_TABLE = {
  'gemini-3.8-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  // 内部过渡版 Flash（介于 3.6 Flash 与 3.8 Flash 之间，上下两代官方定价完全一致）
  'gemini-3.7-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  'gemini-3.6-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  'gemini-3-flash': [
    { inputPerMillion: 0.50, outputPerMillion: 3.00, cacheReadPerMillion: 0.05 }
  ],
  'gemini-4-hydrogen': [
    { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.075 }
  ],
  'gemini-4-neon': [
    { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.15 }
  ],
  'gemini-4-carbon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-4-argon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-3.1-pro-preview': [
    { maxPromptTokens: 200000, inputPerMillion: 2.00, outputPerMillion: 12.00, cacheReadPerMillion: 0.20 },
    { minPromptTokens: 200001, inputPerMillion: 4.00, outputPerMillion: 18.00, cacheReadPerMillion: 0.40 }
  ],
  'gemini-3.5-flash-lite': [
    { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 }
  ],
  'gemini-3.1-flash-lite': [
    { inputPerMillion: 0.25, outputPerMillion: 1.50, cacheReadPerMillion: 0.025 }
  ],
  'gemini-2.5-pro': [
    { maxPromptTokens: 200000, inputPerMillion: 1.25, outputPerMillion: 10.00, cacheReadPerMillion: 0.125 },
    { minPromptTokens: 200001, inputPerMillion: 2.50, outputPerMillion: 15.00, cacheReadPerMillion: 0.25 }
  ],
  'gemini-2.5-flash': [
    { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 }
  ],
  'gemini-2.5-flash-lite': [
    { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01 }
  ],
  'claude-opus-5-5': [
    { inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'claude-sonnet-5-5': [
    { inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 }
  ],
  'claude-opus-4-6': [
    { inputPerMillion: 5.00, outputPerMillion: 25.00, cacheReadPerMillion: 0.50 }
  ],
  'claude-sonnet-4-6': [
    { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.30 }
  ]
};

const ULTRA_SUB_TIER_PRESETS = {
  '5x': {
    id: '5x',
    label: 'Ultra 5x',
    tierName: 'Google AI Ultra (5x)',
    quotaMultiplier: 5,
    officialPriceMonthly: 99.99,
    flowCreditsMonthly: 10000,
    developerCreditsMonthlyUSD: 40
  },
  '20x': {
    id: '20x',
    label: 'Ultra 20x',
    tierName: 'Google AI Ultra (20x)',
    quotaMultiplier: 20,
    officialPriceMonthly: 199.99,
    flowCreditsMonthly: 25000,
    developerCreditsMonthlyUSD: 100
  }
};

function normalizeUltraSubTier(val) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim().toLowerCase();
  if (s === '5x' || s === 'ultra-5x' || s === 'ultra_5x' || s === 'ultra 5x') return '5x';
  if (s === '20x' || s === 'ultra-20x' || s === 'ultra_20x' || s === 'ultra 20x') return '20x';
  return null;
}

function detectSubscriptionFromUserStatus(userStatusRes) {
  const userStatus = userStatusRes?.userStatus || userStatusRes || null;
  if (!userStatus || typeof userStatus !== 'object') {
    return { detectedTier: null, detectedSubTier: null, detectedLabel: null, source: 'none' };
  }
  const userTier = userStatus.userTier && typeof userStatus.userTier === 'object' ? userStatus.userTier : {};
  const planInfo = userStatus.planStatus?.planInfo && typeof userStatus.planStatus.planInfo === 'object'
    ? userStatus.planStatus.planInfo
    : {};
  const tierText = [
    userTier.id,
    userTier.name,
    userTier.description,
    userStatus.subscriptionTier,
    userStatus.tier
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b20x\b|ultra[-_ ]?20x/i.test(tierText)) {
    return { detectedTier: 'ultra', detectedSubTier: '20x', detectedLabel: '20X', source: 'userTier' };
  }
  if (/\b5x\b|ultra[-_ ]?5x/i.test(tierText)) {
    return { detectedTier: 'ultra', detectedSubTier: '5x', detectedLabel: '5X', source: 'userTier' };
  }
  if (/g1-ultra|\bultra\b/i.test(tierText)) {
    const flexAmt = Number(planInfo.monthlyFlexCreditPurchaseAmount || 0) || 0;
    const creditAmts = (Array.isArray(userTier.availableCredits) ? userTier.availableCredits : [])
      .map((c) => Number(c?.creditAmount || c?.amount || 0) || 0);
    const maxCredit = Math.max(flexAmt, ...creditAmts, 0);
    if (maxCredit >= 20000) {
      return { detectedTier: 'ultra', detectedSubTier: '20x', detectedLabel: '20X', source: 'userTier+credits' };
    }
    if (maxCredit >= 8000) {
      return { detectedTier: 'ultra', detectedSubTier: '5x', detectedLabel: '5X', source: 'userTier+credits' };
    }
    return { detectedTier: 'ultra', detectedSubTier: null, detectedLabel: 'Ultra', source: 'userTier' };
  }
  if (/g1-pro|\bpro\b/i.test(tierText)) {
    return { detectedTier: 'pro', detectedSubTier: null, detectedLabel: 'Pro', source: 'userTier' };
  }
  const planText = `${planInfo.planName || ''} ${planInfo.teamsTier || ''}`.trim();
  if (!tierText && /\bpro\b|teams_tier_pro/i.test(planText)) {
    return { detectedTier: 'pro', detectedSubTier: null, detectedLabel: 'Pro', source: 'planInfo' };
  }
  if (/\bfree\b|standard|basic/i.test(tierText)) {
    return { detectedTier: 'free', detectedSubTier: null, detectedLabel: 'Free', source: 'userTier' };
  }
  return { detectedTier: null, detectedSubTier: null, detectedLabel: null, source: 'unknown' };
}

function formatLocalDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim().toLowerCase().replace(/^word\//, '');
  if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
  if (str.includes('3.7-flash') || str.includes('3.7 flash')) return 'gemini-3.7-flash';
  if (str.includes('3.6-flash') || str.includes('3.6 flash')) return 'gemini-3.6-flash';
  if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) {
    if (str.includes('3.1')) return 'gemini-3.1-flash-lite';
    if (str.includes('2.5')) return 'gemini-2.5-flash-lite';
    return 'gemini-3.5-flash-lite';
  }
  if (str.includes('3.1-flash-lite') || str.includes('3.1 flash-lite')) return 'gemini-3.1-flash-lite';
  if (str.includes('2.5-flash-lite') || str.includes('2.5 flash-lite')) return 'gemini-2.5-flash-lite';
  if (str.includes('2.5-flash') || str.includes('2.5 flash')) return 'gemini-2.5-flash';
  if ((str.includes('3.5-flash') || str.includes('3.5 flash')) && !str.includes('flash-lite')) return 'gemini-3.5-flash';
  if (/\bgemini-3-flash(?:-[a-z0-9]+)?\b/.test(str) || str.includes('3 flash')) return 'gemini-3-flash';
  if (str.includes('4-hydrogen') || str.includes('4 hydrogen') || str.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (str.includes('4-carbon') || str.includes('4 carbon') || str.includes('carbon') || str.includes('m670')) return 'gemini-4-carbon';
  if (str.includes('4-neon') || str.includes('4 neon') || /\bneon\b/.test(str) || str.includes('m532')) return 'gemini-4-neon';
  if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(str) || str.includes('m668')) {
    return 'gemini-4-argon';
  }
  if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
  if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
  if (/(?:opus[-_ ]5[._-]5|5[._-]5[-_ ]opus)/.test(str)) return 'claude-opus-5-5';
  if (/(?:sonnet[-_ ]5[._-]5|5[._-]5[-_ ]sonnet)/.test(str)) return 'claude-sonnet-5-5';
  if (/(?:opus[-_ ]4[._-]6|4[._-]6[-_ ]opus)/.test(str)) return 'claude-opus-4-6';
  if (/(?:sonnet[-_ ]4[._-]6|4[._-]6[-_ ]sonnet)/.test(str)) return 'claude-sonnet-4-6';
  return null;
}

function resolveModelBucketKey(req) {
  const rawModel = String(req?.modelKey || req?.model || req?.modelId || req?.modelExactId || req?.modelLabel || '').trim();
  const normalized = normalizeModelId(rawModel);
  if (normalized) return normalized;
  if (!rawModel) return 'unknown';
  const cleaned = rawModel
    .toLowerCase()
    .replace(/^word\//, '')
    .replace(/\s*\((?:high|xhigh|medium|low|thinking|orchestrator)\)\s*$/i, '')
    .replace(/-(?:high|xhigh|medium|low)$/i, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || 'unknown';
}

function calculateRequestApiCost(req) {
  if (!req || typeof req !== 'object') {
    return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
  }
  const rawModel = String(req.modelKey || req.model || req.modelId || req.modelExactId || req.modelLabel || '').trim();
  const modelKey = normalizeModelId(rawModel);
  if (!modelKey || !GEMINI_PRICING_TABLE[modelKey]) {
    return { costUSD: null, isPriced: false, modelKey: modelKey || null, rawModel, reason: !rawModel ? '缺模型名称' : '未知模型或无官方公开费率' };
  }

  const input = Math.max(0, Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0) || 0);
  const cache = Math.max(0, Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0) || 0);
  const output = Math.max(0, Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0) || 0);
  const totalPrompt = input + cache;

  let reqDate = '2026-11-08';
  if (req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date)) && !req.dateIsProvisional) {
    reqDate = String(req.date).slice(0, 10);
  } else if (req.created_at) {
    const dt = new Date(req.created_at);
    if (!Number.isNaN(dt.getTime())) reqDate = formatLocalDateStr(dt);
  } else if (req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date))) {
    reqDate = String(req.date).slice(0, 10);
  }

  const tierRules = GEMINI_PRICING_TABLE[modelKey];
  let matchedTier = null;
  for (const rule of tierRules) {
    if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
    if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
    if (rule.maxPromptTokens && totalPrompt > rule.maxPromptTokens) continue;
    if (rule.minPromptTokens && totalPrompt < rule.minPromptTokens) continue;
    matchedTier = rule;
    break;
  }
  if (!matchedTier) matchedTier = tierRules[0];

  const costInput = (input * matchedTier.inputPerMillion) / 1000000;
  const costCache = (cache * matchedTier.cacheReadPerMillion) / 1000000;
  const costOutput = (output * matchedTier.outputPerMillion) / 1000000;
  const totalCost = Number((costInput + costCache + costOutput).toFixed(6));

  return {
    costUSD: totalCost,
    isPriced: true,
    modelKey,
    matchedTier,
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output
  };
}

function isGeminiModel(req) {
  if (!req || typeof req !== 'object') return false;
  const apiProvider = String(req.apiProvider || req.chatModel?.usage?.apiProvider || '').toLowerCase();
  if (apiProvider.includes('google_gemini') || apiProvider.includes('gemini')) return true;
  if (apiProvider.includes('anthropic') || apiProvider.includes('claude') || apiProvider.includes('openai')) return false;

  const raw = String(req.modelKey || req.model || req.modelId || req.modelExactId || req.modelLabel || '').trim().toLowerCase();
  if (!raw) return false;
  if (/claude|opus|sonnet|haiku|gpt|o1|o3|o4|deepseek|llama|qwen|mistral/i.test(raw)) return false;
  if (/gemini|orchestrator|hydrogen|carbon|argon|neon|flash|m532|m668|m670/i.test(raw)) return true;
  return false;
}

function filterCallsBySource(calls = [], scope = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const includeIde = scope?.includeIdeUsage !== false;
  const includeCli = scope?.includeCliUsage !== false;
  if (includeIde && includeCli) return list;
  if (!includeIde && !includeCli) return [];
  return list.filter((c) => {
    const isCli = String(c?.source || '').trim().toLowerCase() === 'cli';
    return isCli ? includeCli : includeIde;
  });
}

function resolveSubscriptionCost(plan = {}) {
  const p = (plan && typeof plan === 'object') ? plan : {};
  const hasExplicitRegionalConfig = Boolean(
    p.subscriptionRegion ||
    p.region ||
    p.subscriptionCurrency ||
    p.priceMode ||
    p.billingCycle
  );

  // 兼容旧签名 summarizeByPeriod(calls, nowMs, { actualPaidUsd: 2 })
  if (!hasExplicitRegionalConfig && p.actualPaidUsd !== undefined && p.actualPaidUsd !== null) {
    const flatUsd = Math.max(0, Number(p.actualPaidUsd) || 0);
    return {
      regionId: 'US',
      regionName: '美国',
      regionFlag: '🇺🇸',
      subscriptionCurrency: 'USD',
      subscriptionCurrencySymbol: '$',
      priceMode: 'custom',
      billingCycle: 'monthly',
      actualPaidNative: flatUsd,
      monthlyNative: flatUsd,
      monthlyCostUsd: Number(flatUsd.toFixed(4)),
      monthlyCostCny: Number((flatUsd * USD_TO_CNY_RATE).toFixed(2)),
      isLegacyFlatPaid: true
    };
  }

  const regionPreset = findRegionPreset(p.subscriptionRegion || p.region || p.country || 'US') || findRegionPreset('US');
  let rawCur = String(p.subscriptionCurrency || '').trim().toUpperCase();
  if (rawCur === 'NTD') rawCur = 'TWD';
  const subCurrency = (rawCur && rawCur !== 'AUTO' && CURRENCY_SYMBOLS[rawCur])
    ? rawCur
    : regionPreset.currency;
  const subSymbol = CURRENCY_SYMBOLS[subCurrency] || regionPreset.symbol || `${subCurrency} `;
  const billingCycle = ['monthly', 'yearly', 'free'].includes(p.billingCycle) ? p.billingCycle : 'monthly';
  const priceMode = p.priceMode === 'custom' ? 'custom' : 'preset';

  if (billingCycle === 'free') {
    return {
      regionId: regionPreset.id,
      regionName: regionPreset.name,
      regionFlag: regionPreset.flag,
      subscriptionCurrency: subCurrency,
      subscriptionCurrencySymbol: subSymbol,
      priceMode,
      billingCycle: 'free',
      actualPaidNative: 0,
      monthlyNative: 0,
      monthlyCostUsd: 0,
      monthlyCostCny: 0,
      isLegacyFlatPaid: false
    };
  }

  let nativeAmount = 0;
  if (priceMode === 'custom') {
    const rawCustom = p.actualPricePaid !== undefined && p.actualPricePaid !== null
      ? p.actualPricePaid
      : p.actualPaidUsd;
    nativeAmount = Math.max(0, Number(rawCustom) || 0);
  } else {
    const subTier = normalizeUltraSubTier(p.ultraSubTier || p.detectedSubTier);
    if (regionPreset.id === 'US' && subTier && ULTRA_SUB_TIER_PRESETS[subTier]) {
      nativeAmount = Number(ULTRA_SUB_TIER_PRESETS[subTier].officialPriceMonthly);
    } else {
      nativeAmount = Number(regionPreset.monthlyPrice || 0);
    }
    if (billingCycle === 'yearly') {
      nativeAmount = Number((nativeAmount * 12).toFixed(2));
    }
  }

  const monthlyNative = billingCycle === 'yearly'
    ? Number((nativeAmount / 12).toFixed(4))
    : Number(nativeAmount.toFixed(4));

  let monthlyCostUsd = 0;
  let monthlyCostCny = 0;
  if (subCurrency === 'USD') {
    monthlyCostUsd = Number(monthlyNative.toFixed(4));
    monthlyCostCny = Number((monthlyNative * USD_TO_CNY_RATE).toFixed(2));
  } else if (subCurrency === 'CNY') {
    monthlyCostCny = Number(monthlyNative.toFixed(2));
    monthlyCostUsd = Number((monthlyNative / USD_TO_CNY_RATE).toFixed(4));
  } else {
    const rateRegion = regionPreset.currency === subCurrency ? regionPreset.id : null;
    monthlyCostCny = convertToCNY(monthlyNative, subCurrency, rateRegion) ?? 0;
    monthlyCostUsd = Number((monthlyCostCny / USD_TO_CNY_RATE).toFixed(4));
  }

  return {
    regionId: regionPreset.id,
    regionName: regionPreset.name,
    regionFlag: regionPreset.flag,
    subscriptionCurrency: subCurrency,
    subscriptionCurrencySymbol: subSymbol,
    priceMode,
    billingCycle,
    actualPaidNative: Number(nativeAmount.toFixed(2)),
    monthlyNative,
    monthlyCostUsd,
    monthlyCostCny,
    isLegacyFlatPaid: false
  };
}

function summarizeApiCost(requests = []) {
  let totalUsd = 0;
  let totalTokens = 0;
  let geminiTokens = 0;
  let otherTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  const byModel = {};

  for (const req of Array.isArray(requests) ? requests : []) {
    const res = calculateRequestApiCost(req);
    const inTok = Math.max(0, Number(req?.inputTokens ?? req?.input ?? 0) || 0);
    const cTok = Math.max(0, Number(req?.cacheReadTokens ?? req?.cacheTokens ?? 0) || 0);
    const outTok = Math.max(0, Number(req?.outputTokens ?? 0) || 0);
    const sumTok = inTok + cTok + outTok;

    totalTokens += sumTok;
    inputTokens += inTok;
    cacheReadTokens += cTok;
    outputTokens += outTok;
    if (isGeminiModel(req)) {
      geminiTokens += sumTok;
    } else {
      otherTokens += sumTok;
    }

    const mk = res.isPriced ? res.modelKey : resolveModelBucketKey(req);
    if (!byModel[mk]) byModel[mk] = { calls: 0, tokens: 0, costUSD: 0, isPriced: false };
    byModel[mk].calls++;
    byModel[mk].tokens += sumTok;

    if (res.isPriced) {
      pricedCount++;
      totalUsd += res.costUSD;
      byModel[mk].isPriced = true;
      byModel[mk].costUSD = Number((byModel[mk].costUSD + res.costUSD).toFixed(6));
    } else {
      unpricedCount++;
    }
  }

  return {
    callsCount: (Array.isArray(requests) ? requests.length : 0),
    pricedCount,
    unpricedCount,
    totalUsd: Number(totalUsd.toFixed(6)),
    totalTokens,
    geminiTokens,
    otherTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    byModel
  };
}

function buildHeatmap52Weeks(calls = [], nowMs = Date.now()) {
  const dailyMap = new Map();
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c) continue;
    let dateStr = c.date && /^\d{4}-\d{2}-\d{2}/.test(String(c.date)) ? String(c.date).slice(0, 10) : null;
    if (!dateStr && Number.isFinite(Number(c.timestamp))) {
      dateStr = formatLocalDateStr(new Date(Number(c.timestamp)));
    }
    if (!dateStr) continue;
    const tok = Math.max(0, Number(c.totalTokens || ((c.inputTokens || 0) + (c.cacheReadTokens || c.cacheTokens || 0) + (c.outputTokens || 0))) || 0);
    const prev = dailyMap.get(dateStr) || { date: dateStr, tokens: 0, calls: 0, costUSD: 0 };
    prev.tokens += tok;
    prev.calls += 1;
    const cost = calculateRequestApiCost(c);
    if (cost.isPriced) prev.costUSD = Number((prev.costUSD + cost.costUSD).toFixed(6));
    dailyMap.set(dateStr, prev);
  }

  const endDt = new Date(nowMs);
  endDt.setHours(0, 0, 0, 0);
  const days = [];
  let maxTokens = 0;

  for (let i = 363; i >= 0; i--) {
    const dt = new Date(endDt.getTime() - i * 86400000);
    const dStr = formatLocalDateStr(dt);
    const rec = dailyMap.get(dStr) || { date: dStr, tokens: 0, calls: 0, costUSD: 0 };
    if (rec.tokens > maxTokens) maxTokens = rec.tokens;
    days.push(rec);
  }

  for (const d of days) {
    if (d.tokens <= 0 || maxTokens <= 0) d.level = 0;
    else {
      const ratio = d.tokens / maxTokens;
      d.level = ratio >= 0.75 ? 4 : (ratio >= 0.5 ? 3 : (ratio >= 0.25 ? 2 : 1));
    }
  }

  return { weeks: 52, daysCount: days.length, maxTokens, days };
}

const SUBSCRIPTION_ACQUISITION_PRESETS = Object.freeze([
  { id: 'normal_paid', name: '正常付费订阅', category: 'paid', defaultPaid: 19.99, note: '按月或按年全额付费订阅' },
  { id: 'student_offer', name: '学生认证优惠 (Google One AI Student)', category: 'discount', defaultPaid: 0, note: '学生资格试用或折扣权益' },
  { id: 'pixel_bundle', name: 'Google Pixel 设备赠送', category: 'bundle_free', defaultPaid: 0, note: '指定 Pixel 机型附赠权益' },
  { id: 'chromebook_bundle', name: 'Chromebook Plus 设备赠送', category: 'bundle_free', defaultPaid: 0, note: 'Chromebook Plus 赠送权益' },
  { id: 'samsung_galaxy', name: 'Samsung Galaxy 设备指定活动', category: 'bundle_free', defaultPaid: 0, note: 'Galaxy 设备活动赠送权益' }
]);

const VALID_PERIOD_KEYS = Object.freeze(['currentCycle', 'today', 'month', 'year', 'allTime']);
const FIVE_HOUR_MS = 5 * 3600 * 1000;
const WEEKLY_MS = 7 * 24 * 3600 * 1000;
const MONTHLY_FALLBACK_MS = 30 * 24 * 3600 * 1000;
const VALID_TIMESTAMP_MIN_MS = 946684800000;

function normalizePeriodKey(val) {
  return VALID_PERIOD_KEYS.includes(val) ? val : 'allTime';
}

function formatLocalMonthDayTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildCycleWindowMeta({ windowKey, source, isFallback, startAtMs, endAtMs, durationMs }) {
  const dur = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
    ? Number(durationMs)
    : Math.max(1, endAtMs - startAtMs);
  const startText = formatLocalMonthDayTime(startAtMs);
  const endText = formatLocalMonthDayTime(endAtMs);
  return {
    windowKey,
    source,
    isFallback: Boolean(isFallback),
    startAtMs,
    endAtMs,
    durationMs: dur,
    startAtIso: new Date(startAtMs).toISOString(),
    endAtIso: new Date(endAtMs).toISOString(),
    rangeText: `${startText} ~ ${endText}`,
    resetTimeText: isFallback ? null : endText
  };
}

function buildFallbackWeekWindow(nowMs) {
  const d = new Date(nowMs);
  const day = d.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const startDt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday, 0, 0, 0, 0);
  const startAtMs = startDt.getTime();
  const endAtMs = startAtMs + WEEKLY_MS;
  return buildCycleWindowMeta({
    windowKey: 'fallback_week',
    source: 'fallback_week',
    isFallback: true,
    startAtMs,
    endAtMs,
    durationMs: WEEKLY_MS
  });
}

function parseResetTimestampMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 0 && raw < 1e11 ? raw * 1000 : raw;
    return ms > VALID_TIMESTAMP_MIN_MS ? ms : null;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw.trim());
    return Number.isFinite(parsed) && parsed > VALID_TIMESTAMP_MIN_MS ? parsed : null;
  }
  return null;
}

function getPoolPriorityRank(identText) {
  const text = String(identText || '').toLowerCase();
  if (/3p|claude|sonnet|opus/i.test(text)) return 2;
  if (/gemini_main|gemini(?!.*(argon|carbon))/i.test(text)) return 0;
  return 1;
}

function normalizeCycleCandidate(bucket, poolRank, nowMs) {
  if (!bucket || typeof bucket !== 'object') return null;
  if (bucket.hasResetTime === false && !bucket.resetAtMs && !bucket.resetTime && !bucket.reset_time && !bucket.resetTimeIso) {
    return null;
  }
  const resetAtMs = parseResetTimestampMs(
    bucket.resetAtMs ?? bucket.resetTimeIso ?? bucket.resetTime ?? bucket.reset_time
  );
  if (!resetAtMs) return null;

  const idStr = [
    bucket.windowKey,
    bucket.window,
    bucket.bucketId,
    bucket.id,
    bucket.windowLabel
  ].filter(Boolean).join(' ').toLowerCase();

  const isWeeklyById = /weekly|week|7d/.test(idStr);
  const diffMs = resetAtMs - nowMs;

  let windowKey;
  let durationMs;
  if (isWeeklyById || diffMs > FIVE_HOUR_MS) {
    windowKey = 'weekly';
    durationMs = diffMs > WEEKLY_MS ? MONTHLY_FALLBACK_MS : WEEKLY_MS;
  } else {
    windowKey = '5h';
    durationMs = FIVE_HOUR_MS;
  }

  return {
    windowKey,
    durationMs,
    resetAtMs,
    poolRank,
    windowRank: windowKey === 'weekly' ? 0 : 1,
    expiredRank: resetAtMs > nowMs ? 0 : 1
  };
}

function extractQuotaSnapshotCandidates(input, nowMs) {
  const candidates = [];
  const pushBucket = (bucket, poolRank) => {
    const norm = normalizeCycleCandidate(bucket, poolRank, nowMs);
    if (norm) candidates.push(norm);
  };

  if (Array.isArray(input.pools)) {
    for (const p of input.pools) {
      if (!p || typeof p !== 'object') continue;
      const poolRank = getPoolPriorityRank(`${p.id || ''} ${p.title || ''} ${p.sharedGroupKey || ''}`);
      pushBucket(p.weeklyBucket, poolRank);
      pushBucket(p.fiveHourBucket, poolRank);
      if (Array.isArray(p.buckets)) {
        for (const b of p.buckets) pushBucket(b, poolRank);
      }
    }
  }

  if (input.geminiWindows && typeof input.geminiWindows === 'object') {
    pushBucket(input.geminiWindows.weekly, 0);
    pushBucket(input.geminiWindows.fiveHour, 0);
  }
  if (input.gemini) pushBucket(input.gemini, 0);

  if (input.claudeWindows && typeof input.claudeWindows === 'object') {
    pushBucket(input.claudeWindows.weekly, 2);
    pushBucket(input.claudeWindows.fiveHour, 2);
  }
  if (input.claude) pushBucket(input.claude, 2);

  return candidates;
}

function extractRawRpcCandidates(input, nowMs) {
  const candidates = [];
  const qsRoot = input.quotaSummaryRes?.response || input.quotaSummaryRes || (Array.isArray(input.groups) ? input : null);
  const rawGroups = Array.isArray(qsRoot?.groups) ? qsRoot.groups : [];
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i] || {};
    const poolRank = getPoolPriorityRank(`${g.groupId || ''} ${g.displayName || ''} ${g.name || ''}`);
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    for (const b of buckets) {
      if (!b || b.disabled) continue;
      const norm = normalizeCycleCandidate(b, poolRank, nowMs);
      if (norm) candidates.push(norm);
    }
  }

  const usRoot = input.userStatusRes?.userStatus || input.userStatusRes || input.userStatus || null;
  const rawConfigs = Array.isArray(usRoot?.cascadeModelConfigData?.clientModelConfigs)
    ? usRoot.cascadeModelConfigData.clientModelConfigs
    : [];
  for (const c of rawConfigs) {
    if (!c || typeof c !== 'object') continue;
    const tagTitle = typeof c.tagTitle === 'string' ? c.tagTitle.trim() : '';
    const disabled = Boolean(
      c.disabled === true ||
      c.enabled === false ||
      c.unavailable === true ||
      /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle)
    );
    if (disabled) continue;
    const qi = c.quotaInfo || {};
    const modelText = [c.modelId, c.model, c.label, c.modelOrAlias?.model].filter(Boolean).join(' ');
    const poolRank = getPoolPriorityRank(modelText);
    const norm = normalizeCycleCandidate({
      resetTime: qi.resetTime || qi.reset_time,
      windowKey: qi.windowKey || qi.window
    }, poolRank, nowMs);
    if (norm) candidates.push(norm);
  }

  return candidates;
}

function alignRollingWindow(anchorResetMs, durationMs, nowMs) {
  let endAtMs = anchorResetMs;
  if (endAtMs <= nowMs) {
    const elapsedCycles = Math.floor((nowMs - endAtMs) / durationMs) + 1;
    endAtMs = endAtMs + elapsedCycles * durationMs;
  } else if (endAtMs - durationMs > nowMs) {
    const backCycles = Math.ceil((endAtMs - nowMs) / durationMs) - 1;
    if (backCycles > 0) {
      endAtMs = endAtMs - backCycles * durationMs;
    }
  }
  const startAtMs = endAtMs - durationMs;
  return { startAtMs, endAtMs };
}

function resolveCycleWindow(input = {}, nowMs = Date.now()) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!input || typeof input !== 'object') {
    return buildFallbackWeekWindow(now);
  }

  // 形态 1：显式窗口对象 { startAtMs, endAtMs, windowKey?, source?, isFallback? }
  const hasStart = Number.isFinite(Number(input.startAtMs));
  const hasEnd = Number.isFinite(Number(input.endAtMs));
  if (hasStart && hasEnd && Number(input.endAtMs) > Number(input.startAtMs)) {
    const startAtMs = Number(input.startAtMs);
    const endAtMs = Number(input.endAtMs);
    const durationMs = Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0
      ? Number(input.durationMs)
      : (endAtMs - startAtMs);

    if (input.isFallback === true) {
      if (input.source === 'fallback_week' || input.windowKey === 'fallback_week') {
        return buildFallbackWeekWindow(now);
      }
      return buildCycleWindowMeta({
        windowKey: input.windowKey || 'fallback_week',
        source: input.source || 'explicit',
        isFallback: true,
        startAtMs,
        endAtMs,
        durationMs
      });
    }

    const isPersistedOrCached = input.source === 'cached_window' ||
      input.source === 'quota_state' ||
      input.source === 'quota_service' ||
      input.source === 'rpc_direct';

    if (!isPersistedOrCached || (input.source !== 'cached_window' && startAtMs <= now && now < endAtMs)) {
      const inferredKey = durationMs <= FIVE_HOUR_MS + 60000 ? '5h' : 'weekly';
      return buildCycleWindowMeta({
        windowKey: input.windowKey || inferredKey,
        source: input.source || 'explicit',
        isFallback: false,
        startAtMs,
        endAtMs,
        durationMs
      });
    }
    // 持久化窗口已过期或需按锚点滚动对齐时，继续走形态 4 滚动对齐
  }

  // 形态 2：Quota 快照对象
  const hasSnapshotShape = Array.isArray(input.pools) ||
    Boolean(input.geminiWindows || input.claudeWindows || input.gemini || input.claude);
  if (hasSnapshotShape) {
    const candidates = extractQuotaSnapshotCandidates(input, now);
    if (candidates.length > 0) {
      candidates.sort((a, b) => (
        (a.windowRank - b.windowRank) ||
        (a.expiredRank - b.expiredRank) ||
        (a.poolRank - b.poolRank) ||
        (a.resetAtMs - b.resetAtMs)
      ));
      const best = candidates[0];
      const { startAtMs, endAtMs } = alignRollingWindow(best.resetAtMs, best.durationMs, now);
      return buildCycleWindowMeta({
        windowKey: best.windowKey,
        source: input.source || 'quota_state',
        isFallback: false,
        startAtMs,
        endAtMs,
        durationMs: best.durationMs
      });
    }
  }

  // 形态 3：原始 RPC 对象 { quotaSummaryRes, userStatusRes }
  const hasRpcShape = Boolean(input.quotaSummaryRes || input.userStatusRes || input.userStatus || Array.isArray(input.groups));
  if (hasRpcShape) {
    const candidates = extractRawRpcCandidates(input, now);
    if (candidates.length > 0) {
      candidates.sort((a, b) => (
        (a.windowRank - b.windowRank) ||
        (a.expiredRank - b.expiredRank) ||
        (a.poolRank - b.poolRank) ||
        (a.resetAtMs - b.resetAtMs)
      ));
      const best = candidates[0];
      const { startAtMs, endAtMs } = alignRollingWindow(best.resetAtMs, best.durationMs, now);
      return buildCycleWindowMeta({
        windowKey: best.windowKey,
        source: input.source || 'rpc_direct',
        isFallback: false,
        startAtMs,
        endAtMs,
        durationMs: best.durationMs
      });
    }
  }

  // 形态 4：缓存窗口对象（含 endAtMs 且非兜底）
  if (hasEnd && input.isFallback !== true) {
    const anchorResetMs = Number(input.endAtMs);
    if (anchorResetMs > VALID_TIMESTAMP_MIN_MS) {
      const windowKey = input.windowKey === '5h' ? '5h' : 'weekly';
      const durationMs = Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0
        ? Number(input.durationMs)
        : (windowKey === '5h' ? FIVE_HOUR_MS : WEEKLY_MS);
      const { startAtMs, endAtMs } = alignRollingWindow(anchorResetMs, durationMs, now);
      return buildCycleWindowMeta({
        windowKey,
        source: input.source || 'cached_window',
        isFallback: false,
        startAtMs,
        endAtMs,
        durationMs
      });
    }
  }

  return buildFallbackWeekWindow(now);
}

function resolveCallTimestampMs(call) {
  if (!call || typeof call !== 'object') return 0;
  if (call.timestamp !== undefined && call.timestamp !== null && call.timestamp !== '') {
    const num = Number(call.timestamp);
    if (Number.isFinite(num)) {
      const ms = num > 0 && num < 1e11 ? num * 1000 : num;
      if (ms > VALID_TIMESTAMP_MIN_MS) return ms;
    }
  }
  const isoRaw = call.created_at || call.createdAt;
  if (isoRaw) {
    const parsed = Date.parse(isoRaw);
    if (Number.isFinite(parsed) && parsed > VALID_TIMESTAMP_MIN_MS) return parsed;
  }
  if (call.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(call.date));
    if (m) {
      const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
      if (Number.isFinite(ms) && ms > VALID_TIMESTAMP_MIN_MS) return ms;
    }
  }
  return 0;
}

function resolveCallDateStr(call) {
  if (call?.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date))) {
    return String(call.date).slice(0, 10);
  }
  if (call?.created_at || call?.createdAt || call?.timestamp) {
    const dt = new Date(call.created_at || call.createdAt || call.timestamp);
    if (!Number.isNaN(dt.getTime())) return formatLocalDateStr(dt);
  }
  return '';
}

function summarizeByPeriod(calls = [], nowMs = Date.now(), plan = {}, options = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const todayStr = formatLocalDateStr(new Date(nowMs));
  const monthPrefix = todayStr.slice(0, 7);
  const yearPrefix = todayStr.slice(0, 4);
  const cycleWindow = resolveCycleWindow(options?.cycleWindow || plan?.cycleWindow || null, nowMs);

  const cycleCalls = [];
  const todayCalls = [];
  const monthCalls = [];
  const yearCalls = [];
  const yearMonths = new Set();
  const allMonths = new Set();
  for (const c of list) {
    const ts = resolveCallTimestampMs(c);
    if (ts >= cycleWindow.startAtMs && ts < cycleWindow.endAtMs) {
      cycleCalls.push(c);
    }
    const ds = resolveCallDateStr(c);
    if (ds.length >= 7) allMonths.add(ds.slice(0, 7));
    if (ds === todayStr) todayCalls.push(c);
    if (ds.startsWith(monthPrefix)) monthCalls.push(c);
    if (ds.startsWith(yearPrefix)) {
      yearCalls.push(c);
      if (ds.length >= 7) yearMonths.add(ds.slice(0, 7));
    }
  }

  const currentCycle = summarizeApiCost(cycleCalls);
  const today = summarizeApiCost(todayCalls);
  const month = summarizeApiCost(monthCalls);
  const year = summarizeApiCost(yearCalls);
  const allTime = summarizeApiCost(list);

  const costInfo = resolveSubscriptionCost(plan);
  const yearActiveMonths = Math.max(1, yearMonths.size);
  const allTimeActiveMonths = Math.max(1, allMonths.size);

  const buildPeriodRoi = (estimatedApiUsd, periodCostUsd, monthsCount) => {
    const actualPaidUsd = Number(Math.max(0, periodCostUsd).toFixed(4));
    const actualPaidCny = Number((actualPaidUsd * USD_TO_CNY_RATE).toFixed(2));
    return {
      actualPaidUsd,
      actualPaidCny,
      estimatedApiUsd,
      effectiveSavedUsd: Number((estimatedApiUsd - actualPaidUsd).toFixed(4)),
      monthsCount,
      regionId: costInfo.regionId,
      regionName: costInfo.regionName,
      regionFlag: costInfo.regionFlag,
      subscriptionCurrency: costInfo.subscriptionCurrency,
      subscriptionCurrencySymbol: costInfo.subscriptionCurrencySymbol,
      actualPaidNative: costInfo.actualPaidNative,
      monthlyNative: costInfo.monthlyNative,
      monthlyCostUsd: costInfo.monthlyCostUsd,
      monthlyCostCny: costInfo.monthlyCostCny,
      billingCycle: costInfo.billingCycle,
      priceMode: costInfo.priceMode
    };
  };

  const cycleDays = Math.max(0, cycleWindow.durationMs / 86400000);
  const currentCycleCostUsd = costInfo.isLegacyFlatPaid
    ? costInfo.monthlyCostUsd
    : (costInfo.monthlyCostUsd * (cycleDays / 30));
  const todayCostUsd = costInfo.isLegacyFlatPaid ? costInfo.monthlyCostUsd : (costInfo.monthlyCostUsd / 30);
  const monthCostUsd = costInfo.monthlyCostUsd;
  const yearCostUsd = costInfo.isLegacyFlatPaid ? costInfo.monthlyCostUsd : (costInfo.monthlyCostUsd * yearActiveMonths);
  const allTimeCostUsd = costInfo.isLegacyFlatPaid ? costInfo.monthlyCostUsd : (costInfo.monthlyCostUsd * allTimeActiveMonths);

  const roiByPeriod = {
    currentCycle: buildPeriodRoi(currentCycle.totalUsd, currentCycleCostUsd, 1),
    today: buildPeriodRoi(today.totalUsd, todayCostUsd, 1),
    month: buildPeriodRoi(month.totalUsd, monthCostUsd, 1),
    year: buildPeriodRoi(year.totalUsd, yearCostUsd, yearActiveMonths),
    allTime: buildPeriodRoi(allTime.totalUsd, allTimeCostUsd, allTimeActiveMonths)
  };

  return {
    todayDate: todayStr,
    cycleWindow,
    currentCycle,
    today,
    month,
    year,
    allTime,
    roi: roiByPeriod.allTime,
    roiByPeriod
  };
}

const LEDGER_VERSION = '1.2.0';

function normalizeCallSource(source) {
  return String(source || '').trim().toLowerCase() === 'cli' ? 'cli' : 'desktop';
}

function getCallStepKey(call) {
  if (!call || typeof call !== 'object' || !call.cascadeId) return '';
  if (call.stepIndex === null || call.stepIndex === undefined || call.stepIndex === '') return '';
  const parsed = Number(call.stepIndex);
  if (!Number.isInteger(parsed) || parsed < 0) return '';
  return `${String(call.cascadeId)}#${parsed}`;
}

function isSyntheticCallId(callId, call) {
  const stepKey = getCallStepKey(call);
  return Boolean(callId && stepKey && String(callId) === stepKey);
}

function tokenTupleKey(call) {
  const inTok = Math.max(0, Number(call?.inputTokens ?? call?.input ?? 0) || 0);
  const cTok = Math.max(0, Number(call?.cacheReadTokens ?? call?.cacheTokens ?? 0) || 0);
  const outTok = Math.max(0, Number(call?.outputTokens ?? 0) || 0);
  return `${inTok}|${cTok}|${outTok}`;
}

function getCallTotalTokens(call) {
  const explicit = Number(call?.totalTokens);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const inTok = Math.max(0, Number(call?.inputTokens ?? call?.input ?? 0) || 0);
  const cTok = Math.max(0, Number(call?.cacheReadTokens ?? call?.cacheTokens ?? 0) || 0);
  const outTok = Math.max(0, Number(call?.outputTokens ?? 0) || 0);
  return inTok + cTok + outTok;
}

function hasEntryChanged(prev, next) {
  if (!prev) return true;
  return (
    prev.callId !== next.callId ||
    prev.date !== next.date ||
    Number(prev.timestamp || 0) !== Number(next.timestamp || 0) ||
    Boolean(prev.dateIsProvisional) !== Boolean(next.dateIsProvisional) ||
    String(prev.model || '') !== String(next.model || '') ||
    getCallTotalTokens(prev) !== getCallTotalTokens(next) ||
    String(prev.source || '') !== String(next.source || '') ||
    Number(prev.costUSD || 0) !== Number(next.costUSD || 0) ||
    Boolean(prev.isPriced) !== Boolean(next.isPriced)
  );
}

function mergeCallEntries(prev, entry, canonicalCallId) {
  const prevProv = Boolean(prev?.dateIsProvisional) || !prev?.date;
  const entryProv = Boolean(entry?.dateIsProvisional) || !entry?.date;
  const prevTs = Number(prev?.timestamp || 0);
  const entryTs = Number(entry?.timestamp || 0);

  let chosenDate = prev?.date || entry?.date || null;
  let chosenTs = prevTs || entryTs || 0;
  let chosenProv = prevProv && entryProv;

  if (prevProv && !entryProv) {
    chosenDate = entry.date;
    chosenTs = entryTs;
    chosenProv = false;
  } else if (!prevProv && entryProv) {
    chosenDate = prev.date;
    chosenTs = prevTs;
    chosenProv = false;
  } else {
    const prevValid = Number.isFinite(prevTs) && prevTs > VALID_TIMESTAMP_MIN_MS;
    const entryValid = Number.isFinite(entryTs) && entryTs > VALID_TIMESTAMP_MIN_MS;
    if (prevValid && entryValid) {
      if (entryTs < prevTs) {
        chosenTs = entryTs;
        if (entry?.date) chosenDate = entry.date;
      } else {
        chosenTs = prevTs;
        if (prev?.date) chosenDate = prev.date;
      }
    } else if (entryValid && !prevValid) {
      chosenTs = entryTs;
      if (entry?.date) chosenDate = entry.date;
    }
  }

  let chosenModel = prev?.model || '';
  if (!chosenModel && entry?.model) {
    chosenModel = entry.model;
  } else if (chosenModel && entry?.model && !normalizeModelId(chosenModel) && normalizeModelId(entry.model)) {
    chosenModel = entry.model;
  }

  const prevTok = getCallTotalTokens(prev);
  const entryTok = getCallTotalTokens(entry);
  const tokenFields = entryTok > prevTok
    ? {
        inputTokens: entry.inputTokens,
        cacheTokens: entry.cacheTokens ?? entry.cacheReadTokens ?? 0,
        cacheReadTokens: entry.cacheReadTokens ?? entry.cacheTokens ?? 0,
        outputTokens: entry.outputTokens,
        totalTokens: entryTok
      }
    : {
        inputTokens: prev.inputTokens,
        cacheTokens: prev.cacheTokens ?? prev.cacheReadTokens ?? 0,
        cacheReadTokens: prev.cacheReadTokens ?? prev.cacheTokens ?? 0,
        outputTokens: prev.outputTokens,
        totalTokens: prevTok
      };

  const chosenSource = (normalizeCallSource(prev?.source) === 'cli' || normalizeCallSource(entry?.source) === 'cli')
    ? 'cli'
    : 'desktop';

  const base = {
    ...prev,
    ...entry,
    ...tokenFields,
    callId: canonicalCallId || entry?.callId || prev?.callId,
    source: chosenSource,
    model: chosenModel,
    date: chosenDate,
    timestamp: chosenTs,
    dateIsProvisional: chosenProv
  };
  const costRes = calculateRequestApiCost(base);
  return {
    ...base,
    costUSD: costRes.isPriced ? costRes.costUSD : 0,
    isPriced: costRes.isPriced
  };
}

function addStepMapEntry(stepMap, stepKey, callId) {
  if (!stepKey || !callId) return;
  let set = stepMap.get(stepKey);
  if (!set) {
    set = new Set();
    stepMap.set(stepKey, set);
  }
  set.add(callId);
}

function removeStepMapEntry(stepMap, stepKey, callId) {
  if (!stepKey || !callId) return;
  const set = stepMap.get(stepKey);
  if (!set) return;
  set.delete(callId);
  if (set.size === 0) stepMap.delete(stepKey);
}

function buildStepIndexMap(callsObj) {
  const map = new Map();
  for (const [id, c] of Object.entries(callsObj || {})) {
    const sk = getCallStepKey(c);
    if (sk) addStepMapEntry(map, sk, id);
  }
  return map;
}

function cloneStepIndexMap(src) {
  const copy = new Map();
  for (const [k, set] of src.entries()) {
    copy.set(k, new Set(set));
  }
  return copy;
}

function applyCallToLedgerMap(callsMap, stepMap, rawCall) {
  if (!rawCall || !rawCall.callId) return { added: 0, updated: 0 };
  const source = normalizeCallSource(rawCall.source);
  const base = { ...rawCall, source };
  const costRes = calculateRequestApiCost(base);
  const entry = {
    ...base,
    costUSD: costRes.isPriced ? costRes.costUSD : 0,
    isPriced: costRes.isPriced
  };

  if (callsMap[entry.callId]) {
    const prev = callsMap[entry.callId];
    const merged = mergeCallEntries(prev, entry, entry.callId);
    if (!hasEntryChanged(prev, merged)) return { added: 0, updated: 0 };
    callsMap[entry.callId] = merged;
    const sk = getCallStepKey(merged);
    if (sk) addStepMapEntry(stepMap, sk, entry.callId);
    return { added: 0, updated: 1 };
  }

  const stepKey = getCallStepKey(entry);
  if (stepKey && isSyntheticCallId(entry.callId, entry)) {
    const existingSet = stepMap.get(stepKey);
    const explicitIds = existingSet
      ? Array.from(existingSet).filter((id) => id !== stepKey && Boolean(callsMap[id]))
      : [];
    if (explicitIds.length > 0) {
      const tuple = tokenTupleKey(entry);
      let targetId = explicitIds.find((id) => tokenTupleKey(callsMap[id]) === tuple) || null;
      if (!targetId && explicitIds.length === 1) {
        targetId = explicitIds[0];
      }
      let updated = 0;
      if (targetId) {
        const prev = callsMap[targetId];
        const merged = mergeCallEntries(prev, entry, targetId);
        if (hasEntryChanged(prev, merged)) {
          callsMap[targetId] = merged;
          updated++;
        }
      }
      if (entry.dateIsProvisional === false && entry.date) {
        for (const id of explicitIds) {
          if (id === targetId) continue;
          const other = callsMap[id];
          if (other && (other.dateIsProvisional || !other.date)) {
            const fixed = mergeCallEntries(
              other,
              {
                date: entry.date,
                timestamp: entry.timestamp,
                dateIsProvisional: false,
                source: entry.source,
                model: entry.model || other.model
              },
              id
            );
            if (hasEntryChanged(other, fixed)) {
              callsMap[id] = fixed;
              updated++;
            }
          }
        }
      }
      return { added: 0, updated };
    }
    callsMap[entry.callId] = entry;
    addStepMapEntry(stepMap, stepKey, entry.callId);
    return { added: 1, updated: 0 };
  }

  if (stepKey && callsMap[stepKey]) {
    const synthPrev = callsMap[stepKey];
    const merged = mergeCallEntries(synthPrev, entry, entry.callId);
    delete callsMap[stepKey];
    removeStepMapEntry(stepMap, stepKey, stepKey);
    callsMap[entry.callId] = merged;
    addStepMapEntry(stepMap, stepKey, entry.callId);
    return { added: 0, updated: 1 };
  }

  callsMap[entry.callId] = entry;
  if (stepKey) addStepMapEntry(stepMap, stepKey, entry.callId);
  return { added: 1, updated: 0 };
}

class LedgerManager {
  constructor(storage, fileName = 'token-pricing-ledger.json') {
    this.storage = storage;
    this.fileName = fileName;
    this.corrupted = false;
    this.state = { version: LEDGER_VERSION, updatedAt: null, calls: {} };
    this.stepIndexMap = new Map();
  }

  load() {
    const res = this.storage.readJson(this.fileName, null);
    if (res.corrupted) {
      this.corrupted = true;
      return { ok: false, corrupted: true, error: res.error || '账本已损坏' };
    }
    if (res.data && typeof res.data === 'object' && res.data.calls && typeof res.data.calls === 'object') {
      this.state = {
        version: res.data.version || '1.0.0',
        updatedAt: res.data.updatedAt || null,
        calls: { ...res.data.calls }
      };
      this.stepIndexMap = buildStepIndexMap(this.state.calls);
    } else {
      this.stepIndexMap = new Map();
    }
    this.corrupted = false;
    return { ok: true, corrupted: false, callsCount: Object.keys(this.state.calls).length };
  }

  recordCalls(incoming = []) {
    if (this.corrupted) {
      return { ok: false, changed: false, error: '账本已损坏，拒绝空覆盖以保护既有历史数据' };
    }
    const list = Array.isArray(incoming) ? incoming : [];
    let added = 0;
    let updated = 0;
    const nextCalls = { ...this.state.calls };
    const nextStepMap = cloneStepIndexMap(this.stepIndexMap);

    for (const c of list) {
      const res = applyCallToLedgerMap(nextCalls, nextStepMap, c);
      added += res.added;
      updated += res.updated;
    }

    if (added === 0 && updated === 0) {
      return { ok: true, changed: false, added: 0, updated: 0, totalCalls: Object.keys(nextCalls).length };
    }

    const nextState = {
      version: this.state.version || LEDGER_VERSION,
      updatedAt: new Date().toISOString(),
      calls: nextCalls
    };
    const writeRes = this.storage.writeJson(this.fileName, nextState);
    if (!writeRes.ok) {
      return { ok: false, changed: false, error: writeRes.error || '写入账本失败' };
    }
    this.state = nextState;
    this.stepIndexMap = nextStepMap;
    return { ok: true, changed: true, added, updated, totalCalls: Object.keys(nextCalls).length };
  }

  replaceAllCalls(callsList = [], opts = {}) {
    if (this.corrupted) {
      return { ok: false, changed: false, error: '账本已损坏，拒绝空覆盖以保护既有历史数据' };
    }
    const list = Array.isArray(callsList) ? callsList : [];
    const nextCalls = {};
    const nextStepMap = new Map();
    for (const c of list) {
      applyCallToLedgerMap(nextCalls, nextStepMap, c);
    }
    const targetVersion = opts.version || LEDGER_VERSION;
    const nextState = {
      version: targetVersion,
      updatedAt: new Date().toISOString(),
      calls: nextCalls
    };
    const writeRes = this.storage.writeJson(this.fileName, nextState);
    if (!writeRes.ok) {
      return { ok: false, changed: false, error: writeRes.error || '写入账本失败' };
    }
    this.state = nextState;
    this.stepIndexMap = nextStepMap;
    return { ok: true, changed: true, totalCalls: Object.keys(nextCalls).length, version: targetVersion };
  }

  getAllCalls() {
    return Object.values(this.state.calls);
  }
}

module.exports = {
  LEDGER_VERSION,
  VALID_PERIOD_KEYS,
  FIVE_HOUR_MS,
  WEEKLY_MS,
  MONTHLY_FALLBACK_MS,
  USD_TO_CNY_RATE,
  CURRENCY_SYMBOLS,
  SUBSCRIPTION_REGIONS_PRESET,
  GEMINI_PRICING_TABLE,
  ULTRA_SUB_TIER_PRESETS,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  findRegionPreset,
  convertToCNY,
  resolveSubscriptionCost,
  isGeminiModel,
  filterCallsBySource,
  normalizeUltraSubTier,
  normalizePeriodKey,
  detectSubscriptionFromUserStatus,
  normalizeModelId,
  resolveModelBucketKey,
  normalizeCallSource,
  getCallStepKey,
  mergeCallEntries,
  calculateRequestApiCost,
  summarizeApiCost,
  resolveCallTimestampMs,
  resolveCycleWindow,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
};
