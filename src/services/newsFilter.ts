// backend/src/services/newsFilter.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 新聞 AI 過濾器（規則引擎）
// ═══════════════════════════════════════════════════════════════
//
// 分級：A（紅色警報）→ B（黃色）→ C（藍色）→ filtered（屏蔽）
// 純規則引擎，不依賴外部 AI API，零延遲分類。
// ═══════════════════════════════════════════════════════════════

import type { RawNewsItem } from './newsAggregator';

// ═══ Types ═══

export type NewsLevel = 'A' | 'B' | 'C' | 'filtered';
export type NewsSentiment = 'positive' | 'negative' | 'neutral';

export interface ClassifiedNews {
  id: string;
  title: string;
  source: string;
  url: string;
  level: NewsLevel;
  sentiment: NewsSentiment;
  affectedSymbols: string[];
  estimatedImpact: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
  actionSuggestion: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════
// KEYWORD DATABASES
// ═══════════════════════════════════════════════════════

interface KeywordRule {
  pattern: RegExp;
  label: string;
  defaultSentiment: NewsSentiment;
}

// ═══ LEVEL A: 紅色警報 + 聲音 + 全螢幕彈窗 ═══

const LEVEL_A_RULES: KeywordRule[] = [
  // FOMC / Fed
  { pattern: /\b(FOMC|federal reserve|聯準會|interest rate decision|利率決議)\b/i, label: 'FOMC利率決議', defaultSentiment: 'neutral' },
  { pattern: /\brate\s+(hike|cut|hold|pause|unchanged)|升息|降息|維持利率\b/i, label: '利率變動', defaultSentiment: 'neutral' },
  // Inflation
  { pattern: /\b(CPI|consumer price index|消費者物價|通膨數據)\b/i, label: 'CPI數據', defaultSentiment: 'neutral' },
  { pattern: /\b(PCE|personal consumption expenditure)\b/i, label: 'PCE數據', defaultSentiment: 'neutral' },
  { pattern: /\b(nonfarm|non-farm|非農就業|payrolls)\b/i, label: '非農就業', defaultSentiment: 'neutral' },
  // Bitcoin ETF
  { pattern: /bitcoin.{0,20}ETF.{0,30}(approv|reject|denied|SEC|批准|拒絕)/i, label: 'BTC ETF審核', defaultSentiment: 'neutral' },
  { pattern: /ethereum.{0,20}ETF.{0,30}(approv|reject|denied|SEC)/i, label: 'ETH ETF審核', defaultSentiment: 'neutral' },
  // Exchange crisis
  { pattern: /exchange.{0,15}(hack|hacked|breach|exploit)|交易所.{0,10}(被駭|駭客|漏洞)/i, label: '交易所安全事件', defaultSentiment: 'negative' },
  { pattern: /\b(insolvency|bankruptcy|破產|倒閉)\b/i, label: '破產事件', defaultSentiment: 'negative' },
  // Stablecoin depeg
  { pattern: /stablecoin.{0,15}(depeg|de-peg)|USDT.{0,10}(depeg|脫鉤)|USDC.{0,10}(depeg|脫鉤)|穩定幣.{0,10}脫鉤/i, label: '穩定幣脫鉤', defaultSentiment: 'negative' },
  // National ban
  { pattern: /country.{0,10}ban|national.{0,10}ban|crypto.{0,10}ban|全面禁止|國家禁令/i, label: '國家級禁令', defaultSentiment: 'negative' },
  { pattern: /SEC.{0,15}(sues?|charges?|lawsuit|enforcement|起訴)/i, label: 'SEC執法', defaultSentiment: 'negative' },
  // Protocol hack
  { pattern: /protocol.{0,15}(hack|exploit|drained)|smart contract.{0,10}(vulnerability|bug)|協議.{0,8}被駭/i, label: '協議安全事件', defaultSentiment: 'negative' },
];

// ═══ LEVEL B: 黃色警報 + 聲音 ═══

const LEVEL_B_RULES: KeywordRule[] = [
  // Macro data
  { pattern: /\b(GDP|gross domestic product)\b/i, label: 'GDP數據', defaultSentiment: 'neutral' },
  { pattern: /\b(PPI|producer price)\b/i, label: 'PPI數據', defaultSentiment: 'neutral' },
  { pattern: /\b(Powell|鮑威爾|Fed.{0,10}(chair|speak|testimony|press conference))\b/i, label: 'Fed官員講話', defaultSentiment: 'neutral' },
  { pattern: /\b(unemployment.{0,10}(rate|claims)|jobless|失業率)\b/i, label: '就業數據', defaultSentiment: 'neutral' },
  // Protocol upgrades
  { pattern: /ethereum.{0,15}(upgrade|hard fork|Dencun|Pectra)|以太坊.{0,10}升級/i, label: 'ETH協議升級', defaultSentiment: 'positive' },
  { pattern: /bitcoin.{0,15}halving|比特幣.{0,10}減半/i, label: 'BTC減半', defaultSentiment: 'positive' },
  // Institutional
  { pattern: /(MicroStrategy|微策略).{0,20}(buy|purchase|acquire|bought|增持)/i, label: 'MicroStrategy買入', defaultSentiment: 'positive' },
  { pattern: /(BlackRock|貝萊德).{0,20}(buy|file|launch|ETF)/i, label: 'BlackRock動態', defaultSentiment: 'positive' },
  { pattern: /(Fidelity|富達).{0,20}(buy|file|launch|ETF)/i, label: 'Fidelity動態', defaultSentiment: 'positive' },
  { pattern: /(Grayscale|灰度).{0,20}(buy|convert|ETF|GBTC)/i, label: 'Grayscale動態', defaultSentiment: 'neutral' },
  { pattern: /(Tesla|特斯拉).{0,20}(bitcoin|BTC|crypto)/i, label: 'Tesla加密', defaultSentiment: 'neutral' },
  // Fear & Greed extreme
  { pattern: /fear.{0,5}greed.{0,10}(extreme|record|lowest|highest)|恐懼.{0,5}貪婪.{0,5}極/i, label: 'F&G極端', defaultSentiment: 'neutral' },
  // Whale alert with large amount
  { pattern: /whale.{0,10}alert.{0,30}(\$[5-9]\d{1,2}[,.]?\d*\s*[mM]|\$[1-9]\d*\s*[bB])/i, label: '大額鯨魚警報', defaultSentiment: 'neutral' },
  // Major listing
  { pattern: /(Binance|Coinbase|OKX).{0,15}(list|delist|上架|下架)/i, label: '主流所上下架', defaultSentiment: 'neutral' },
];

// ═══ LEVEL C patterns (general info) ═══

const LEVEL_C_PATTERNS: RegExp[] = [
  /\b(partnership|合作|integration|整合)\b/i,
  /\b(update|release|version|版本|更新|upgrade)\b/i,
  /\b(airdrop|空投)\b/i,
  /\b(testnet|mainnet|測試網|主網)\b/i,
  /\b(governance|proposal|治理|提案)\b/i,
  /\b(staking|質押|yield|收益)\b/i,
];

// ═══ SPAM / FILTER (completely blocked) ═══

const SPAM_PATTERNS: RegExp[] = [
  /\b(pump|moon|100x|1000x|gem|lambo|guaranteed|easy money|get rich)\b/i,
  /\b(join now|sign up|limited time|exclusive offer|giveaway|free\s+crypto)\b/i,
  /\b(sponsored|paid promotion|advertisement|referral)\b/i,
  /\b(shib|pepe|floki|bonk|wojak|meme.{0,5}season|dog.{0,5}coin.{0,5}killer)\b/i,
  /\b(predict|forecast).{0,10}\$\d{6,}/i, // "BTC to $500000" hype
  /\b(trust me|insider|secret|leaked)\b/i,
];

/** KOL / social media sources to filter */
const KOL_DOMAINS = ['twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'reddit.com', 'telegram'];

// ═══ SYMBOL DETECTION ═══

const SYMBOL_RULES: { pattern: RegExp; symbol: string }[] = [
  { pattern: /\b(bitcoin|BTC)\b/i, symbol: 'BTCUSDT' },
  { pattern: /\b(ethereum|ETH|ether)\b/i, symbol: 'ETHUSDT' },
  { pattern: /\b(solana|SOL)\b/i, symbol: 'SOLUSDT' },
  { pattern: /\b(BNB|binance coin)\b/i, symbol: 'BNBUSDT' },
  { pattern: /\b(XRP|ripple)\b/i, symbol: 'XRPUSDT' },
  { pattern: /\b(dogecoin|DOGE)\b/i, symbol: 'DOGEUSDT' },
  { pattern: /\b(cardano|ADA)\b/i, symbol: 'ADAUSDT' },
  { pattern: /\b(avalanche|AVAX)\b/i, symbol: 'AVAXUSDT' },
  { pattern: /\b(chainlink|LINK)\b/i, symbol: 'LINKUSDT' },
  { pattern: /\b(polkadot|DOT)\b/i, symbol: 'DOTUSDT' },
  { pattern: /\b(SUI)\b/, symbol: 'SUIUSDT' },
  { pattern: /\b(NEAR)\b/, symbol: 'NEARUSDT' },
];

// ═══ SENTIMENT WORDS ═══

const POSITIVE_RX = /\b(surge|rally|soar|jump|gain|bull|rise|record high|approve|adopt|breakout|上漲|暴漲|突破|利多|看多|通過|批准|pump)\b/i;
const NEGATIVE_RX = /\b(crash|plunge|dump|drop|fall|bear|decline|record low|reject|ban|hack|exploit|下跌|暴跌|崩盤|利空|看空|禁止|被駭)\b/i;

// ═══ DEDUPLICATION ═══

const recentAlertKeys = new Map<string, number>(); // key → timestamp
const DEDUP_WINDOW_MS = 3600_000; // 1 hour

function isDuplicate(level: string, symbols: string[]): boolean {
  const key = `${level}:${symbols.sort().join(',')}`;
  const last = recentAlertKeys.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentAlertKeys.set(key, Date.now());
  // Cleanup old entries
  for (const [k, v] of recentAlertKeys) {
    if (Date.now() - v > DEDUP_WINDOW_MS) recentAlertKeys.delete(k);
  }
  return false;
}

// ═══════════════════════════════════════════════════════
// MAIN CLASSIFICATION FUNCTION
// ═══════════════════════════════════════════════════════

/**
 * Classify a single news item into Level A/B/C/filtered.
 * Pure function — no network calls, no side effects.
 */
export function classifyNews(item: RawNewsItem): ClassifiedNews {
  const text = `${item.title} ${item.content || ''}`;

  // ─── STEP 1: Spam filter ───
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      return buildResult(item, 'filtered', 'neutral', [], 'low', ['spam'], '已屏蔽：炒作/垃圾內容');
    }
  }

