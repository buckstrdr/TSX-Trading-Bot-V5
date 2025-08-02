# TSX Trading Bot V4 - Configuration Guide

## Table of Contents
1. [Quick Start](#quick-start)
2. [Environment Variables](#environment-variables)
3. [Configuration Files](#configuration-files)
4. [API Mode Switching](#api-mode-switching)
5. [Trading Strategy Configuration](#trading-strategy-configuration)
6. [Risk Management Settings](#risk-management-settings)
7. [Service-Specific Configurations](#service-specific-configurations)
8. [Network and Security Settings](#network-and-security-settings)
9. [Performance Tuning](#performance-tuning)
10. [Backup and Recovery](#backup-and-recovery)
11. [Troubleshooting](#troubleshooting)

## Quick Start

### 1. Initial Setup
```bash
# Copy environment template
cp .env.example .env

# Edit environment variables (see section below)
nano .env

# Validate configuration
npm run validate:config
```

### 2. Safe Testing Configuration
For first-time setup, use these safe defaults:
- **API Mode**: FAKE (test mode)
- **Shadow Mode**: true (monitor only, no real trades)
- **Max Daily Loss**: $200 (low risk)
- **Position Size**: 1 contract
- **Live Trading**: false

---

## Environment Variables

### Core Environment File (.env)

Create your `.env` file from the template:

```bash
# TSX Trading Bot V4 - Environment Configuration
# Copy this file to .env and fill in your actual values

# ========================
# API CREDENTIALS
# ========================
TOPSTEP_USERNAME=your_topstep_username
TOPSTEP_API_KEY=your_topstep_api_key
TOPSTEP_SECRET_KEY=your_topstep_secret_key

# ========================
# DATABASE & CACHE
# ========================
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ========================
# APPLICATION ENVIRONMENT
# ========================
NODE_ENV=development
LOG_LEVEL=info
TIMEZONE=America/New_York

# ========================
# SERVICE PORTS
# ========================
CONTROL_PANEL_PORT=3004
CONFIG_UI_PORT=3000
MANUAL_TRADING_PORT=3003
CONNECTION_MANAGER_PORT=7500
AGGREGATOR_HEALTH_PORT=7600
AGGREGATOR_MONITORING_PORT=7700

# ========================
# SECURITY
# ========================
SESSION_SECRET=your-secure-random-string-change-this
JWT_SECRET=your-jwt-secret-change-this-too
ENCRYPT_PRIVATE_DATA=true

# ========================
# TRADING MODES
# ========================
ENABLE_LIVE_TRADING=false
ENABLE_PAPER_TRADING=true
SHADOW_MODE=true
API_MODE=FAKE

# ========================
# RISK MANAGEMENT
# ========================
MAX_DAILY_LOSS=500
MAX_DAILY_PROFIT=800
MAX_OPEN_POSITIONS=3
MAX_POSITION_SIZE=1
EMERGENCY_STOP_DRAWDOWN=2000

# ========================
# PERFORMANCE
# ========================
MAX_CONCURRENT_ORDERS=10
ORDER_RATE_LIMIT_PER_MINUTE=30
WEBSOCKET_RECONNECT_INTERVAL=5000
MARKET_DATA_CACHE_TTL=1000

# ========================
# MONITORING & ALERTS
# ========================
ENABLE_METRICS=true
METRICS_RETENTION_DAYS=30
ALERT_WEBHOOK_URL=
SLACK_WEBHOOK_URL=
DISCORD_WEBHOOK_URL=

# ========================
# FEATURE FLAGS
# ========================
ENABLE_TRADING_AGGREGATOR=true
ENABLE_RISK_MANAGEMENT=true
ENABLE_AUTO_STOP_LOSS=true
ENABLE_TRAILING_STOP=false
ENABLE_POSITION_SIZING=true
ENABLE_CIRCUIT_BREAKER=true

# ========================
# DEBUG & DEVELOPMENT
# ========================
DEBUG_MODE=false
VERBOSE_LOGGING=false
SAVE_ALL_MARKET_DATA=false
ENABLE_PERFORMANCE_METRICS=true
```

### Environment-Specific Files

#### Development (.env.development)
```bash
NODE_ENV=development
LOG_LEVEL=debug
SHADOW_MODE=true
API_MODE=FAKE
ENABLE_LIVE_TRADING=false
VERBOSE_LOGGING=true
DEBUG_MODE=true
```

#### Production (.env.production)
```bash
NODE_ENV=production
LOG_LEVEL=info
SHADOW_MODE=false
API_MODE=REAL
ENABLE_LIVE_TRADING=true
VERBOSE_LOGGING=false
DEBUG_MODE=false
ENCRYPT_PRIVATE_DATA=true
```

#### Testing (.env.test)
```bash
NODE_ENV=test
LOG_LEVEL=error
SHADOW_MODE=true
API_MODE=FAKE
ENABLE_LIVE_TRADING=false
REDIS_DB=1
```

---

## Configuration Files

### Global Configuration (config/global.yaml)

The main system configuration file controlling all aspects of the trading bot:

```yaml
# System-wide configuration
system:
  environment: PRODUCTION  # DEVELOPMENT | STAGING | PRODUCTION
  timezone: America/New_York
  ports:
    manualTrading: 3003
    tradingAggregator: 7600
    botRange:
      start: 3004
      end: 3009
    redis: 6379
  process:
    autoRestart: true
    restartDelay: 5000
    maxRestarts: 10
    gracefulShutdownTimeout: 10000

# TopStep API Configuration
api:
  baseUrl: https://api.topstepx.com
  marketHubUrl: https://rtc.topstepx.com/hubs/market
  userHubUrl: https://rtc.topstepx.com/hubs/user
  connection:
    timeout: 15000
    retryAttempts: 3
    retryDelay: 5000
    keepAliveInterval: 30000
  rateLimits:
    maxRequestsPerMinute: 120
    maxOrdersPerMinute: 60
    maxMarketDataPerSecond: 10

# Redis Configuration
redis:
  host: localhost
  port: 6379
  password: ''
  db: 0
  keyPrefix: 'tsx_bot_v4:'
  channels:
    marketData: market:data
    orders: order:management
    positions: position:updates
    alerts: system:alerts
    config: config:updates
    health: health:status

# Logging Configuration
logging:
  level: INFO  # DEBUG | INFO | WARN | ERROR
  outputs:
    console: true
    file: true
    redis: false
  file:
    directory: ./logs
    maxSize: 10mb
    maxFiles: 10
    compress: true
    format: json
  categories:
    trading: true
    market: true
    system: true
    errors: true

# Market Data Configuration
marketData:
  cache:
    enabled: true
    ttl: 1000
    maxSize: 1000
  validation:
    checkTimestamps: true
    maxAge: 5000
    rejectStale: true
  deduplication:
    enabled: true
    window: 100

# Trading Defaults
tradingDefaults:
  contractSpecs:
    MGC:
      name: Micro Gold
      multiplier: 10
      tickSize: 0.1
      currency: USD
    MES:
      name: Micro E-mini S&P 500
      multiplier: 5
      tickSize: 0.25
      currency: USD
    MNQ:
      name: Micro E-mini Nasdaq
      multiplier: 2
      tickSize: 0.25
      currency: USD
  defaultRisk:
    dollarRiskPerTrade: 200
    maxDailyLoss: 800
    maxDailyProfit: 600
    maxOpenPositions: 1

# Trading Aggregator Configuration
aggregator:
  enabled: true
  shadowMode: false
  globalRisk:
    maxDailyLoss: 500
    maxDailyProfit: 600
    maxOpenPositions: 5
    maxAccountDrawdown: 1000
    pauseOnDailyLoss: true
  positionLimits:
    maxOrderSize: 10
    maxPositionSize: 20
    maxPositionValue: 50000
  rateLimits:
    maxOrdersPerMinute: 30
    maxOrdersPerSymbol: 5
    maxOrdersPerSource: 10
  tradingHours:
    enabled: true
    sessions:
      - start: '00:00'
        end: '17:00'
        days: [0, 1, 2, 3, 4]  # Sunday-Thursday
      - start: '18:00'
        end: '23:59'
        days: [0, 1, 2, 3, 4]
    timezone: America/Chicago
  sltp:
    enableTrailingStop: false
    placeBracketOrders: true
  queue:
    maxQueueSize: 100
    processingInterval: 100
    maxConcurrentOrders: 5
    priorityLevels:
      stopLoss: 10
      marketOrder: 8
      limitOrder: 5
      modification: 9

# Monitoring Configuration
monitoring:
  healthCheck:
    enabled: true
    interval: 30000
    timeout: 5000
  alerts:
    enabled: true
    channels:
      - console
      - redis
    thresholds:
      maxDrawdown: 500
      connectionLoss: 3
      orderFailureRate: 0.1
      systemCpu: 80
      systemMemory: 80
  metrics:
    enabled: true
    interval: 300000
    retention: 30

# Emergency Configuration
emergency:
  killSwitch:
    enabled: true
    triggerDrawdown: 2000
    closeAllPositions: true
    disableTrading: true
    notifyAdmin: true
  circuitBreaker:
    enabled: true
    maxFailures: 10
    resetTimeout: 300000
    halfOpenRequests: 3
```

### Instruments Configuration (config/instruments.yaml)

Define trading instruments and their specifications:

```yaml
instruments:
  MGC:
    name: Micro Gold
    symbol: CON.F.US.MGC.Z25
    type: FUTURE
    exchange: COMEX
    currency: USD
    multiplier: 10
    tickSize: 0.1
    tickValue: 1.0
    commission: 2.50
    marginRequirement: 400
    tradingHours:
      - start: '17:00'
        end: '16:00'
        timezone: America/Chicago
        name: Regular Trading
  
  MES:
    name: Micro E-mini S&P 500
    symbol: CON.F.US.MES.U25
    type: FUTURE
    exchange: CME
    currency: USD
    multiplier: 5
    tickSize: 0.25
    tickValue: 1.25
    commission: 2.50
    marginRequirement: 1320
    tradingHours:
      - start: '17:00'
        end: '16:00'
        timezone: America/Chicago
        name: Regular Trading
  
  MNQ:
    name: Micro E-mini Nasdaq
    symbol: CON.F.US.MNQ.U25
    type: FUTURE
    exchange: CME
    currency: USD
    multiplier: 2
    tickSize: 0.25
    tickValue: 0.50
    commission: 2.50
    marginRequirement: 1680
    tradingHours:
      - start: '17:00'
        end: '16:00'
        timezone: America/Chicago
        name: Regular Trading
```

---

## API Mode Switching

### Current API Mode
Check current mode:
```bash
cat config/api-mode.json
```

### Switch Between Modes

#### Manual Switching
```bash
# Switch to FAKE mode (safe testing)
npm run switch:fake

# Switch to REAL mode (live trading)
npm run switch:real

# Or use the batch script
SWITCH-API-MODE.bat
```

#### Programmatic Switching
```javascript
const fs = require('fs');

function switchApiMode(mode) {
  const config = {
    mode: mode.toUpperCase(), // 'FAKE' or 'REAL'
    lastSwitchTime: new Date().toISOString(),
    switchCount: getCurrentSwitchCount() + 1,
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync('config/api-mode.json', JSON.stringify(config, null, 2));
  console.log(`API mode switched to: ${mode}`);
}
```

### API Mode Configuration

#### FAKE Mode (config/api-mode.json)
```json
{
  "mode": "FAKE",
  "baseUrl": "http://localhost:3001",
  "endpoints": {
    "orders": "/api/fake/orders",
    "positions": "/api/fake/positions",
    "marketData": "/api/fake/market-data"
  },
  "features": {
    "simulateLatency": true,
    "latencyRange": [50, 200],
    "simulateErrors": false,
    "errorRate": 0.02
  }
}
```

#### REAL Mode (config/api-mode.json)
```json
{
  "mode": "REAL",
  "baseUrl": "https://api.topstepx.com",
  "endpoints": {
    "orders": "/api/orders",
    "positions": "/api/positions",
    "marketData": "/api/market-data"
  },
  "features": {
    "requireConfirmation": true,
    "maxOrderValue": 50000,
    "additionalValidation": true
  }
}
```

---

## Trading Strategy Configuration

### Individual Bot Configuration

Each bot has its own configuration file in `config/bots/`:

```yaml
# config/bots/BOT_1.yaml
botId: BOT_1
port: 3004
enabled: false
description: EMA Crossover Strategy
instrument: CON.F.US.MES.U25

# Strategy Configuration
strategy:
  type: EMA_CROSS
  parameters:
    fastEMA: 9
    slowEMA: 21
    signalSmoothing: 3
    trendFilter: true
    minTrendStrength: 0.6
    
# Alternative Strategy Examples:
# strategy:
#   type: ORB_RUBBER_BAND
#   parameters:
#     orbPeriod: 30
#     extensionMultiplier: 1.5
#     pullbackPercentage: 50
#     maxTradingPeriod: 60

# strategy:
#   type: MEAN_REVERSION
#   parameters:
#     bollinger:
#       period: 20
#       standardDeviations: 2
#     rsi:
#       period: 14
#       oversold: 30
#       overbought: 70

# Risk Management
risk:
  dollarRiskPerTrade: 200
  maxConsecutiveLosses: 3
  maxDailyLoss: 500
  positionSizing:
    method: FIXED  # FIXED | PERCENTAGE | KELLY | ATR
    fixedSize: 1
    percentageOfAccount: 2
    kellyFraction: 0.25
    atrMultiplier: 2

# Trading Hours
tradingHours:
  enabled: true
  sessions:
    - name: Regular
      start: '09:30'
      end: '16:00'
      timezone: America/New_York
      days: [1, 2, 3, 4, 5]  # Monday-Friday
    - name: Extended
      start: '18:00'
      end: '08:30'
      timezone: America/New_York
      days: [0, 1, 2, 3, 4]  # Sunday-Thursday

# Order Execution
execution:
  orderType: LIMIT  # MARKET | LIMIT | STOP | STOP_LIMIT
  slippage:
    maxTicks: 2
    useMarketOnTimeout: true
    timeoutMs: 5000
  retryFailedOrders: true
  maxRetries: 3
  fillTimeout: 30000

# Exit Strategy
exits:
  stopLoss:
    type: FIXED  # FIXED | PERCENTAGE | ATR | TRAILING
    value: 20  # Dollars for FIXED, percentage for PERCENTAGE
    moveToBreakeven: true
    breakevenTrigger: 1.5  # Risk multiples
    trailingDistance: 10  # For TRAILING type
  profitTarget:
    enabled: true
    type: RISK_MULTIPLE  # FIXED | PERCENTAGE | RISK_MULTIPLE
    value: 2  # 2:1 risk/reward ratio
    partialExits:
      - percentage: 50
        target: 1.5
      - percentage: 50
        target: 2

# Market Filters
filters:
  minVolume: 1000
  minATR: 0.5
  maxSpread: 0.1
  avoidNews: true
  newsBlackoutMinutes: 30
  marketConditions:
    - TRENDING
    - VOLATILE
  # - RANGING (exclude ranging markets)

# Monitoring
monitoring:
  trackMetrics: true
  metricsInterval: 300000
  alertOnDrawdown: 500
  logTrades: true
  logLevel: INFO
```

### Strategy Parameters Reference

#### EMA Crossover Strategy
```yaml
strategy:
  type: EMA_CROSS
  parameters:
    fastEMA: 9          # Fast EMA period
    slowEMA: 21         # Slow EMA period
    signalSmoothing: 3  # Signal line smoothing
    trendFilter: true   # Enable trend filtering
    minTrendStrength: 0.6  # Minimum trend strength (0-1)
    volatilityFilter: true
    minVolatility: 0.01
    maxVolatility: 0.05
```

#### ORB Rubber Band Strategy
```yaml
strategy:
  type: ORB_RUBBER_BAND
  parameters:
    orbPeriod: 30              # Opening range period (minutes)
    extensionMultiplier: 1.5   # Extension beyond range
    pullbackPercentage: 50     # Pullback entry percentage
    maxTradingPeriod: 60       # Max trading period (minutes)
    minRangeSize: 5            # Minimum range size (ticks)
    maxRangeSize: 50           # Maximum range size (ticks)
```

#### Bollinger Band Mean Reversion
```yaml
strategy:
  type: MEAN_REVERSION
  parameters:
    bollinger:
      period: 20
      standardDeviations: 2
      useExponential: false
    rsi:
      period: 14
      oversold: 30
      overbought: 70
    confirmation:
      requireDivergence: true
      volumeConfirmation: true
```

---

## Risk Management Settings

### Global Risk Configuration

```yaml
# In config/global.yaml
aggregator:
  globalRisk:
    # Daily Limits
    maxDailyLoss: 500        # Stop trading if daily loss reaches this
    maxDailyProfit: 600      # Optional daily profit target
    pauseOnDailyLoss: true   # Pause all trading on daily loss limit
    
    # Position Limits
    maxOpenPositions: 5      # Maximum concurrent positions
    maxPositionSize: 20      # Maximum contracts per position
    maxPositionValue: 50000  # Maximum dollar value per position
    maxAccountDrawdown: 1000 # Maximum account drawdown
    
    # Order Limits
    maxOrderSize: 10         # Maximum contracts per order
    
  # Rate Limiting
  rateLimits:
    maxOrdersPerMinute: 30   # System-wide order rate limit
    maxOrdersPerSymbol: 5    # Per-symbol order rate limit
    maxOrdersPerSource: 10   # Per-bot order rate limit
```

### Individual Bot Risk Settings

```yaml
# In config/bots/BOT_X.yaml
risk:
  # Per-Trade Risk
  dollarRiskPerTrade: 200     # Maximum loss per trade
  maxConsecutiveLosses: 3     # Stop after X consecutive losses
  
  # Daily Risk
  maxDailyLoss: 500          # Daily loss limit for this bot
  maxDailyTrades: 10         # Maximum trades per day
  
  # Position Sizing
  positionSizing:
    method: FIXED             # FIXED | PERCENTAGE | KELLY | ATR
    fixedSize: 1             # Contracts for FIXED method
    percentageOfAccount: 2    # % of account for PERCENTAGE method
    kellyFraction: 0.25      # Kelly criterion fraction
    atrMultiplier: 2         # ATR multiplier for ATR method
    
  # Risk Controls
  maxPositionTime: 14400    # Maximum position duration (seconds)
  correlationLimit: 0.7     # Maximum correlation with other positions
  concentrationLimit: 0.3   # Maximum % of portfolio in one instrument
```

### Emergency Controls

```yaml
# In config/global.yaml
emergency:
  killSwitch:
    enabled: true
    triggerDrawdown: 2000      # Trigger at this drawdown level
    closeAllPositions: true    # Close all positions immediately
    disableTrading: true       # Disable new trading
    notifyAdmin: true          # Send emergency notifications
    
  circuitBreaker:
    enabled: true
    maxFailures: 10           # Max failures before triggering
    resetTimeout: 300000      # Reset timeout (5 minutes)
    halfOpenRequests: 3       # Test requests during reset
```

---

## Service-Specific Configurations

### Trading Aggregator Configuration

```yaml
# Service configuration
aggregator:
  enabled: true
  shadowMode: false          # Set to true for monitoring without trading
  
  # Processing Configuration
  queue:
    maxQueueSize: 100
    processingInterval: 100   # Process queue every 100ms
    maxConcurrentOrders: 5
    priorityLevels:
      stopLoss: 10           # Highest priority
      marketOrder: 8
      limitOrder: 5
      modification: 9
      
  # SL/TP Configuration
  sltp:
    enableTrailingStop: false
    placeBracketOrders: true
    automaticSLTP: true
    
  # Trading Hours
  tradingHours:
    enabled: true
    sessions:
      - start: '00:00'
        end: '17:00'
        days: [0, 1, 2, 3, 4]
    timezone: America/Chicago
```

### Connection Manager Configuration

```javascript
// Connection manager specific settings
const connectionConfig = {
  api: {
    baseUrl: process.env.API_MODE === 'REAL' 
      ? 'https://api.topstepx.com' 
      : 'http://localhost:3001',
    timeout: 15000,
    retryAttempts: 3,
    retryDelay: 5000
  },
  
  websocket: {
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    pingInterval: 30000,
    pongTimeout: 5000
  },
  
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
  }
};
```

### Control Panel Configuration

```javascript
// Control panel web server configuration
const controlPanelConfig = {
  server: {
    port: process.env.CONTROL_PANEL_PORT || 3004,
    host: '0.0.0.0',
    cors: {
      origin: ['http://localhost:3000', 'http://localhost:3004'],
      credentials: true
    }
  },
  
  security: {
    sessionSecret: process.env.SESSION_SECRET,
    jwtSecret: process.env.JWT_SECRET,
    csrfProtection: true,
    rateLimiting: true
  },
  
  features: {
    realTimeUpdates: true,
    chartingEnabled: true,
    orderManagement: true,
    riskMonitoring: true
  }
};
```

### Fake API Configuration

```javascript
// Fake API service configuration
const fakeApiConfig = {
  server: {
    port: 3001,
    latencySimulation: {
      enabled: true,
      min: 50,    // Minimum latency (ms)
      max: 200    // Maximum latency (ms)
    }
  },
  
  simulation: {
    fillRate: 0.95,           // 95% fill rate
    slippage: {
      enabled: true,
      maxTicks: 1,            // Maximum slippage in ticks
      probability: 0.3        // 30% chance of slippage
    },
    marketMovement: {
      enabled: true,
      volatility: 0.01,       // Price volatility
      trendProbability: 0.6   // 60% chance of trending
    }
  },
  
  data: {
    priceFeeds: ['MES', 'MNQ', 'MGC', 'M2K', 'MYM'],
    updateInterval: 100,       // Update every 100ms
    historicalDepth: 1000     // Keep 1000 historical bars
  }
};
```

---

## Network and Security Settings

### Security Configuration (config/security.json)

```json
{
  "security": {
    "authentication": {
      "type": "jwt",
      "algorithm": "HS256",
      "issuer": "tsx-trading-bot",
      "audience": "tsx-trading-bot-api",
      "tokenExpiry": "15m",
      "refreshTokenExpiry": "7d",
      "passwordPolicy": {
        "minLength": 12,
        "requireUppercase": true,
        "requireLowercase": true,
        "requireNumbers": true,
        "requireSpecialChars": true,
        "maxAge": 90,
        "historyCount": 5
      }
    },
    
    "encryption": {
      "algorithm": "aes-256-gcm",
      "keyRotationInterval": 30,
      "dataClassification": {
        "critical": ["password", "apiKey", "secretKey", "privateKey"],
        "sensitive": ["email", "username", "accountNumber"],
        "internal": ["tradingHistory", "positions", "orders"]
      }
    },
    
    "rateLimit": {
      "global": {
        "windowMs": 60000,
        "max": 100,
        "message": "Too many requests, please try again later."
      },
      "api": {
        "orders": {
          "windowMs": 60000,
          "max": 50
        },
        "marketData": {
          "windowMs": 1000,
          "max": 100
        },
        "auth": {
          "windowMs": 900000,
          "max": 5
        }
      }
    },
    
    "cors": {
      "enabled": true,
      "origins": ["http://localhost:3000"],
      "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      "allowedHeaders": ["Content-Type", "Authorization", "X-Request-ID"],
      "credentials": true,
      "maxAge": 86400
    },
    
    "firewall": {
      "ipWhitelist": {
        "enabled": false,
        "ips": []
      },
      "ipBlacklist": {
        "enabled": true,
        "ips": []
      }
    }
  }
}
```

### Network Configuration

```yaml
# Network settings in config/global.yaml
network:
  timeouts:
    api: 15000
    websocket: 5000
    database: 10000
    
  retries:
    maxAttempts: 3
    backoffMultiplier: 2
    initialDelay: 1000
    maxDelay: 30000
    
  keepAlive:
    enabled: true
    interval: 30000
    timeout: 5000
    
  compression:
    enabled: true
    threshold: 1024
    algorithm: gzip
```

### SSL/TLS Configuration

```javascript
// SSL configuration for production
const sslConfig = {
  enabled: process.env.NODE_ENV === 'production',
  key: process.env.SSL_PRIVATE_KEY_PATH,
  cert: process.env.SSL_CERTIFICATE_PATH,
  ca: process.env.SSL_CA_PATH,
  
  options: {
    minVersion: 'TLSv1.2',
    ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4',
    honorCipherOrder: true,
    secureProtocol: 'TLSv1_2_method'
  }
};
```

---

## Performance Tuning

### Memory Management

```yaml
# Performance configuration
performance:
  memory:
    nodeOptions: "--max-old-space-size=4096"
    gcInterval: 60000
    heapSnapshotThreshold: 0.9
    
  cache:
    enabled: true
    ttl: 300000           # 5 minutes
    maxSize: 10000        # Maximum cached items
    checkPeriod: 60000    # Cleanup interval
    
  database:
    connectionPoolSize: 10
    acquireTimeoutMillis: 60000
    idleTimeoutMillis: 30000
```

### CPU Optimization

```yaml
cpu:
  workers:
    enabled: true
    count: 4              # Number of worker processes
    maxMemory: 1024       # Max memory per worker (MB)
    
  clustering:
    enabled: false        # Enable for high-load scenarios
    instances: 'max'      # Number of cluster instances
    
  processing:
    batchSize: 100        # Process orders in batches
    concurrency: 5        # Maximum concurrent operations
    throttling:
      enabled: true
      requestsPerSecond: 100
```

### Database Performance

```yaml
# Redis performance tuning
redis:
  performance:
    maxMemoryPolicy: 'allkeys-lru'
    databases: 16
    timeout: 0
    tcpKeepAlive: 60
    
  persistence:
    rdbSave: '900 1 300 10 60 10000'
    aofEnabled: false
    aofRewriteIncrementalFsync: true
    
  memory:
    maxMemory: '2gb'
    maxMemoryPolicy: 'allkeys-lru'
    lazyFree: true
```

### Network Performance

```yaml
network:
  optimization:
    tcpNoDelay: true
    tcpKeepAlive: true
    keepAliveInitialDelay: 0
    
  buffers:
    highWaterMark: 16384
    objectMode: false
    
  compression:
    enabled: true
    level: 6
    threshold: 1024
```

---

## Backup and Recovery

### Backup Configuration

```yaml
# Backup settings
backup:
  enabled: true
  
  # Automatic Backups
  automatic:
    enabled: true
    interval: 3600000      # Every hour
    retention: 168         # Keep 168 hours (7 days)
    
  # What to Backup
  targets:
    configuration: true
    logs: true
    metrics: true
    tradingHistory: true
    positions: true
    
  # Backup Storage
  storage:
    local:
      enabled: true
      path: './backups'
      compression: true
      encryption: true
      
    cloud:
      enabled: false
      provider: 'aws'       # aws | azure | gcp
      bucket: 'tsx-bot-backups'
      region: 'us-east-1'
```

### Recovery Procedures

#### Configuration Recovery
```bash
# Restore configuration from backup
cp backups/latest/config/* config/

# Validate restored configuration
npm run validate:config

# Restart services
npm run stop
npm run start
```

#### Database Recovery
```bash
# Stop Redis
sudo systemctl stop redis

# Restore Redis data
cp backups/latest/redis/dump.rdb /var/lib/redis/

# Start Redis
sudo systemctl start redis

# Verify data integrity
redis-cli ping
```

#### Log Recovery
```bash
# Restore logs
cp -r backups/latest/logs/* logs/

# Check log integrity
npm run validate:logs
```

### Disaster Recovery Plan

1. **System Failure**
   ```bash
   # Emergency stop
   npm run emergency:stop
   
   # Restore from latest backup
   npm run restore:latest
   
   # Validate system
   npm run validate:all
   
   # Restart in safe mode
   npm run start:safe
   ```

2. **Data Corruption**
   ```bash
   # Stop all services
   npm run stop:all
   
   # Restore data from backup
   npm run restore:data
   
   # Verify data integrity
   npm run verify:data
   
   # Restart services
   npm run start
   ```

3. **Configuration Issues**
   ```bash
   # Reset to default configuration
   npm run config:reset
   
   # Apply custom settings
   npm run config:apply
   
   # Validate configuration
   npm run validate:config
   ```

---

## Troubleshooting

### Common Configuration Issues

#### 1. Environment Variables Not Loading
```bash
# Check if .env file exists
ls -la .env

# Verify environment variables are set
node -e "console.log(process.env.TOPSTEP_USERNAME)"

# Check for syntax errors in .env
cat .env | grep -E "^[^#].*="
```

#### 2. Port Conflicts
```bash
# Check which ports are in use
netstat -tulpn | grep :3004

# Kill process using the port
sudo kill -9 $(lsof -t -i:3004)

# Update port configuration
nano config/global.yaml
```

#### 3. Redis Connection Issues
```bash
# Check Redis status
redis-cli ping

# Test Redis connection
redis-cli -h localhost -p 6379 ping

# Check Redis logs
tail -f /var/log/redis/redis-server.log
```

#### 4. API Connection Problems
```bash
# Test API connectivity
curl -I https://api.topstepx.com

# Check API mode
cat config/api-mode.json

# Verify API credentials
node scripts/test-api-connection.js
```

#### 5. Configuration Validation Errors
```bash
# Run configuration validation
npm run validate:config

# Check specific configuration file
node -e "console.log(require('./config/global.yaml'))"

# Validate YAML syntax
python -c "import yaml; yaml.safe_load(open('config/global.yaml'))"
```

### Debug Mode

Enable detailed debugging:

```bash
# Set debug environment variables
export DEBUG=tsx-bot:*
export NODE_ENV=development
export LOG_LEVEL=debug

# Start with debug logging
npm run start:debug
```

### Performance Diagnostics

```bash
# Check memory usage
node --expose-gc app.js &
kill -USR2 $!

# CPU profiling
node --prof app.js

# Generate CPU report
node --prof-process isolate-0x*.log > profile.txt
```

### Log Analysis

```bash
# Check error logs
tail -f logs/error.log

# Search for specific errors
grep -r "ERROR" logs/

# Analyze trading logs
grep "TRADE" logs/trading.log | tail -20
```

---

## Configuration Validation

### Automated Validation

Create a validation script to check all configurations:

```javascript
// scripts/validate-config.js
const fs = require('fs');
const yaml = require('js-yaml');
const Joi = require('joi');

function validateConfiguration() {
  console.log('🔍 Validating configuration...');
  
  // Validate environment variables
  validateEnvironmentVariables();
  
  // Validate YAML files
  validateYamlFiles();
  
  // Validate JSON files
  validateJsonFiles();
  
  // Validate bot configurations
  validateBotConfigurations();
  
  console.log('✅ Configuration validation completed successfully!');
}

function validateEnvironmentVariables() {
  const requiredVars = [
    'TOPSTEP_USERNAME',
    'TOPSTEP_API_KEY',
    'SESSION_SECRET',
    'JWT_SECRET'
  ];
  
  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }
}

// Run validation
if (require.main === module) {
  validateConfiguration();
}
```

### Pre-startup Checklist

Before starting the trading system:

- [ ] Environment variables configured
- [ ] API mode set correctly (FAKE for testing)
- [ ] Risk limits configured appropriately
- [ ] Trading hours set correctly
- [ ] Redis connection available
- [ ] Log directories exist and writable
- [ ] Bot configurations validated
- [ ] Network connectivity verified
- [ ] Security settings reviewed

---

## Quick Reference Commands

```bash
# Configuration Management
npm run validate:config        # Validate all configurations
npm run config:reset          # Reset to default configuration
npm run config:backup         # Backup current configuration

# API Mode Management
npm run switch:fake           # Switch to FAKE API mode
npm run switch:real           # Switch to REAL API mode
npm run api:status            # Check current API mode

# Service Management
npm run start                 # Start all services
npm run stop                  # Stop all services
npm run restart               # Restart all services
npm run status                # Check service status

# Monitoring
npm run monitor               # Start monitoring dashboard
npm run health                # Health check all services
npm run logs                  # View live logs

# Testing
npm run test:config           # Test configuration
npm run test:connection       # Test API connections
npm run test:trading          # Test trading functionality
```

---

**⚠️ Safety Reminders:**

1. **Always start with FAKE mode** for testing
2. **Enable shadow mode** initially to monitor without trading
3. **Set low risk limits** when first testing
4. **Verify API credentials** before switching to REAL mode
5. **Test all configurations** in a safe environment first
6. **Keep backups** of working configurations
7. **Monitor logs** continuously during operation
8. **Have an emergency stop plan** ready

For additional support, refer to the troubleshooting section or check the logs in the `logs/` directory.