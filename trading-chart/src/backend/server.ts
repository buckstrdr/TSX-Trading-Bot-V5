import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ChartWebSocket from './websocket-server/chart-websocket.js';
import RedisSubscriber from './data-subscriber/redis-subscriber.js';
import { TickAggregator, MarketTick, Timeframe, Candlestick } from '../services/tick-aggregator/TickAggregator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const chartWebSocket = new ChartWebSocket(server);
const redisSubscriber = new RedisSubscriber();
const tickAggregator = new TickAggregator();

// Configuration
const SUPPORTED_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h'];
const activeSymbols = new Set<string>();

// Middleware
app.use(express.json());

// Static file serving with explicit routes
const publicPath = path.join(__dirname, "..", "..", "public");
console.log('Public path:', publicPath);

// Serve the main index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Serve bundle.js explicitly
app.get('/bundle.js', (req, res) => {
  res.sendFile(path.join(publicPath, 'bundle.js'));
});

// Serve other static files
app.use(express.static(publicPath));

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      redis: redisSubscriber.isHealthy(),
      websocket: {
        connected: true,
        clients: chartWebSocket.getConnectedClients()
      },
      tickAggregator: tickAggregator.getStats()
    }
  };
  
  const httpStatus = health.services.redis ? 200 : 503;
  res.status(httpStatus).json(health);
});