  // ─── STEP 2: KOL source filter ───
  if (item.url) {
    for (const domain of KOL_DOMAINS) {
      if (item.url.toLowerCase().includes(domain)) {
        return buildResult(item, 'filtered', 'neutral', [], 'low', ['kol_source'], '已屏蔽：KOL/社群來源');
      }
    }
  }

  // ─── STEP 3: Detect affected symbols ───
  const symbols: string[] = [];
  for (const rule of SYMBOL_RULES) {
    if (rule.pattern.test(text) && !symbols.includes(rule.symbol)) {
      symbols.push(rule.symbol);
    }
  }
  // Add RSS feed categories
  if (item.categories) {
    for (const c of item.categories) {
      const sym = `${c.toUpperCase()}USDT`;
      if (!symbols.includes(sym)) symbols.push(sym);
    }
  }

  // ─── STEP 4: Detect sentiment ───
  const posMatch = POSITIVE_RX.test(text);
  const negMatch = NEGATIVE_RX.test(text);
  let sentiment: NewsSentiment = 'neutral';
  if (posMatch && !negMatch) sentiment = 'positive';
  if (negMatch && !posMatch) sentiment = 'negative';

  // ─── STEP 5: Check Level A ───
  for (const rule of LEVEL_A_RULES) {
    if (rule.pattern.test(text)) {
      // Dedup: same level+symbols within 1 hour
      if (isDuplicate('A', symbols)) {
        return buildResult(item, 'filtered', sentiment, symbols, 'high', [rule.label], '已屏蔽：1小時內重複');
      }
      const s = rule.defaultSentiment !== 'neutral' ? rule.defaultSentiment : sentiment;
      return buildResult(item, 'A', s, symbols, 'high', [rule.label],
        s === 'negative' ? '⚠️ 建議立即檢查持倉，考慮縮倉或設緊止損' :
        s === 'positive' ? '可能帶來正面波動，留意突破機會' :
        '重大事件，建議等待方向明確後再操作');
    }
  }

