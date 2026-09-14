# MOCKKET

## Expeditions: the first roguelike mode

Keep your bankroll alive across four stages: The Opening, The Climb, High Stakes,
and The Final. Win 12 distinct markets to complete an expedition. A winning pick
must have a stake of at least $25 to count; repeat wins on a market count once.
Existing balances and bets are preserved, and expedition progress starts with new
picks placed after the update.

At 3, 6, and 9 wins, choose one of three randomly drafted upgrades. Drafts are
stable per run and cannot be rerolled by refreshing. Relics stack additively and
boost the profit portion of future winning picks. The Supply Cache instead grants
$150 immediately. Payouts including relic bonuses are locked at placement, and
existing open picks are never repriced. Supply grants are separate from betting P/L.

At $0 with no open picks or unclaimed rewards, the run ends. After defeat or a
12-win victory, resolve all pending picks and claim rewards before restarting
with $1,000. Upgrades reset; the expedition log preserves the result, win count,
build, and ending bankroll. The original Run History still holds archived bets.
Matches continue to resolve on their real-world schedule.

`npm start` automatically runs the additive, idempotent `roguelike-schema.sql`
migration after the existing run-history migration. It adds `rogue_runs` and two
bet columns without resetting existing data. Deploy the migration and code together.

Run `npm test` for rules, PostgreSQL migration/archive checks using PGlite, and an
isolated HTTP smoke test of registration, reward claims, payouts, settlement, death,
and victory. The tests use an in-memory database and stub market data. They do not
connect to the production database. For a visual preview, run
`node tests/local-server.js` and sign in at `http://localhost:4173` as
`expedition_demo` / `local-only-pass`. These credentials exist only in that local
test process. The market feed is intentionally stubbed in this preview.

**Put your money where your mouth isn't.**

Live esports markets. Fake money. Real bragging rights.

MOCKKET is a simulated esports prediction-market app. It uses live,
read-only market data from Polymarket while all wagers, balances,
profits, and losses inside MOCKKET use fake money only.

## Features

-   League of Legends and Valorant markets
-   Live/updating market prices while the page is open
-   \$1,000 starting simulated bankroll per account
-   Overall match-winner betting directly from the main slate
-   Detailed match views with game/map winner markets and total
    games/maps when available
-   Automatic settlement when Polymarket resolves supported markets
-   Persistent user accounts, bankrolls, bets, and sessions
-   Stats dashboard with record, win rate, ROI, P/L, total staked, and
    cumulative P/L
-   Leaderboard for comparing results with other MOCKKET users
-   Account reset support
-   Legacy local simulator bet import
-   Responsive dark UI

For League of Legends, the current slate is intentionally focused on the
major regions: LCK, LPL, LEC, and LCS.

## Tech Stack

-   **Frontend:** Vanilla HTML, CSS, and JavaScript
-   **Backend:** Node.js
-   **Database:** PostgreSQL
-   **Postgres client:** `pg`
-   **Market data:** Polymarket public Gamma/CLOB data and market
    WebSocket feeds

## Project Structure

``` text
mock-league/
├── public/
│   ├── index.html
│   └── favicon.svg
├── server.js
├── package.json
├── package-lock.json
├── mockket-schema.sql
├── README.md
└── .gitignore
```

## Local Setup

### 1. Requirements

-   Node.js 18+
-   A PostgreSQL database initialized with `mockket-schema.sql`

### 2. Install dependencies

``` bash
npm install
```

### 3. Configure the database

MOCKKET expects a `DATABASE_URL` environment variable containing your
PostgreSQL connection string.

Example format:

``` text
postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

Do **not** commit the real connection string to GitHub.

On Windows Command Prompt, you can set it for the current terminal
session with:

``` cmd
set "DATABASE_URL=your-postgres-connection-string"
```

### 4. Start MOCKKET

``` bash
npm start
```

Then open:

``` text
http://localhost:3000
```

## Database

`mockket-schema.sql` contains the PostgreSQL schema used by the
application.

The database stores application data such as:

-   Users
-   Password hashes
-   Sessions
-   Simulated bankrolls
-   Bets
-   Bet status and realized P/L

The database is the source of truth for account and betting data. Do not
commit local database dumps, credentials, or old simulator data.

## Market Data

MOCKKET uses Polymarket as a **read-only market-data source**.

The app discovers supported League of Legends and Valorant match
markets, exposes available match/game/map/total markets, and streams
price updates while the page is open.

MOCKKET does not submit orders to Polymarket and does not connect a
user's wallet.

## Simulated Betting

Every account starts with:

``` text
$1,000.00
```

When a simulated bet is placed:

1.  The fake stake is deducted from the user's available balance.
2.  The entry market price is stored with the bet.
3.  The bet remains open until the corresponding market is resolved.
4.  Once a supported Polymarket market resolves, MOCKKET settles the
    simulated bet and updates the user's bankroll and realized P/L.

All money displayed by MOCKKET is simulated.

## Stats & Leaderboard

MOCKKET automatically tracks betting history and statistics, including:

-   Total bets
-   Wins and losses
-   Open bets
-   Win rate
-   Realized P/L
-   ROI
-   Total amount staked
-   Average entry probability
-   Biggest win
-   Cumulative P/L
-   Weekly performance
-   Performance by game/league

The leaderboard compares users using their stored simulated results.

## Security / Repository Notes

Never commit secrets or generated local data.

Recommended `.gitignore`:

``` gitignore
node_modules/
.env
mock-league-data.json
mock-league.db
*.log
```

`DATABASE_URL` should be configured as an environment variable locally
and as a secret/environment variable on the hosting provider when
deployed.

## Disclaimer

MOCKKET is a fake-money simulator built for entertainment and
software-development purposes.

It does not accept deposits, process withdrawals, connect wallets, or
place real-money orders. Market prices are sourced from third-party
public market data and may be delayed, unavailable, or change at any
time.
