# TSX Trading Bot V5 - Complete Architecture Documentation

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Overview](#system-overview)
3. [Architecture Components](#architecture-components)
4. [Connection Protocols](#connection-protocols)
5. [Core Modules](#core-modules)
6. [Data Flow](#data-flow)
7. [Configuration System](#configuration-system)
8. [Risk Management](#risk-management)
9. [Error Handling & Recovery](#error-handling--recovery)
10. [Security & Authentication](#security--authentication)
11. [Performance & Monitoring](#performance--monitoring)
12. [Deployment Architecture](#deployment-architecture)

---

## Executive Summary

The TSX Trading Bot V5 is a sophisticated automated trading system designed for TopStepX trading platform. It implements a modular, scalable architecture with real-time market data processing, risk management, and multi-strategy support. The system is built using Node.js with a microservices approach, featuring:

- **Multi-bot orchestration** with independent strategy execution
- **Real-time market data aggregation** through WebSocket connections
- **Comprehensive risk management** at both bot and system levels
- **High-performance message passing** via Redis pub/sub
- **Fault-tolerant design** with automatic recovery mechanisms

### Key Technologies
- **Runtime**: Node.js 18+ 
- **Real-time Communication**: SignalR, WebSockets, Redis pub/sub
- **Data Storage**: Redis for caching and state management
- **Monitoring**: Custom metrics collection with dashboard
- **Testing**: Jest for unit/integration/E2E tests

---

## System Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TopStepX API & Market Hub                 │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS/WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Connection Manager                         │
│  - WebSocket/SignalR connections to TopStepX                 │
│  - Account management & authentication                       │
│  - Market data distribution                                  │
│  - Order routing                                            │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Redis Pub/Sub
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Trading Aggregator                        │
│  - Risk management & validation                             │
│  - Order queue management                                   │
│  - Position tracking                                        │
│  - Metrics collection                                       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ Redis Pub/Sub
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Trading Bot Fleet                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Bot 1   │  │  Bot 2   │  │  Bot 3   │  │  Bot N   │  │
│  │PDH/PDL   │  │  EMA     │  │  ORB     │  │ Custom   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

1. **Connection Manager**: Gateway to external trading platform
2. **Trading Aggregator**: Central coordinator for all trading operations
3. **Trading Bots**: Individual strategy implementations
4. **Redis Infrastructure**: Message bus and state management
5. **Monitoring Services**: Real-time metrics and dashboards

---

## Architecture Components

### 1. Connection Manager (`connection-manager/`)

**Purpose**: Manages all external connections to TopStepX platform

**Key Files**:
- `index.js`: Main entry point and Express server setup
- `core/ConnectionManager.js`: Core connection logic
- `handlers/`: WebSocket and API handlers
- `services/`: Market data and event broadcasting

**Features**:
- WebSocket connection management with auto-reconnection
- SignalR hub connections for real-time data
- Account switching and management
- HTTP REST API for internal services
- Health monitoring and status reporting

**API Endpoints**:
- `GET /health`: Health check endpoint
- `GET /status`: Connection status
- `GET /current-account/:service`: Get active account for service
- `GET /account/balance`: Account balance information
- `POST /command`: Execute trading commands
- `GET /api/positions`: Fetch current positions
- `POST /api/position/update-sltp`: Update stop-loss/take-profit

### 2. Trading Aggregator (`src/core/aggregator/`)

**Purpose**: Central coordinator for all trading operations

**Key Components**:
- `TradingAggregator.js`: Main aggregator class
- `core/RiskManager.js`: Global risk validation
- `core/QueueManager.js`: Order queue management
- `core/SLTPCalculator.js`: Stop-loss/take-profit calculations
- `core/BotRegistry.js`: Bot registration and tracking
- `adapters/RedisAdapter.js`: Redis integration
- `adapters/ConnectionManagerAdapter.js`: Connection manager integration
- `monitoring/`: Metrics collection and reporting

**Responsibilities**:
- Risk validation and enforcement
- Order queueing and prioritization
- Position aggregation across all bots
- Global daily loss limits
- Metrics collection and reporting

### 3. Trading Bots (`src/core/trading/`)

**Purpose**: Individual trading strategy implementations

**Core Classes**:
- `TradingBot.js`: Base bot class with common functionality
- `AggregatorClient.js`: Client for aggregator communication
- `bot-launcher.js`: Bot initialization and configuration
- `bot-standalone.js`: Standalone bot execution

**Bot Lifecycle**:
1. Configuration loading from YAML files
2. Strategy initialization
3. Connection to aggregator
4. Market data subscription
5. Signal generation
6. Order submission through aggregator
7. Position management

### 4. Strategies (`src/strategies/`)

**Available Strategies**:

#### PDH/PDL Strategy (`PDHPDLStrategy-Comprehensive.js`)
- **Concept**: Trade breakouts and fades at Previous Day High/Low
- **Features**:
  - RTH (Regular Trading Hours) filtering
  - Volume Profile analysis (POC, HVN, LVN)
  - Cumulative Delta calculation
  - ADX market structure analysis
  - Liquidity Sweep detection
  - Time-based optimization for different market sessions

#### EMA Strategy (`ema/`)
- Exponential Moving Average crossover strategy
- Trend following with dynamic stops

#### ORB Rubber Band Strategy (`orb-rubber-band/`)
- Opening Range Breakout with mean reversion
- Time-based entries with volatility filters

---

## Connection Protocols

### 1. Redis Pub/Sub Architecture

**Channels Structure**:
```
aggregator:*              # Aggregator namespace
├── aggregator:orders     # Order submissions from bots
├── aggregator:fills      # Fill notifications
├── aggregator:status     # Status updates
├── aggregator:metrics    # Performance metrics
└── aggregator:market-data # Market data distribution

bot:{botId}:*            # Bot-specific namespace
├── bot:{botId}:control  # Control commands
├── bot:{botId}:signals  # Trading signals
├── bot:{botId}:status   # Bot status
└── bot:{botId}:pnl      # P&L updates

connection-manager:*      # Connection manager namespace
├── connection-manager:market-data
├── connection-manager:positions
└── connection-manager:account-updates
```

**Message Format**:
```javascript
{
  type: 'ORDER_SUBMISSION',
  timestamp: '2024-01-01T10:00:00.000Z',
  source: 'bot_1',
  payload: {
    orderId: 'uuid',
    symbol: 'MGC',
    side: 'BUY',
    quantity: 1,
    orderType: 'MARKET',
    stopLoss: 1850.0,
    takeProfit: 1870.0
  },
  metadata: {
    strategy: 'PDH_PDL',
    signal: 'BREAKOUT'
  }
}
```

### 2. WebSocket Connections

**Connection Manager WebSocket Server**:
- Port: 7500 (configurable)
- Protocol: ws://
- Authentication: API key based
- Heartbeat: 30-second intervals

**TopStepX SignalR Hubs**:
- Market Hub: `https://rtc.topstepx.com/hubs/market`
- User Hub: `https://rtc.topstepx.com/hubs/user`
- Protocol: SignalR (Microsoft)
- Authentication: JWT token

### 3. HTTP REST APIs

**Internal APIs**:
- Connection Manager API: `http://localhost:7500`
- Trading Aggregator Monitoring: `http://localhost:7700`
- Manual Trading UI: `http://localhost:7400`
- Control Panel: `http://localhost:3000`

**External APIs**:
- TopStepX API: `https://api.topstepx.com`
- TopStepX User API: `https://userapi.topstepx.com`

---

## Core Modules

### 1. Configuration Management

**Location**: `src/infrastructure/config/`

**Configuration Hierarchy**:
1. Environment variables (`.env`)
2. Global configuration (`config/global.yaml`)
3. Bot-specific configs (`config/bots/*.yaml`)
4. Runtime overrides

**Configuration Structure**:
```yaml
# Bot Configuration Example
bot:
  id: "bot_1"
  name: "PDH_PDL_Bot"
  enabled: true
  
instrument:
  symbol: "MGC"
  exchange: "COMEX"
  
strategy:
  type: "PDH_PDL"
  params:
    dollarRiskPerTrade: 100
    maxRiskPoints: 3.0
    riskRewardRatio: 2.0
    
risk:
  maxPositions: 3
  maxDailyLoss: 500
  maxDrawdown: 1000
```

### 2. Risk Management System

**Global Risk Manager** (`src/core/aggregator/core/RiskManager.js`):
- Account-level risk limits
- Daily loss limits
- Maximum position limits
- Margin requirement validation
- Drawdown protection

**Bot-Level Risk**:
- Position sizing based on dollar risk
- Stop-loss enforcement
- Risk-reward ratio validation
- Maximum signals per day
- Time-based restrictions

**Risk Validation Flow**:
```
Order Request → Bot Risk Check → Aggregator Risk Check → Execution
                     ↓                    ↓
                  Reject              Reject/Queue
```

### 3. Logging Infrastructure

**FileLogger** (`shared/utils/FileLogger.js`):
- Component-based logging
- Rotating log files
- Multiple log levels (DEBUG, INFO, WARN, ERROR)
- Structured JSON logging
- Performance metrics logging

**Log Directory Structure**:
```
logs/
├── connectionmanager/
├── tradingaggregator/
├── tradingbot_bot_1/
├── manualtrading/
└── [component]/[date].log
```

### 4. PnL Module

**Location**: `src/core/pnl/PnLModule.js`

**Features**:
- Real-time P&L calculation
- Position tracking
- Daily/weekly/monthly aggregation
- Drawdown calculation
- Win rate statistics
- Risk metrics (Sharpe ratio, etc.)

---

## Data Flow

### 1. Market Data Flow

```
TopStepX Market Hub
    ↓ (SignalR/WebSocket)
Connection Manager
    ↓ (Redis Pub/Sub)
Trading Aggregator
    ↓ (Redis Pub/Sub)
Trading Bots
    ↓ (Strategy Processing)
Trading Signals
```

### 2. Order Execution Flow

```
Bot Strategy Signal
    ↓ (Validation)
Bot Risk Manager
    ↓ (Redis Pub/Sub)
Trading Aggregator
    ↓ (Global Risk Check)
Queue Manager
    ↓ (Redis Pub/Sub)
Connection Manager
    ↓ (API Call)
TopStepX API
    ↓ (Confirmation)
Fill Notification
    ↓ (Broadcasting)
All Components Update
```

### 3. Position Management Flow

```
Position Update (TopStepX)
    ↓
Connection Manager
    ↓ (Parse & Validate)
Position Cache Update
    ↓ (Redis Broadcast)
Trading Aggregator
    ↓ (State Update)
Trading Bots
    ↓ (Strategy Adjustment)
Risk Recalculation
```

---

## Configuration System

### Environment Variables

**Required Variables**:
```bash
# TopStepX Credentials
TOPSTEP_USERNAME_REAL=your_username
TOPSTEP_API_KEY_REAL=your_api_key

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# Service Ports
CONNECTION_MANAGER_PORT=7500
AGGREGATOR_MONITORING_PORT=7700
MANUAL_TRADING_PORT=7400

# Feature Flags
START_TRADING_AGGREGATOR=true
ENABLE_MONITORING=true
ENABLE_REDIS_METRICS=true
```

### YAML Configuration Files

**Global Config** (`config/global.yaml`):
- System-wide settings
- Default risk parameters
- Service endpoints
- Feature toggles

**Bot Configs** (`config/bots/*.yaml`):
- Bot-specific parameters
- Strategy configuration
- Risk limits
- Trading hours

### Runtime Configuration

- Dynamic parameter updates
- Hot-reloading support
- Configuration validation
- Override mechanisms

---

## Risk Management

### Multi-Level Risk Controls

1. **System Level**:
   - Maximum account drawdown
   - Daily loss limits
   - Circuit breakers
   - Emergency shutdown

2. **Aggregator Level**:
   - Position concentration limits
   - Correlation risk management
   - Margin requirement validation
   - Order rate limiting

3. **Bot Level**:
   - Position sizing
   - Stop-loss enforcement
   - Signal validation
   - Time-based restrictions

### Risk Metrics Tracked

- **Real-time Metrics**:
  - Open P&L
  - Daily P&L
  - Position exposure
  - Margin utilization

- **Historical Metrics**:
  - Maximum drawdown
  - Win/loss ratio
  - Average risk per trade
  - Sharpe ratio

---

## Error Handling & Recovery

### Connection Recovery

**Connection Manager**:
- Automatic reconnection with exponential backoff
- Connection pooling for redundancy
- Heartbeat monitoring
- Graceful degradation

**Redis Connections**:
- Connection pool management
- Automatic failover
- Message queueing during disconnection
- State recovery on reconnection

### Error Categories

1. **Critical Errors**:
   - Account authentication failure
   - Risk limit breach
   - System resource exhaustion
   - Data corruption

2. **Recoverable Errors**:
   - Network timeouts
   - Temporary API failures
   - Redis connection loss
   - Market data gaps

### Recovery Strategies

- **Retry Mechanisms**: Exponential backoff with jitter
- **Circuit Breakers**: Prevent cascade failures
- **Fallback Options**: Alternative data sources
- **State Recovery**: Persistent state restoration
- **Alert System**: Real-time error notifications

---

## Security & Authentication

### Authentication Flow

1. **API Key Management**:
   - Environment variable storage
   - No hardcoded credentials
   - Key rotation support

2. **TopStepX Authentication**:
   - JWT token management
   - Automatic token refresh
   - Secure token storage

3. **Internal Security**:
   - Service-to-service authentication
   - CORS configuration
   - Request validation

### Security Best Practices

- **Data Encryption**: TLS for all external communications
- **Input Validation**: Strict parameter validation
- **Access Control**: Role-based permissions
- **Audit Logging**: All trading actions logged
- **Secure Configuration**: Sensitive data in environment variables

---

## Performance & Monitoring

### Metrics Collection

**System Metrics**:
- CPU and memory usage
- Network latency
- Message queue depth
- Connection pool status

**Trading Metrics**:
- Order execution latency
- Fill rate
- Slippage analysis
- Strategy performance

**Business Metrics**:
- P&L tracking
- Risk utilization
- Win/loss ratios
- Position turnover

### Monitoring Dashboard

**Location**: `http://localhost:7700`

**Features**:
- Real-time metrics display
- Historical charts
- Alert management
- System health overview

### Performance Optimizations

1. **Message Batching**: Aggregate multiple messages
2. **Connection Pooling**: Reuse connections
3. **Caching Strategy**: Redis-based caching
4. **Async Processing**: Non-blocking operations
5. **Resource Limits**: Memory and CPU constraints

---

## Deployment Architecture

### Service Startup Sequence

1. **Redis Server**: Must be running first
2. **Connection Manager**: Establishes external connections
3. **Trading Aggregator**: Initializes risk management
4. **Trading Bots**: Start individual strategies
5. **Monitoring Services**: Optional dashboards

### Deployment Scripts

**Windows Batch Files** (`scripts/`):
- `services/start-redis.bat`: Start Redis server
- `services/start-connection-manager.bat`: Start connection manager
- `services/start-aggregator.bat`: Start aggregator
- `bots/start-bot-*.bat`: Start individual bots
- `control/START-ALL.bat`: Start entire system

### Process Management

- **Process Monitoring**: Health checks and auto-restart
- **Graceful Shutdown**: Clean disconnection and state saving
- **Log Rotation**: Automatic log file management
- **Resource Cleanup**: Proper connection closing

### Environment Considerations

**Development**:
- Local Redis instance
- Mock trading API
- Verbose logging
- Debug endpoints

**Production**:
- Redis clustering
- Load balancing
- Error aggregation
- Performance monitoring

---

## System Workflows

### 1. System Initialization

```
1. Load environment configuration
2. Initialize Redis connections
3. Start Connection Manager
   - Authenticate with TopStepX
   - Establish WebSocket connections
   - Start health monitoring
4. Start Trading Aggregator
   - Initialize risk manager
   - Setup message queues
   - Start metrics collection
5. Launch Trading Bots
   - Load bot configurations
   - Initialize strategies
   - Connect to aggregator
6. Begin Trading Operations
```

### 2. Trading Day Workflow

```
Pre-Market:
- Fetch account status
- Calculate PDH/PDL levels
- Initialize volume profiles
- Reset daily metrics

Market Open:
- Activate trading strategies
- Begin market data processing
- Monitor positions

Intraday:
- Process trading signals
- Manage positions
- Update risk metrics
- Handle fills and updates

Market Close:
- Close open positions (optional)
- Generate daily reports
- Archive logs
- Reset for next day
```

### 3. Order Lifecycle

```
1. Signal Generation (Bot)
   - Strategy conditions met
   - Risk validation passed
   
2. Order Submission (Bot → Aggregator)
   - Send via Redis pub/sub
   - Include SL/TP levels
   
3. Risk Validation (Aggregator)
   - Check global limits
   - Validate margin
   
4. Queue Management (Aggregator)
   - Priority queueing
   - Rate limiting
   
5. Execution (Connection Manager)
   - Submit to TopStepX
   - Handle response
   
6. Fill Processing
   - Update positions
   - Broadcast to all components
   - Update P&L
```

---

## Troubleshooting Guide

### Common Issues

1. **Connection Issues**:
   - Check Redis server status
   - Verify API credentials
   - Check network connectivity
   - Review firewall settings

2. **Trading Issues**:
   - Verify account status
   - Check risk limits
   - Review strategy parameters
   - Examine order rejections

3. **Performance Issues**:
   - Monitor message queue depth
   - Check Redis memory usage
   - Review log file sizes
   - Analyze network latency

### Debug Tools

- **Log Analysis**: Check component-specific logs
- **Redis CLI**: Monitor pub/sub channels
- **Health Endpoints**: Check service status
- **Monitoring Dashboard**: Real-time metrics

### Recovery Procedures

1. **Full System Restart**:
   ```batch
   scripts/control/STOP-ALL.bat
   scripts/control/START-ALL.bat
   ```

2. **Component Restart**:
   - Stop specific service
   - Clear Redis cache if needed
   - Restart service
   - Verify connectivity

3. **Emergency Shutdown**:
   - Use FORCE_STOP.bat
   - Manually kill processes
   - Clear Redis database
   - Full system restart

---

## Conclusion

The TSX Trading Bot V5 represents a sophisticated, production-ready automated trading system with:

- **Robust Architecture**: Microservices design with clear separation of concerns
- **Comprehensive Risk Management**: Multi-level risk controls and validation
- **High Performance**: Optimized for low-latency trading operations
- **Fault Tolerance**: Automatic recovery and error handling
- **Scalability**: Support for multiple bots and strategies
- **Monitoring**: Real-time metrics and comprehensive logging

The system is designed to handle real-money trading with appropriate safeguards while maintaining the flexibility to add new strategies and adapt to changing market conditions.

## Appendices

### A. File Structure
```
TSX-Trading-Bot-V5/
├── connection-manager/     # External connection management
├── src/
│   ├── core/
│   │   ├── aggregator/    # Central coordinator
│   │   ├── trading/       # Bot framework
│   │   └── pnl/          # P&L calculations
│   ├── strategies/        # Trading strategies
│   ├── infrastructure/    # Core services
│   └── ui/               # User interfaces
├── config/                # Configuration files
├── scripts/               # Deployment scripts
├── shared/                # Shared utilities
├── logs/                  # Application logs
└── tests/                 # Test suites
```

### B. Key Dependencies
- Node.js 18+
- Redis 4.7+
- @microsoft/signalr 8.0
- Express 4.18
- Socket.io 4.8
- Winston logging
- Jest testing

### C. Performance Benchmarks
- Order submission latency: <50ms
- Market data processing: <10ms
- Risk validation: <5ms
- Message throughput: 1000+ msg/sec
- Concurrent bots: 10+

### D. Contact & Support
- Documentation: This document
- Logs: `logs/` directory
- Monitoring: http://localhost:7700
- Configuration: `config/` directory