  // ─── STEP 6: Check Level B ───
  for (const rule of LEVEL_B_RULES) {
    if (rule.pattern.test(text)) {
      if (isDuplicate('B', symbols)) {
        return buildResult(item, 'filtered', sentiment, symbols, 'medium', [rule.label], '已屏蔽：重複');
      }
      const s = rule.defaultSentiment !== 'neutral' ? rule.defaultSentiment : sentiment;
      return buildResult(item, 'B', s, symbols, 'medium', [rule.label],
        s === 'positive' ? '利多消息，可作為進場輔助參考' :
        s === 'negative' ? '留意短期下行壓力' :
        '市場可能波動，保持關注');
    }
  }

  // ─── STEP 7: Check Level C ───
  for (const pattern of LEVEL_C_PATTERNS) {
    if (pattern.test(text)) {
      return buildResult(item, 'C', sentiment, symbols, 'low', ['general'], '一般資訊，僅供參考');
    }
  }

  // ─── STEP 8: Default ───
  if (symbols.length > 0) {
    return buildResult(item, 'C', sentiment, symbols, 'low', ['unclassified'], '一般資訊');
  }

  return buildResult(item, 'filtered', 'neutral', [], 'low', ['irrelevant'], '已屏蔽：與追蹤幣種無關');
}

function buildResult(
  item: RawNewsItem,
  level: NewsLevel,
  sentiment: NewsSentiment,
  symbols: string[],
  impact: 'high' | 'medium' | 'low',
  keywords: string[],
  action: string,
): ClassifiedNews {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    url: item.url,
    level,
    sentiment,
    affectedSymbols: symbols,
    estimatedImpact: impact,
    matchedKeywords: keywords,
    actionSuggestion: action,
    timestamp: item.publishedAt,
  };
}

/**
 * Classify a batch of news items. Returns only non-filtered by default.
 */
export function classifyBatch(items: RawNewsItem[], includeFiltered = false): ClassifiedNews[] {
  const results = items.map(classifyNews);
  return includeFiltered ? results : results.filter(r => r.level !== 'filtered');
}