// API endpoint to get current configuration
app.get('/api/config', (req, res) => {
  res.json({
    redisChannels: {
      marketData: 'market:data',
      orderExecutions: 'orders:executions',
      systemAlerts: 'system:alerts'
    },
    supportedTimeframes: SUPPORTED_TIMEFRAMES,
    activeSymbols: Array.from(activeSymbols),
    websocketPort: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

// API endpoint to get historical data for a symbol
app.get('/api/historical/:symbol/:timeframe', async (req, res) => {
  try {
    const { symbol, timeframe } = req.params;
    const { bars = 100 } = req.query;
    
    if (!SUPPORTED_TIMEFRAMES.includes(timeframe as Timeframe)) {
      return res.status(400).json({ error: 'Unsupported timeframe' });
    }
    
    // Generate historical candlestick data for the current session
    const historicalData = generateSessionHistoricalData(symbol, timeframe as Timeframe, parseInt(bars as string));
    
    res.json({
      symbol,
      timeframe,
      bars: historicalData,
      count: historicalData.length
    });
  } catch (error) {
    console.error('Error fetching historical data:', error);
    res.status(500).json({ error: 'Failed to fetch historical data' });
  }
});

// Generate historical data for current session (since no external API available)
function generateSessionHistoricalData(symbol: string, timeframe: Timeframe, bars: number) {
  const now = Date.now();
  const timeframeMs = getTimeframeMs(timeframe);
  const historicalBars = [];
  
  // Base price for the symbol
  const basePrices: { [key: string]: number } = {
    'MNQ': 23500,
    'MES': 6400,
    'MGC': 3300,
    'M2K': 2800,
    'M6E': 1.17,
    'MYM': 51000
  };
  
  const basePrice = basePrices[symbol.replace(/.*\.([A-Z0-9]+)\..*/, '$1')] || 100;
  let currentPrice = basePrice;
  
  // Generate bars going backwards in time
  for (let i = bars - 1; i >= 0; i--) {
    const barTime = now - (i * timeframeMs);
    
    // Add some realistic price movement
    const volatility = basePrice * 0.002; // 0.2% volatility
    const priceChange = (Math.random() - 0.5) * volatility;
    currentPrice += priceChange;
    
    const high = currentPrice + Math.random() * volatility * 0.5;
    const low = currentPrice - Math.random() * volatility * 0.5;
    const open: number = i === bars - 1 ? currentPrice : historicalBars[historicalBars.length - 1]?.close || currentPrice;
    const close = currentPrice;
    const volume = Math.floor(Math.random() * 1000) + 100;
    
    historicalBars.push({
      time: Math.floor(barTime / 1000), // Convert to seconds for lightweight-charts
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume
    });
  }
  
  return historicalBars;
}

function getTimeframeMs(timeframe: Timeframe): number {
  switch (timeframe) {
    case '1m': return 60 * 1000;
    case '5m': return 5 * 60 * 1000;
    case '15m': return 15 * 60 * 1000;
    case '1h': return 60 * 60 * 1000;
    default: return 60 * 1000;
  }
}

// Setup tick aggregator subscriptions
function setupTickAggregator() {
  // This will be called for each symbol we track
  const subscribeToSymbol = (symbol: string) => {
    if (activeSymbols.has(symbol)) return;
    
    activeSymbols.add(symbol);
    
    // Subscribe to all timeframes for this symbol
    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      tickAggregator.subscribe(symbol, timeframe, (candle: Candlestick) => {
        // Broadcast candlestick data to WebSocket clients
        chartWebSocket.broadcast('candlestick-update', {
          symbol: candle.symbol,
          timeframe,
          candle: {
            time: Math.floor(candle.timestamp / 1000), // Convert to seconds for lightweight-charts
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume
          },
          complete: candle.complete,
          trades: candle.trades
        });
      });
    }
  };
  
  return subscribeToSymbol;
}

// Initialize Redis subscription
async function initializeRedisSubscription() {
  const subscribeToSymbol = setupTickAggregator();
  
  try {
    // Request market data subscriptions from Connection Manager
    const defaultInstruments = [
      'CON.F.US.MNQ.U25', // Nasdaq futures
      'CON.F.US.MES.U25', // S&P futures  
      'CON.F.US.MGC.Q25'  // Gold futures
    ];
    
    console.log('📡 Requesting market data subscriptions from Connection Manager...');
    for (const instrument of defaultInstruments) {
      await redisSubscriber.publish('SUBSCRIBE_MARKET_DATA', JSON.stringify({
        instrument: instrument,
        types: ['quote', 'trade', 'level2'],
        subscribe: true,
        source: 'trading-chart'
      }));
      console.log(`✅ Requested subscription for ${instrument}`);
    }
    // Subscribe to market data channel (from trading bot)
    await redisSubscriber.subscribe('market:data', (message) => {
      try {
        console.log('📨 Received message on market:data channel:', message.substring(0, 200) + '...');
        const wrappedData = JSON.parse(message);
        
        // Handle both wrapped and unwrapped formats
        const marketData = wrappedData.payload || wrappedData;
        console.log('📊 Market data received:', {
          type: marketData.type,
          instrument: marketData.instrument,
          hasData: !!marketData.data
        });
        
        if (marketData && marketData.instrument && marketData.data) {
          const { instrument, type, data: priceData } = marketData;
          
          let price: number | undefined;
          let volume = 0;
          let side: 'buy' | 'sell' | undefined;
          
          // Handle different market data types
          switch (type) {
            case 'QUOTE':
              // For quotes, use mid-price
              if (priceData.bid && priceData.ask) {
                price = (priceData.bid + priceData.ask) / 2;
              }
              break;
              
            case 'TRADE':
              // For trades, use the actual trade price
              price = priceData.price;
              volume = priceData.size || 0;
              side = priceData.side;
              break;
              
            case 'DEPTH':
              // Skip depth updates for now
              console.log('📊 Depth update received, skipping for chart');
              return;
              
            default:
              console.log(`⚠️ Unknown market data type: ${type}`);
              return;
          }
          
          if (price && price > 0) {
            // Convert to MarketTick format
            const tick: MarketTick = {
              symbol: instrument,
              price: price,
              volume: volume,
              timestamp: priceData.timestamp ? new Date(priceData.timestamp).getTime() : Date.now(),
              bid: priceData.bid,
              ask: priceData.ask,
              side: side
            };
          
            console.log(`💰 Processing ${type} for ${instrument}: $${price.toFixed(2)}`);
            
            // Ensure we're subscribed to this symbol
            subscribeToSymbol(tick.symbol);
            
            // Process the tick through aggregator
            tickAggregator.processTick(tick, SUPPORTED_TIMEFRAMES);
            
            // Also broadcast raw tick data for real-time price display
            chartWebSocket.broadcast('market-tick', tick);
          } else {
            console.log(`⚠️ No valid price found in ${type} data`);
          }
        } else {
          console.log('⚠️ Invalid market data format:', JSON.stringify(marketData).substring(0, 200));
        }
      } catch (error) {
        console.error('Error parsing market data:', error);
      }
    });

    // Subscribe to order executions
    await redisSubscriber.subscribe('orders:executions', (message) => {
      try {
        const wrappedData = JSON.parse(message);
        const execution = wrappedData.payload;
        
        if (execution) {
          console.log(`Broadcasting trade execution for ${execution.instrument || execution.symbol}`);
          chartWebSocket.broadcast('trade-execution', execution);
          
          // Also create a tick from the execution
          if ((execution.instrument || execution.symbol) && execution.price && execution.quantity) {
            const tick: MarketTick = {
              symbol: execution.instrument || execution.symbol,
              price: execution.price,
              volume: execution.quantity,
              timestamp: execution.timestamp || Date.now(),
              side: execution.side
            };
            
            subscribeToSymbol(tick.symbol);
            tickAggregator.processTick(tick, SUPPORTED_TIMEFRAMES);
          }
        }
      } catch (error) {
        console.error('Error parsing trade execution:', error);
      }
    });

    // Subscribe to system alerts
    await redisSubscriber.subscribe('system:alerts', (message) => {
      try {
        const wrappedData = JSON.parse(message);
        const alert = wrappedData.payload || wrappedData;
        chartWebSocket.broadcast('system-alert', alert);
      } catch (error) {
        console.error('Error parsing system alert:', error);
      }
    });

    // Subscribe to position updates
    await redisSubscriber.subscribe('POSITION_UPDATE', (message) => {
      try {
        const positionData = JSON.parse(message);
        console.log(`📊 Broadcasting position update for ${positionData.instrument}`);
        
        // Format for chart frontend
        const formattedPosition = {
          accountId: positionData.accountId,
          positionId: positionData.positionId,
          instrument: positionData.instrument || positionData.contractId,
          type: positionData.type,
          size: positionData.size || positionData.quantity,
          averagePrice: positionData.averagePrice,
          unrealizedPnL: positionData.unrealizedPnL,
          realizedPnL: positionData.realizedPnL,
          timestamp: positionData.timestamp || Date.now()
        };
        
        chartWebSocket.broadcast('position-update', formattedPosition);
      } catch (error) {
        console.error('Error parsing position update:', error);
      }
    });

    // Subscribe to order fills
    await redisSubscriber.subscribe('ORDER_FILLED', (message) => {
      try {
        const orderData = JSON.parse(message);
        console.log(`📋 Broadcasting order fill for ${orderData.instrument}`);
        
        // Format for chart frontend
        const formattedFill = {
          orderId: orderData.orderId,
          accountId: orderData.accountId,
          instrument: orderData.instrument || orderData.contractId,
          side: orderData.side,
          filledPrice: orderData.filledPrice || orderData.price,
          filledQuantity: orderData.filledQuantity || orderData.quantity || orderData.size,
          positionId: orderData.positionId,
          timestamp: orderData.timestamp || Date.now()
        };
        
        chartWebSocket.broadcast('order-fill', formattedFill);
      } catch (error) {
        console.error('Error parsing order fill:', error);
      }
    });

    // Subscribe to stop loss and take profit updates
    await redisSubscriber.subscribe('SL_TP_UPDATE', (message) => {
      try {
        const slTpData = JSON.parse(message);
        console.log(`🎯 Broadcasting SL/TP update for position ${slTpData.positionId}`);
        
        // Format for chart frontend
        const formattedSlTp = {
          positionId: slTpData.positionId,
          stopLoss: slTpData.stopLoss,
          takeProfit: slTpData.takeProfit,
          instrument: slTpData.instrument || slTpData.contractId
        };
        
        chartWebSocket.broadcast('sl-tp-update', formattedSlTp);
      } catch (error) {
        console.error('Error parsing SL/TP update:', error);
      }
    });

    console.log('Redis subscriptions initialized');
    console.log('Listening on channels:', {
      marketData: 'market:data',
      orderExecutions: 'orders:executions',
      systemAlerts: 'system:alerts',
      positionUpdates: 'POSITION_UPDATE',
      orderFills: 'ORDER_FILLED',
      stopLossTakeProfit: 'SL_TP_UPDATE'
    });
  } catch (error) {
    console.error('Failed to initialize Redis subscriptions:', error);
    // Continue running even if Redis is not available initially
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await redisSubscriber.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await redisSubscriber.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 4675;

server.listen(PORT, async () => {
  console.log(`Trading Chart Server is running on port ${PORT}`);
  console.log(`Health check available at: http://localhost:${PORT}/health`);
  
  // Initialize Redis subscriptions after server starts
  await initializeRedisSubscription();
});
