/**
 * SwipeSmart Card Scraper
 *
 * Fetches bank card pages, extracts reward rates / fees / perks using regex,
 * diffs against the last saved snapshot, and notifies the admin of any changes.
 *
 * Rules:
 *  - NO database connection, NO Prisma
 *  - Snapshots stored locally in ./data/{slug}.json
 *  - If ADMIN_WEBHOOK_URL is set, POSTs a JSON payload on any change
 *  - A single page failure never stops the rest of the run
 *
 * Run:  npx ts-node scripts/scraper/scrapeCards.ts
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CardSource {
  slug: string;
  name: string;
  url: string;
}

interface CardSnapshot {
  slug: string;
  name: string;
  scrapedAt: string;
  rewards: string[];   // all % values found on the page
  fees: string[];      // rupee / fee-related strings
  perks: string[];     // perk / benefit keywords found
  rawSample: string;   // first 2000 chars of visible text (for manual inspection)
}

interface ChangeReport {
  card: string;
  slug: string;
  timestamp: string;
  oldData: CardSnapshot;
  newData: CardSnapshot;
  diff: {
    rewards: { added: string[]; removed: string[] };
    fees: { added: string[]; removed: string[] };
    perks: { added: string[]; removed: string[] };
  };
}

// ─── Card Sources ─────────────────────────────────────────────────────────────
// Add / remove cards here. URLs should point to the card's official product page.

const CARD_SOURCES: CardSource[] = [
  {
    slug: 'hdfc_millennia',
    name: 'HDFC Millennia',
    url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/millennia-credit-card',
  },
  {
    slug: 'hdfc_regalia',
    name: 'HDFC Regalia Gold',
    url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/regalia-gold-credit-card',
  },
  {
    slug: 'axis_atlas',
    name: 'Axis Atlas',
    url: 'https://www.axisbank.com/retail/cards/credit-card/atlas-credit-card',
  },
  {
    slug: 'axis_flipkart',
    name: 'Axis Flipkart',
    url: 'https://www.axisbank.com/retail/cards/credit-card/flipkart-axis-bank-credit-card',
  },
  {
    slug: 'sbi_cashback',
    name: 'SBI Cashback',
    url: 'https://www.sbicard.com/en/personal/credit-cards/rewards/cashback-sbi-card.page',
  },
  {
    slug: 'icici_amazon_pay',
    name: 'ICICI Amazon Pay',
    url: 'https://www.icicibank.com/personal-banking/cards/consumer-credit-card/amazon-pay-credit-card',
  },
  {
    slug: 'hdfc_tata_neu_infinity',
    name: 'Tata Neu Infinity HDFC',
    url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/tata-neu-infinity-hdfc-bank-credit-card',
  },
  {
    slug: 'idfc_wow',
    name: 'IDFC WOW',
    url: 'https://www.idfcfirstbank.com/credit-card/wow-credit-card',
  },
  {
    slug: 'amex_mrcc',
    name: 'Amex MRCC',
    url: 'https://www.americanexpress.com/in/credit-cards/membership-rewards-card/',
  },
];

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const WEBHOOK_URL = process.env.ADMIN_WEBHOOK_URL ?? '';
const REQUEST_TIMEOUT_MS = 15_000;

// Browser-like headers to reduce bot-detection blocks
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

// ─── Extraction helpers ────────────────────────────────────────────────────────

/**
 * Strip HTML tags and collapse whitespace to get plain text.
 */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Find all percentage values in the text.
 * Captures patterns like "5%", "2.5%", "up to 5%", "5X reward points (5%)".
 */
function extractRewardRates(text: string): string[] {
  const matches = new Set<string>();

  // Standalone % mentions with context: up to 20 chars before the number
  const pctRegex = /([A-Za-z ]{0,25}\d+(?:\.\d+)?%(?:\s*(?:cashback|reward|back|points?|value))?)/gi;
  for (const m of text.matchAll(pctRegex)) {
    const raw = m[0].trim().toLowerCase();
    // Skip tiny percentages that are likely GST / tax (18%, 28%) or irrelevant
    if (/\b(18|28|gst|tax|interest|apr|emi)\b/.test(raw)) continue;
    matches.add(raw);
  }

  return [...matches].slice(0, 30); // cap to prevent noise
}

/**
 * Find annual-fee and related fee mentions.
 * Looks for ₹/Rs patterns and "annual fee", "joining fee", "renewal fee" keywords.
 */
