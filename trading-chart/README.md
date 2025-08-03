# Trading Chart Application

Real-time candlestick chart application for TSX Trading Bot V4, similar to TradingView.

## Features

- Real-time candlestick charts using TradingView's Lightweight Charts library
- WebSocket connection for live data streaming
- Redis integration for receiving market data from the trading bot
- Dark theme optimized for trading
- Responsive design with automatic resizing
- Health check endpoints
- Support for multiple data channels (market data, trade executions, system alerts)

## Prerequisites

- Node.js (v18 or higher)
- Redis server running locally or accessible
- TSX Trading Bot V4 publishing data to Redis channels

## Installation

1. Install dependencies:
```bash
npm install
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
PORT=4675
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
NODE_ENV=development
```

### Redis Channels

The application now subscribes to the TSX Trading Bot's Redis channels:
- `market:data`: Real-time market tick data from the trading bot
- `orders:executions`: Trade execution notifications
- `system:alerts`: System alerts and notifications

### Data Processing

The chart application handles the trading bot's message format:
1. **Receives wrapped messages** from the bot with `payload`, `timestamp`, and `correlationId`
2. **Extracts tick data** from the payload
3. **Aggregates ticks** into candlesticks using the built-in TickAggregator service
4. **Supports multiple timeframes**: 1m, 5m, 15m, 1h

### Expected Tick Data Format

The trading bot publishes market ticks wrapped in this format:

```json
{
  "payload": {
    "symbol": "AAPL",
    "price": 195.75,
    "volume": 100,
    "timestamp": 1703123456789,
    "bid": 195.74,
    "ask": 195.76,
    "side": "buy"
  },
  "timestamp": "2024-01-27T12:00:00.000Z",
  "correlationId": "12345-abc..."
}
```

The chart automatically converts these ticks into OHLC candlesticks.

## Development

Run both backend and frontend in development mode:

```bash
npm run dev
```

This will:
- Start the backend server on port 4675 with hot reload
- Start the webpack dev server on port 4676 with hot reload
- Proxy WebSocket connections from frontend to backend

## Building

Build for production:

```bash
npm run build
```

This creates:
- Backend JS files in `dist/backend/`
- Frontend bundle in `dist/public/`

## Running in Production

```bash
npm start
```

The server will serve the static frontend files and handle WebSocket connections.

## API Endpoints

- `GET /health` - Health check endpoint showing Redis and WebSocket status
- `GET /api/config` - Current configuration information
- WebSocket at `/socket.io` - Real-time data streaming

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  TSX Trading    │────>│    Redis     │<────│  Chart Server   │
│     Bot V4      │     │   Pub/Sub    │     │   (Backend)     │
└─────────────────┘     └──────────────┘     └─────────────────┘
                                                      │
                                                      │ WebSocket
                                                      ↓
                                              ┌─────────────────┐
                                              │  Chart Client   │
                                              │   (Frontend)    │
                                              └─────────────────┘
```

## Integration with TSX Trading Bot V4

To integrate this chart with your trading bot:

1. Ensure your trading bot publishes market data to Redis channel `market-data`
2. Format the data as shown in the "Expected Data Format" section
3. Start this chart application
4. Access the chart at `http://localhost:4675`

Example Redis publish from trading bot:

```typescript
// In your trading bot
import Redis from 'ioredis';

const redis = new Redis();

// Publish market data
const marketData = {
  symbol: 'AAPL',
  timestamp: Date.now(),
  open: 195.50,
  high: 196.20,
  low: 195.30,
  close: 196.00,
  volume: 1000000
};

redis.publish('market-data', JSON.stringify(marketData));
```

## Troubleshooting

### Chart not receiving data
1. Check Redis connection: `http://localhost:4675/health`
2. Ensure trading bot is publishing to the correct channel
3. Check browser console for WebSocket connection errors

### Build errors
1. Delete `node_modules` and `package-lock.json`
2. Run `npm install` again
3. Ensure TypeScript version compatibility

## Future Enhancements

- [ ] Add technical indicators (MA, RSI, MACD)
- [ ] Multi-timeframe support
- [ ] Drawing tools
- [ ] Save/load chart layouts
- [ ] Multiple chart panels
- [ ] Order visualization on chart
- [ ] Performance metrics display