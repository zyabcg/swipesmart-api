# SwipeSmart API

Production-ready backend for the SwipeSmart credit card recommendation platform.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Fastify 4 (faster than Express, built-in schema validation) |
| Language | TypeScript (strict mode) |
| ORM | Prisma 5 |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| LLM | Anthropic Claude (chat feature) |
| Validation | Zod |
| Logging | Pino |

---

## Architecture

```
swipesmart-api/
├── prisma/
│   ├── schema.prisma          # DB schema (9 models)
│   └── seed.ts                # All 36 cards with verified reward rates
└── src/
    ├── config/env.ts          # Env validation (Zod) — crashes on missing vars
    ├── lib/
    │   ├── prisma.ts          # Prisma client singleton
    │   ├── redis.ts           # Redis client + typed helpers + key builders
    │   └── logger.ts          # Pino logger (pretty in dev, JSON in prod)
    ├── middleware/
    │   ├── session.ts         # Anonymous session (cookie → Redis → Postgres)
    │   ├── adminAuth.ts       # x-admin-api-key header check
    │   └── errorHandler.ts    # Centralised error handler
    ├── utils/response.ts      # ok() / fail() / notFound() helpers
    ├── types/index.ts         # Shared TypeScript types
    └── modules/
        ├── cards/             # Card catalog CRUD + Redis caching
        ├── optimizer/         # POST /optimize — best card per category
        ├── recommendation/    # POST /recommend — scored card list
        │   └── scoring.engine.ts  # Core scoring algorithm (configurable weights)
        ├── chat/              # Conversational recommendations via Claude
        ├── analytics/         # Event tracking + admin stats
        ├── admin/             # Protected card management + system stats
        ├── affiliate/         # Link management, click/conversion tracking
        └── sessions/          # Session profile endpoint
```

---

## API Routes

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/v1/cards` | List all active cards (filterable) |
| `GET` | `/api/v1/cards/:slug` | Get a single card |
| `GET` | `/api/v1/cards/banks` | List unique banks |
| `POST` | `/api/v1/optimize` | Card optimizer |
| `POST` | `/api/v1/recommend` | Card recommendation |
| `POST` | `/api/v1/chat/conversations` | Start a chat |
| `GET` | `/api/v1/chat/conversations/:id` | Get conversation history |
| `POST` | `/api/v1/chat/conversations/:id/messages` | Send a message |
| `DELETE` | `/api/v1/chat/conversations/:id` | Reset a conversation |
| `POST` | `/api/v1/track` | Analytics event tracking |
| `GET` | `/api/v1/sessions/me` | Current session profile |
| `GET` | `/api/v1/affiliate/redirect/:linkId` | Track click + return affiliate URL |

### Admin (requires `x-admin-api-key` header)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/cards` | All cards including inactive |
| `POST` | `/api/v1/admin/cards` | Create a card |
| `PATCH` | `/api/v1/admin/cards/:id` | Update a card |
| `PATCH` | `/api/v1/admin/cards/:id/reward-rates` | Update only reward rates |
| `PATCH` | `/api/v1/admin/cards/:id/toggle` | Toggle isActive |
| `DELETE` | `/api/v1/admin/cards/:id` | Soft delete |
| `PATCH` | `/api/v1/admin/banks/:bank/toggle` | Toggle all cards for a bank |
| `GET` | `/api/v1/admin/stats` | System overview |
| `GET` | `/api/v1/analytics/stats` | Analytics overview |
| `POST` | `/api/v1/affiliate/links` | Create affiliate link |
| `GET` | `/api/v1/affiliate/links?cardId=...` | List links for a card |
| `DELETE` | `/api/v1/affiliate/links/:id` | Deactivate a link |
| `POST` | `/api/v1/affiliate/conversions` | Record a conversion (webhook) |
| `PATCH` | `/api/v1/affiliate/conversions/:id/status` | Confirm/reject conversion |
| `GET` | `/api/v1/affiliate/stats` | Affiliate performance summary |

---

## Setup

### 1. Prerequisites
- Node.js 20+
- Docker (for Postgres + Redis)

### 2. Clone and install

```bash
cd swipesmart-api
npm install
```

### 3. Environment

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, COOKIE_SECRET, ADMIN_API_KEY
```

### 4. Start infrastructure

```bash
docker-compose up -d
# Wait for postgres and redis to be healthy (about 10 seconds)
```

### 5. Database setup

```bash
npm run generate        # Generate Prisma client
npm run db:push         # Push schema to database
npm run db:seed         # Seed all 36 cards
```

### 6. Start the API

```bash
npm run dev             # Development (hot reload)
npm run build && npm start  # Production
```

The API will be running at `http://localhost:3000`.

---

## Sample Requests

### Optimizer