function extractFees(text: string): string[] {
  const matches = new Set<string>();

  // ₹ or Rs followed by a number
  const rsRegex = /(?:₹|rs\.?|inr)\s*[\d,]+(?:\s*(?:per\s+year|pa|p\.a\.|annually|joining|renewal|annual))?/gi;
  for (const m of text.matchAll(rsRegex)) {
    matches.add(m[0].trim().toLowerCase());
  }

  // "annual fee: ₹500" / "joining fee waiver" style phrases
  const feeRegex = /(?:annual|joining|renewal)\s+fee[^.]{0,60}/gi;
  for (const m of text.matchAll(feeRegex)) {
    matches.add(m[0].trim().toLowerCase());
  }

  return [...matches].slice(0, 20);
}

/**
 * Extract perk / benefit keywords that indicate card features.
 * Looks for known perk terms in the text, returning normalised lowercase phrases.
 */
const PERK_PATTERNS = [
  /lounge\s*access[^.]{0,40}/gi,
  /airport\s*lounge[^.]{0,40}/gi,
  /fuel\s*surcharge[^.]{0,40}/gi,
  /milestone\s*(?:benefit|reward|bonus)[^.]{0,50}/gi,
  /welcome\s*(?:gift|bonus|benefit)[^.]{0,50}/gi,
  /complimentary[^.]{0,60}/gi,
  /concierge[^.]{0,30}/gi,
  /forex\s*(?:markup|charges?)[^.]{0,40}/gi,
  /travel\s*insurance[^.]{0,40}/gi,
  /zero\s*(?:annual\s*)?fee[^.]{0,30}/gi,
  /fee\s*waiver[^.]{0,50}/gi,
  /dining\s*(?:discount|offer|benefit)[^.]{0,40}/gi,
  /movie\s*(?:ticket|offer|benefit)[^.]{0,40}/gi,
  /golf[^.]{0,30}/gi,
  /emi\s*(?:conversion|offer)[^.]{0,40}/gi,
];

function extractPerks(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PERK_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      found.add(m[0].trim().toLowerCase().replace(/\s+/g, ' '));
    }
  }
  return [...found].slice(0, 25);
}

// ─── Snapshot I/O ─────────────────────────────────────────────────────────────

function snapshotPath(slug: string): string {
  return path.join(DATA_DIR, `${slug}.json`);
}

function loadSnapshot(slug: string): CardSnapshot | null {
  const p = snapshotPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CardSnapshot;
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot: CardSnapshot): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(snapshot.slug), JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function arrayDiff(
  oldArr: string[],
  newArr: string[]
): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    added: newArr.filter((x) => !oldSet.has(x)),
    removed: oldArr.filter((x) => !newSet.has(x)),
  };
}

