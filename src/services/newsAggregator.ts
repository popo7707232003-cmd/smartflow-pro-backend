// backend/src/services/newsAggregator.ts
// ═══════════════════════════════════════════════════════════════
// SmartFlow Pro — 消息面數據聚合器（純 RSS 版）
// ═══════════════════════════════════════════════════════════════
//
// 來源（全部免費，無需任何 API Key）：
//   1. CoinDesk RSS
//   2. The Block RSS
//   3. Decrypt RSS
//   4. Cointelegraph RSS
//   5. Bitcoin Magazine RSS
//
// 每 2 分鐘輪詢 · Redis 去重（URL hash，TTL 24h）
// ═══════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import Parser from 'rss-parser';
import Redis from 'ioredis';
import crypto from 'crypto';

// ═══ Types ═══

export interface RawNewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  content?: string;
  categories?: string[];
}

// ═══ Constants ═══

const POLL_INTERVAL_MS = 120_000; // 2 minutes
const REDIS_SEEN_KEY = 'news:seen_urls';
const REDIS_CACHE_KEY = 'news:items';
const REDIS_TTL = 86400; // 24 hours
const MAX_CACHE = 500;
const ITEMS_PER_FEED = 20;

const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
  { url: 'https://www.theblock.co/rss.xml', name: 'The Block' },
  { url: 'https://decrypt.co/feed', name: 'Decrypt' },
  { url: 'https://cointelegraph.com/rss', name: 'Cointelegraph' },
  { url: 'https://bitcoinmagazine.com/feed', name: 'Bitcoin Magazine' },
];

// ═══════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════

export class NewsAggregator extends EventEmitter {
  private redis: Redis;
  private parser: Parser;
  private cache: RawNewsItem[] = [];
  private seenHashes = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(redis: Redis) {
    super();
    this.redis = redis;
    this.parser = new Parser({
      timeout: 10_000,
      headers: { 'User-Agent': 'SmartFlowPro/1.0 RSS Reader' },
      maxRedirects: 3,
    });
  }

  async start(): Promise<void> {
    console.log('[NewsAgg] Starting (pure RSS — 0 API keys needed)');
    console.log(`[NewsAgg] Sources: ${RSS_FEEDS.map(f => f.name).join(', ')}`);

    // Load seen hashes from Redis
    try {
      const seen = await this.redis.smembers(REDIS_SEEN_KEY);
      seen.forEach(h => this.seenHashes.add(h));
      console.log(`[NewsAgg] Loaded ${this.seenHashes.size} seen hashes from Redis`);
    } catch {
      console.log('[NewsAgg] Redis unavailable, using in-memory dedup only');
    }

    // Load cached items from Redis
    try {
      const cached = await this.redis.get(REDIS_CACHE_KEY);
      if (cached) {
        this.cache = JSON.parse(cached);
        console.log(`[NewsAgg] Restored ${this.cache.length} cached items from Redis`);
      }
    } catch { /* non-critical */ }

    // Initial poll
    await this.poll();

    // Schedule recurring polls
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log(`[NewsAgg] ✓ Polling every ${POLL_INTERVAL_MS / 1000}s`);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[NewsAgg] Stopped');
  }

  // ═══════════════════════════════════════
  // POLLING
  // ═══════════════════════════════════════

  private async poll(): Promise<void> {
    const allItems: RawNewsItem[] = [];

    // Fetch all 5 RSS feeds in parallel
    const results = await Promise.allSettled(
      RSS_FEEDS.map(feed => this.fetchFeed(feed.url, feed.name))
    );

    let successCount = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
        successCount++;
      }
    }

    // Deduplicate against seen set (by URL hash)
    const newItems: RawNewsItem[] = [];

    for (const item of allItems) {
      const hash = this.hashUrl(item.url);
      if (this.seenHashes.has(hash)) continue;

      this.seenHashes.add(hash);
      newItems.push(item);

      // Persist hash to Redis
      try {
        await this.redis.sadd(REDIS_SEEN_KEY, hash);
        await this.redis.expire(REDIS_SEEN_KEY, REDIS_TTL);
      } catch { /* non-critical */ }
    }

    if (newItems.length > 0) {
      // Prepend new items to cache
      this.cache = [...newItems, ...this.cache].slice(0, MAX_CACHE);

      // Persist cache to Redis
      try {
        await this.redis.set(
          REDIS_CACHE_KEY,
          JSON.stringify(this.cache.slice(0, 200)),
          'EX',
          REDIS_TTL,
        );
      } catch { /* non-critical */ }

      // Emit for downstream processing (newsFilter → alertEngine)
      this.emit('news:new', newItems);

      console.log(
        `[NewsAgg] ${newItems.length} new items ` +
        `(${allItems.length} total from ${successCount}/${RSS_FEEDS.length} feeds)`
      );
    }
  }

  // ═══════════════════════════════════════
  // RSS FETCH (using rss-parser)
  // ═══════════════════════════════════════

  private async fetchFeed(url: string, sourceName: string): Promise<RawNewsItem[]> {
    try {
      const feed = await this.parser.parseURL(url);
      const items: RawNewsItem[] = [];

      for (const entry of (feed.items || []).slice(0, ITEMS_PER_FEED)) {
        if (!entry.title || !entry.link) continue;

        const pubDate = entry.pubDate || entry.isoDate;
        const publishedAt = pubDate ? new Date(pubDate).getTime() : Date.now();

        // Skip items older than 24 hours
        if (Date.now() - publishedAt > 24 * 3600_000) continue;

        items.push({
          id: `${sourceName.toLowerCase().replace(/\s/g, '')}-${this.hashUrl(entry.link)}`,
          title: this.cleanText(entry.title),
          source: sourceName,
          url: entry.link,
          publishedAt,
          content: entry.contentSnippet
            ? this.cleanText(entry.contentSnippet).slice(0, 500)
            : entry.content
              ? this.cleanText(entry.content).slice(0, 500)
              : undefined,
          categories: entry.categories || [],
        });
      }

      return items;
    } catch (err) {
      console.error(`[NewsAgg] ${sourceName} RSS failed:`, (err as Error).message);
      return [];
    }
  }

  // ═══════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════

  /** Hash a URL for deduplication — SHA-256 truncated to 12 hex chars */
  private hashUrl(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  }

  /** Strip HTML tags and normalize whitespace */
  private cleanText(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ═══════════════════════════════════════
  // DATA ACCESS
  // ═══════════════════════════════════════

  getRecent(limit: number = 50): RawNewsItem[] {
    return this.cache.slice(0, limit);
  }

  getSince(hours: number): RawNewsItem[] {
    const since = Date.now() - hours * 3600_000;
    return this.cache.filter(n => n.publishedAt > since);
  }

  getCacheSize(): number {
    return this.cache.length;
  }

  getSources(): string[] {
    return RSS_FEEDS.map(f => f.name);
  }
}