```bash
curl -X POST http://localhost:3000/api/v1/optimize \
  -H "Content-Type: application/json" \
  -d '{
    "selectedCards": ["hdfc_regalia", "axis_ace"],
    "monthlySpend": {
      "travel": 10000,
      "dining": 5000,
      "utility": 3000,
      "online": 8000,
      "groceries": 6000
    }
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "bestPerCategory": {
      "travel": {
        "card": { "name": "Regalia Gold", "bank": "HDFC Bank" },
        "rate": 5,
        "monthlySpend": 10000,
        "monthlyReward": 500,
        "annualReward": 6000
      },
      "utility": {
        "card": { "name": "Ace", "bank": "Axis Bank" },
        "rate": 5,
        "monthlySpend": 3000,
        "monthlyReward": 150,
        "annualReward": 1800
      }
    },
    "totalOptimizedAnnualRewards": 28200,
    "totalBaselineAnnualRewards": 17496,
    "optimizationDelta": 10704,
    "tips": ["..."]
  }
}
```

### Recommendation

```bash
curl -X POST http://localhost:3000/api/v1/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "income": 75000,
    "totalSpend": 30000,
    "primaryCategory": "travel",
    "lifestylePreference": "travel_perks",
    "maxFee": 5000,
    "intlTravel": "occasionally"
  }'
```

### Chat

```bash
# 1. Start conversation
curl -X POST http://localhost:3000/api/v1/chat/conversations

# 2. Send a message (use the conversationId from step 1)
curl -X POST http://localhost:3000/api/v1/chat/conversations/CONV_ID/messages \
  -H "Content-Type: application/json" \
  -d '{ "message": "I spend ₹30,000/month and travel a lot. What card should I get?" }'
```

### Analytics tracking (fire-and-forget from frontend)

```bash
curl -X POST http://localhost:3000/api/v1/track \
  -H "Content-Type: application/json" \
  -d '{ "event": "card_view", "page": "/finder", "properties": { "cardSlug": "hdfc_regalia" } }'
```

### Admin — create a card

```bash
curl -X POST http://localhost:3000/api/v1/admin/cards \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: YOUR_ADMIN_KEY" \
  -d '{
    "slug": "new_card_slug",
    "name": "New Card",
    "bank": "New Bank",
    "network": "Visa",
    "annualFee": 999,
    "rewardRates": { "travel": 2, "dining": 3, "online": 2, "groceries": 2, "fuel": 0, "utility": 2, "default": 1.5 },
    "perks": ["Perk 1", "Perk 2"],
    "bestFor": ["cashback"],
    "categories": ["dining"],
    "intlTravel": false,
    "welcomeBonus": 500
  }'
```

---

## Scoring Algorithm

The recommendation engine scores each card using:

```
score = (annualRewardValue × annualRewardMultiplier)
      + (welcomeBonus × welcomeBonusMultiplier)     // discounted (one-time)
      + lifestyleBonus                               // +₹5,000 if lifestyle matches
      + intlTravelBonus                              // +₹3,000–₹8,000 if intl travel
      + categoryBreadthBonus                         // 30% weight on avg category rate
      - (annualFee × annualFeeMultiplier)
```

Hard filters (score = -1, disqualified):
- `annualFee > maxFee`
- `minIncome > income × 1.5`

All weights are configurable via `ScoringWeights` — no code changes needed to tune the algorithm.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | No | Redis URL (default: localhost:6379) |
| `COOKIE_SECRET` | Yes | 32+ char secret for signing session cookies |
| `ADMIN_API_KEY` | Yes | 16+ char key for admin endpoints |
| `CORS_ORIGIN` | No | Allowed frontend origins (comma-separated) |
| `ANTHROPIC_API_KEY` | Chat only | Claude API key |
| `SESSION_TTL_DAYS` | No | Session lifetime (default: 30) |
| `CARD_CACHE_TTL` | No | Card Redis cache TTL in seconds (default: 3600) |

---

## Key Design Decisions

**Why Fastify over Express?** 3x faster throughput, built-in JSON schema validation, TypeScript-first.

**Why anonymous sessions?** Zero friction — users get recommendations without any signup. Sessions can later be linked to an account.

**Why Redis for card caching?** The 36-card catalog is read on every recommendation. Redis eliminates DB round-trips and makes horizontal scaling trivial.

**Why fire-and-forget for analytics/persistence?** Analytics and request logging must never block or fail the user-facing response. Writes are backgrounded.

**Why Zod over Fastify's JSON Schema validation?** Zod gives richer TypeScript inference and more readable error messages for API consumers.

**Affiliate monetization path:** Each "Apply Now" click goes through `/api/v1/affiliate/redirect/:linkId`, which records the click, appends UTM params, and returns the bank's URL. Banks post conversions back via webhook. Revenue is tracked per card and per link.