function hasChanges(diff: ChangeReport['diff']): boolean {
  return (
    diff.rewards.added.length > 0 ||
    diff.rewards.removed.length > 0 ||
    diff.fees.added.length > 0 ||
    diff.fees.removed.length > 0 ||
    diff.perks.added.length > 0 ||
    diff.perks.removed.length > 0
  );
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

async function sendWebhook(report: ChangeReport): Promise<void> {
  if (!WEBHOOK_URL) return;
  
  let summary = `\n\`\`\`json\n${JSON.stringify(report.diff, null, 2)}\n\`\`\``;
  
  if (process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      
      const prompt = `You are a credit card analyst. You will receive a JSON diff of text additions/removals scraped from a bank's credit card page. The diff contains arrays of 'added' and 'removed' strings corresponding to rewards, fees, and perks. Summarize exactly what changed in 1-3 simple, plain English sentences. Do not use markdown code blocks or raw JSON in your output. Just say things like 'The card removed the 100% welcome benefit' or 'A new 1% forex markup fee was added.'
      
Card: ${report.card}
Diff: ${JSON.stringify(report.diff)}`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      if (responseText) {
        summary = responseText.trim();
      }
    } catch (err) {
      console.warn('  [webhook] Failed to hit Gemini API for summary, falling back to JSON:', err);
    }
  }

  try {
    await axios.post(
      WEBHOOK_URL,
      {
        content: `🚨 **Card Update Detected!**\n**Card:** ${report.card}\n\n**Summary:**\n${summary}`
      },
      { timeout: 10_000, headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`  [webhook] Payload sent to ${WEBHOOK_URL}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [webhook] Failed to send webhook — ${msg}`);
  }
}

// ─── Single card scrape ────────────────────────────────────────────────────────

async function scrapeCard(source: CardSource): Promise<ChangeReport | null> {
  console.log(`\n[${source.slug}] Fetching ${source.url}`);

  let html: string;
  try {
    const response = await axios.get<string>(source.url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: HEADERS,
      // Follow redirects, accept gzip
      maxRedirects: 5,
      decompress: true,
      responseType: 'text',
    });
    html = response.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [${source.slug}] FETCH ERROR — ${msg} (skipping)`);
    return null;
  }

  const text = extractText(html);

  const snapshot: CardSnapshot = {
    slug: source.slug,
    name: source.name,
    scrapedAt: new Date().toISOString(),
    rewards: extractRewardRates(text),
    fees: extractFees(text),
    perks: extractPerks(text),
    rawSample: text.slice(0, 2000),
  };

  const previous = loadSnapshot(source.slug);

  if (!previous) {
    // First run — save baseline, nothing to diff
    saveSnapshot(snapshot);
    console.log(`  [${source.slug}] No previous snapshot — baseline saved.`);
    console.log(`    rewards: ${snapshot.rewards.length} entries`);
    console.log(`    fees:    ${snapshot.fees.length} entries`);
    console.log(`    perks:   ${snapshot.perks.length} entries`);
    return null;
  }

  // Build diff
  const diff: ChangeReport['diff'] = {
    rewards: arrayDiff(previous.rewards, snapshot.rewards),
    fees: arrayDiff(previous.fees, snapshot.fees),
    perks: arrayDiff(previous.perks, snapshot.perks),
  };

  // Always overwrite snapshot with latest scrape
  saveSnapshot(snapshot);

  if (!hasChanges(diff)) {
    console.log(`  [${source.slug}] No changes detected.`);
    return null;
  }

  const report: ChangeReport = {
    card: source.name,
    slug: source.slug,
    timestamp: snapshot.scrapedAt,
    oldData: previous,
    newData: snapshot,
    diff,
  };

  return report;
}

// ─── Report printer ───────────────────────────────────────────────────────────

function printReport(report: ChangeReport): void {
  const sep = '─'.repeat(60);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CHANGE DETECTED: ${report.card} (${report.slug})`);
  console.log(`  Timestamp: ${report.timestamp}`);
  console.log(sep);

  const { rewards, fees, perks } = report.diff;

  if (rewards.added.length || rewards.removed.length) {
    console.log('  REWARDS:');
    rewards.added.forEach((r) => console.log(`    + ADDED:   ${r}`));
    rewards.removed.forEach((r) => console.log(`    - REMOVED: ${r}`));
  }

  if (fees.added.length || fees.removed.length) {
    console.log('  FEES:');
    fees.added.forEach((f) => console.log(`    + ADDED:   ${f}`));
    fees.removed.forEach((f) => console.log(`    - REMOVED: ${f}`));
  }

  if (perks.added.length || perks.removed.length) {
    console.log('  PERKS:');
    perks.added.forEach((p) => console.log(`    + ADDED:   ${p}`));
    perks.removed.forEach((p) => console.log(`    - REMOVED: ${p}`));
  }

  console.log(sep);
  console.log('  Previous snapshot: ' + report.oldData.scrapedAt);
  console.log('  Action required  : Review changes and update via admin API if valid.');
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════════════════');
  console.log('  SwipeSmart Card Scraper');
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Cards to check: ${CARD_SOURCES.length}`);
  console.log(`  Webhook: ${WEBHOOK_URL ? WEBHOOK_URL : 'not configured'}`);
  console.log('════════════════════════════════════════════════════════════');

  const reports: ChangeReport[] = [];
  const errors: string[] = [];

  // Scrape cards sequentially — avoids hammering servers and simplifies logging
  for (const source of CARD_SOURCES) {
    try {
      const report = await scrapeCard(source);
      if (report) {
        reports.push(report);
        printReport(report);
        await sendWebhook(report);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${source.slug}: ${msg}`);
      console.error(`  [${source.slug}] Unexpected error — ${msg}`);
    }

    // Polite delay between requests (1.5s) to avoid rate limiting
    await new Promise((res) => setTimeout(res, 1500));
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  SCRAPE COMPLETE');
  console.log(`  Cards checked : ${CARD_SOURCES.length}`);
  console.log(`  Changes found : ${reports.length}`);
  console.log(`  Errors        : ${errors.length}`);

  if (reports.length > 0) {
    console.log('\n  Cards with changes:');
    reports.forEach((r) => console.log(`    • ${r.card} (${r.slug})`));
  }

  if (errors.length > 0) {
    console.log('\n  Errors:');
    errors.forEach((e) => console.log(`    ✗ ${e}`));
  }

  console.log('════════════════════════════════════════════════════════════\n');

  // Exit with non-zero code if there were errors (lets GitHub Actions flag it)
  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
