# Trading Chart Data Flow Fix Guide

## Understanding the Data Flow

The trading chart receives data through this flow:

```
TopStep API (SignalR WebSocket)
    ↓
Connection Manager (MarketDataService)
    ↓
Redis Pub/Sub (market:data channel)
    ↓
Trading Chart Server (RedisSubscriber)
    ↓
WebSocket to Browser
    ↓
Chart Component (Lightweight Charts)
```

## Quick Fix Steps

### Step 1: Diagnose the Issue

First, run the diagnostic tool to see what's not working:

```bash
cd trading-chart
npm install  # Make sure dependencies are installed
npm run diagnose
```

This will tell you exactly what's missing.

### Step 2: Start Required Services

Based on the diagnostic results, start the missing services:

1. **Redis** (if not running):
   ```bash
   redis-server
   ```

2. **Trading Chart** (if not running):
   ```bash
   cd trading-chart
   npm run dev
   ```

3. **Connection Manager** (if not running):
   ```bash
   cd .. # Go to main bot directory
   node connection-manager/index.js
   ```

### Step 3: Fill Chart with Data

You have three options:

#### Option A: Test Data (Immediate, No API Needed)

Run the test data publisher to see data immediately:

```bash
cd trading-chart
npm run test-data
```

This will publish simulated market data every second. Perfect for testing!

#### Option B: Historical Data (Requires Connection Manager)

Fetch real historical data from TopStep:

```bash
cd trading-chart
npm run fetch-history
# Or specify parameters:
npm run fetch-history CON.F.US.MGC.Q25 1m 500
```

#### Option C: Live Data (Market Must Be Open)

If the market is open and Connection Manager is running with valid credentials, live data should flow automatically.

## Troubleshooting

### Chart shows "Waiting for data..."

1. Run `npm run diagnose` to check all components
2. Make sure Redis is running
3. Check if data is flowing: `npm run redis-listen`

### No data even with Connection Manager running

This usually means:
- Market is closed (no live data)
- No instruments are subscribed
- Authentication issues with TopStep

Solution: Use test data (`npm run test-data`) or fetch historical data.

### WebSocket disconnected

The chart will automatically reconnect. If it doesn't:
1. Refresh the browser
2. Check the server is running on port 4675

### Data format issues

The chart expects data in this format on the `market:data` channel:

```json
{
  "payload": {
    "instrument": "CON.F.US.MGC.Q25",
    "data": {
      "price": 2050.50,
      "bid": 2050.40,
      "ask": 2050.60,
      "size": 10,
      "timestamp": "2024-01-20T15:30:00Z",
      "side": "buy"
    }
  },
  "timestamp": "2024-01-20T15:30:00Z",
  "correlationId": "unique-id"
}
```

## Available Scripts

- `npm run dev` - Start the chart server
- `npm run test-data` - Publish test data to Redis
- `npm run diagnose` - Check all components
- `npm run fetch-history` - Fetch historical data
- `npm run redis-listen` - Monitor Redis channels

## Architecture Notes

The chart is designed to be independent of the main bot:
- It listens to Redis for data
- It doesn't require the bot to be running
- It can display test data or historical data
- It aggregates ticks into candles locally

This makes it perfect for development and testing without needing live market access.