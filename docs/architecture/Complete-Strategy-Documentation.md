# TSX Trading Bot V5 - Complete Strategy Documentation

## Table of Contents
1. [Strategy Overview](#strategy-overview)
2. [PDH/PDL Strategy (Comprehensive)](#pdhpdl-strategy-comprehensive)
3. [EMA 9 Retracement Scalping Strategy](#ema-9-retracement-scalping-strategy)
4. [ORB Rubber Band Strategy](#orb-rubber-band-strategy)
5. [Test Time Strategy](#test-time-strategy)
6. [Strategy Integration Architecture](#strategy-integration-architecture)
7. [Risk Management Across Strategies](#risk-management-across-strategies)
8. [Performance Metrics & Backtesting](#performance-metrics--backtesting)

---

## Strategy Overview

The TSX Trading Bot V5 implements **FOUR distinct trading strategies**, each designed for specific market conditions and trading styles:

| Strategy | Type | Time Frame | Expected Win Rate | Daily Trades | Risk Profile |
|----------|------|------------|-------------------|--------------|--------------|
| **PDH/PDL** | Breakout/Fade | 5-min | 60-70% | 6-12 | Medium |
| **EMA 9 Retracement** | Mean Reversion | 1-min | 52.4% | 100-140 | High Frequency |
| **ORB Rubber Band** | Range Breakout | 5-min | 55-60% | 4-8 | Low |
| **Test Time** | Testing Only | 5-min | N/A | 288 | Test Only |

### Strategy Factory Pattern

```javascript
// src/strategies/index.js
const strategies = {
    ORB_RUBBER_BAND: ORBRubberBandStrategy,
    EMA_CROSS: EMAStrategy,
    PDH_PDL: PDHPDLStrategy,
    TEST_TIME: TestTimeStrategy
};
```

---

## PDH/PDL Strategy (Comprehensive)

**File**: `src/strategies/PDHPDLStrategy-Comprehensive.js`  
**Version**: 2.0  
**Target Instrument**: MGC (Micro Gold Futures)

### Strategy Concept

The PDH/PDL (Previous Day High/Low) strategy trades breakouts and fades at significant daily levels, incorporating advanced market structure analysis.

### Key Components

#### 1. RTH (Regular Trading Hours) Filtering
```javascript
// Critical for accurate PDH/PDL calculation
rthStartHour: 8,         // 8:30 AM CT
rthStartMinute: 30,
rthEndHour: 15,          // 3:15 PM CT  
rthEndMinute: 15,
timezone: 'America/Chicago'
```

#### 2. Volume Profile Analysis
- **POC (Point of Control)**: Highest volume price level
- **HVN (High Volume Nodes)**: Support/resistance areas
- **LVN (Low Volume Nodes)**: Potential breakout zones

```javascript
volumeProfile: {
    poc: null,              // Point of Control
    pocZone: {             // 70% of volume concentration
        upper: null,
        lower: null
    },
    hvnLevels: [],         // High Volume Nodes (1.5x avg)
    lvnLevels: [],         // Low Volume Nodes (0.5x avg)
}
```

#### 3. Cumulative Delta Calculation
Tracks buying vs selling pressure:
```javascript
calculateCumulativeDelta(candles) {
    let cumulativeDelta = 0;
    candles.forEach(candle => {
        const bullishVolume = candle.close > candle.open ? candle.volume : 0;
        const bearishVolume = candle.close < candle.open ? candle.volume : 0;
        cumulativeDelta += (bullishVolume - bearishVolume);
    });
    return cumulativeDelta;
}
```

#### 4. ADX Market Structure Analysis
Determines trending vs ranging markets:
- **ADX > 25**: Trending market (use breakout strategy)
- **ADX < 20**: Ranging market (use fade strategy)
- **ADX 20-25**: Neutral (wait for clarity)

#### 5. Liquidity Sweep Detection
Identifies stop hunts and false breakouts:
```javascript
detectLiquiditySweep(price, previousHigh, previousLow) {
    // Penetration beyond level
    const penetration = price > previousHigh + (tickSize * penetrationTicks);
    // Quick reversal back
    const reversal = price < previousHigh - (tickSize * reversalTicks);
    // Within time window (3 bars)
    return penetration && reversal && withinTimeWindow;
}
```

### Trading Strategies

#### 1. Breakout Strategy
**Conditions**:
- Price breaks PDH/PDL with volume
- ADX > 25 (trending)
- Cumulative Delta confirms direction
- Volume > 1.5x average

**Entry**: Break + 2 tick buffer  
**Stop**: 10-12 ticks (MGC specific)  
**Target**: 2:1 risk/reward

#### 2. Fade Strategy
**Conditions**:
- Price approaches PDH/PDL
- ADX < 20 (ranging)
- Volume profile shows resistance
- Time: NY afternoon (best for fades)

**Entry**: At PDH/PDL level  
**Stop**: 5-10 ticks  
**Target**: Middle of range

#### 3. Liquidity Sweep Strategy
**Conditions**:
- False breakout detected
- Quick reversal (within 3 bars)
- Volume spike on reversal

**Entry**: After sweep confirmation  
**Stop**: 6 ticks  
**Target**: Opposite PDH/PDL level

### Time-Based Optimization

```javascript
// Best times for different strategies
nyMorningSessionStart: '09:30',  // Breakouts
londonNyOverlapStart: '08:30',   // Maximum volatility
nyAfternoonStart: '14:00',       // Fades
```

### Signal Generation Logic

```javascript
generateSignal(marketData) {
    // 1. Check RTH validation
    if (!this.isRTHSession()) return null;
    
    // 2. Analyze market structure
    const marketStructure = this.analyzeMarketStructure();
    
    // 3. Check for setups
    if (marketStructure.trending && this.breakoutSetup()) {
        return this.generateBreakoutSignal();
    }
    if (marketStructure.ranging && this.fadeSetup()) {
        return this.generateFadeSignal();
    }
    if (this.liquiditySweepDetected()) {
        return this.generateSweepSignal();
    }
    
    return null;
}
```

---

## EMA 9 Retracement Scalping Strategy

**File**: `src/strategies/ema/emaStrategy.js`  
**Version**: 3.0  
**Target**: High-frequency scalping

### Strategy Concept

Trades retracements to the 9-period EMA with dynamic stop placement based on EMA 19 distance.

### State Machine Architecture

```javascript
stateMachine: {
    currentState: 'NEUTRAL',
    longSetup: {
        hasEnteredZone: false,      // Price below EMA 9
        entryTime: null,
        candlesSinceEntry: 0,
        lowBelowEMA: null,
        hasRetraced: false,          // Price back above EMA 9
        validSetup: false
    },
    shortSetup: {
        hasEnteredZone: false,       // Price above EMA 9
        entryTime: null,
        candlesSinceEntry: 0,
        highAboveEMA: null,
        hasRetraced: false,          // Price back below EMA 9
        validSetup: false
    }
}
```

### Trading Modes

#### 1. Standard Mode (v3.0)
- **Expected**: ~139 trades/day
- **Win Rate**: 52.4%
- **Logic**: Real-time signal generation

#### 2. Conservative Mode
- **Expected**: ~45-50 trades/day
- **Win Rate**: 48-50%
- **Logic**: EMA invalidation filter enabled

### Entry Conditions

**Long Setup**:
1. Price dips below EMA 9
2. Within 2 candles, price crosses back above EMA 9
3. EMA 9 > EMA 19 (uptrend)
4. Entry: When price crosses EMA 9

**Short Setup**:
1. Price rises above EMA 9
2. Within 2 candles, price crosses back below EMA 9
3. EMA 9 < EMA 19 (downtrend)
4. Entry: When price crosses EMA 9

### Dynamic Risk Management

```javascript
calculateDynamicStopLoss(entryPrice, ema9, ema19) {
    const emaDistance = Math.abs(ema9 - ema19);
    const riskMultiplier = 1.5; // Stop at 1.5x EMA distance
    
    if (direction === 'LONG') {
        return entryPrice - (emaDistance * riskMultiplier);
    } else {
        return entryPrice + (emaDistance * riskMultiplier);
    }
}
```

### Post-Trade Timeout

```javascript
onPositionClosed(timestamp, wasProfit) {
    const timeoutSeconds = wasProfit ? 
        180 :  // 3 minutes after win
        600;   // 10 minutes after loss
}
```

### Real-Time State Updates

```javascript
updatePriceState(price, ema9, ema19, timestamp) {
    // Determine trend
    const trend = this.analyzeTrend(price, ema9, ema19);
    
    // Update state machine
    if (trend === 'LONG') {
        this.updateLongState(price, ema9, ema19);
    } else if (trend === 'SHORT') {
        this.updateShortState(price, ema9, ema19);
    }
    
    // Check consolidation
    this.updateConsolidationTracking(price, ema9, ema19);
}
```

---

## ORB Rubber Band Strategy

**File**: `src/strategies/orb-rubber-band/ORBRubberBandStrategy.js`  
**Version**: 2.0  
**Target**: Opening range breakouts with reversal detection

### Strategy Concept

Trades breakouts from the opening range with monitoring for failed breakouts (rubber band effect).

### Opening Range Definition

```javascript
openingRange: {
    high: null,
    low: null,
    established: false,
    establishedTime: null,
    session: 'LONDON' | 'NY' | 'BOTH'
}
```

**Sessions**:
- London: 02:00 ET
- New York: 09:30 ET
- Duration: 30 minutes default

### Two-Part Strategy

#### Part 1: ORB Breakout
**Conditions**:
- Price breaks OR high/low by 10-30%
- Volume > 120% of 20-period MA
- Within session hours

**Entry**: On breakout confirmation  
**Stop**: Opposite side of OR  
**Target**: 2:1 risk/reward

#### Part 2: Rubber Band Reversal
**Conditions**:
- Active ORB position exists
- Price reverses 50% of breakout move OR
- Price re-enters opening range
- Volume > 150% on reversal

**Actions**:
1. Close original breakout position
2. Enter reversal position
3. Target: Opposite side of OR

### Volume Analysis

```javascript
updateVolume(volume) {
    // Update rolling volume window
    this.state.volumeHistory.push(volume);
    if (this.state.volumeHistory.length > this.params.volumePeriod) {
        this.state.volumeHistory.shift();
    }
    
    // Calculate volume MA using SMACalculator
    this.state.volumeMA = this.volumeSMA.calculate(volume);
    
    // Check volume threshold
    const volumePercent = (volume / this.state.volumeMA) * 100;
    return volumePercent >= this.params.orbVolumeThreshold;
}
```

### Candle Tracking

```javascript
updateCandleCount(timestamp) {
    const candleInterval = this.params.candleIntervalMinutes * 60000;
    const timeSinceOR = timestamp - this.state.openingRange.establishedTime;
    const currentCandle = Math.floor(timeSinceOR / candleInterval);
    
    if (currentCandle > this.state.candleCount) {
        this.state.candleCount = currentCandle;
        this.onNewCandle();
    }
}
```

### Failed Breakout Detection

```javascript
checkRubberBandReversal(price) {
    if (!this.state.orbBreakout.active) return false;
    
    const breakout = this.state.orbBreakout;
    const or = this.state.openingRange;
    
    // Check if within candle window
    if (this.state.candleCount - breakout.breakoutCandle > 
        this.params.rubberBandCandleWindow) {
        return false;
    }
    
    // Check reversal conditions
    if (breakout.direction === 'LONG') {
        // Price back below OR high or 50% reversal
        return price < or.high || 
               price < breakout.entryPrice - 
               (breakout.entryPrice - or.low) * 0.5;
    } else {
        // Price back above OR low or 50% reversal
        return price > or.low || 
               price > breakout.entryPrice + 
               (or.high - breakout.entryPrice) * 0.5;
    }
}
```

---

## Test Time Strategy

**File**: `src/strategies/test/testTimeStrategy.js`  
**Version**: 1.0  
**Purpose**: Infrastructure testing only

### Testing Protocol

Simple time-based strategy for validating trading infrastructure:

1. **Every 5 minutes** (xx:00, xx:05, etc.)
2. **Analyze** previous 1-minute candle
3. **Place trade** in same direction as candle
4. **Hold for 3 minutes** regardless of P&L
5. **Close automatically**

### Key Features

```javascript
params: {
    intervalMinutes: 5,              // Trade every 5 minutes
    tradeDurationMinutes: 3,         // Hold for 3 minutes
    candleLookbackMinutes: 1,        // Previous 1-min candle
    positionSize: 1,                 // Fixed 1 contract
    dollarRiskPerTrade: 50,
    dollarPerPoint: 10,              // MGC specific
}
```

### Testing Validation

```javascript
// Verifies:
// - Signal generation timing
// - Order placement mechanics
// - Position management
// - Automatic position closure
// - Position persistence across restarts
```

---

## Strategy Integration Architecture

### 1. Strategy Initialization Flow

```javascript
// TradingBot.js
async initializeStrategy() {
    const StrategyClass = this.getStrategyClass();
    this.strategy = new StrategyClass(
        this.runtimeConfig.strategyParams,
        this  // Reference to bot for position management
    );
    
    // Strategy receives market data
    this.on('marketData', (data) => {
        const signal = this.strategy.processMarketData(data);
        if (signal) this.handleSignal(signal);
    });
}
```

### 2. Signal Format

All strategies must return signals in this format:

```javascript
{
    action: 'BUY' | 'SELL' | 'CLOSE',
    symbol: 'MGC',
    quantity: 1,
    orderType: 'MARKET' | 'LIMIT',
    price: null,  // For limit orders
    stopLoss: 1850.0,
    takeProfit: 1870.0,
    metadata: {
        strategy: 'PDH_PDL',
        signal: 'BREAKOUT',
        confidence: 0.75,
        timestamp: '2024-01-01T10:00:00Z'
    }
}
```

### 3. Position Management Interface

```javascript
// All strategies can access bot position state
class Strategy {
    constructor(config, mainBot) {
        this.mainBot = mainBot;
    }
    
    hasPosition() {
        return this.mainBot?.state?.currentPosition !== null;
    }
    
    getPosition() {
        return this.mainBot?.state?.currentPosition;
    }
}
```

---

## Risk Management Across Strategies

### Global Risk Parameters

Applied to ALL strategies:

```javascript
// Bot-level risk limits
{
    maxPositions: 1,           // One position at a time
    maxDailyLoss: 500,         // Daily loss limit
    maxDrawdown: 1000,         // Maximum drawdown
    marginRequirement: 50,     // MGC day margin
}
```

### Strategy-Specific Risk

Each strategy implements its own risk calculation:

| Strategy | Stop Loss Method | Position Sizing | Risk per Trade |
|----------|-----------------|-----------------|----------------|
| **PDH/PDL** | Fixed ticks (6-12) | Dollar risk based | $100 |
| **EMA** | Dynamic (1.5x EMA distance) | Fixed 1 contract | $50 |
| **ORB** | OR opposite side | Dollar risk based | $100 |
| **Test** | Fixed 5 points | Fixed 1 contract | $50 |

### Risk Validation Flow

```
Strategy Signal → Bot Risk Check → Aggregator Risk Check → Execution
                      ↓                    ↓
                   Reject               Queue/Reject
```

---

## Performance Metrics & Backtesting

### Expected Performance by Strategy

#### PDH/PDL Strategy
- **Win Rate**: 60-70%
- **Daily Trades**: 6-12
- **Average Win**: $150
- **Average Loss**: $100
- **Profit Factor**: 1.5-2.1

#### EMA 9 Retracement
- **Win Rate**: 52.4%
- **Daily Trades**: 100-140
- **Average Win**: $30
- **Average Loss**: $30
- **Profit Factor**: 1.1-1.3

#### ORB Rubber Band
- **Win Rate**: 55-60%
- **Daily Trades**: 4-8
- **Average Win**: $200
- **Average Loss**: $100
- **Profit Factor**: 1.4-1.8

### Performance Tracking

```javascript
// Each strategy tracks its own metrics
stats: {
    signalsGenerated: 0,
    signalsExecuted: 0,
    winCount: 0,
    lossCount: 0,
    totalPnL: 0,
    maxDrawdown: 0,
    consecutiveWins: 0,
    consecutiveLosses: 0
}
```

### Backtesting Framework

```javascript
// Run historical data through strategy
async backtest(strategy, historicalData) {
    const results = [];
    
    for (const candle of historicalData) {
        const signal = strategy.processMarketData(
            candle.close,
            candle.volume,
            candle.timestamp
        );
        
        if (signal) {
            results.push(simulateTrade(signal, candle));
        }
    }
    
    return calculateMetrics(results);
}
```

---

## Strategy Selection Guidelines

### Market Conditions

| Market Type | Recommended Strategy | Reason |
|------------|---------------------|---------|
| **Trending** | PDH/PDL Breakout | Momentum continuation |
| **Ranging** | PDH/PDL Fade, EMA | Mean reversion |
| **Opening** | ORB | Volatility capture |
| **Choppy** | EMA Scalping | Quick in/out |
| **Low Volume** | None | Wait for liquidity |

### Time of Day Optimization

```
London Open (2:00-4:00 ET):
  - ORB Strategy (London session)
  
London/NY Overlap (8:30-10:30 ET):
  - PDH/PDL Breakout
  - ORB Strategy (NY session)
  
NY Morning (9:30-11:30 ET):
  - All strategies active
  
NY Afternoon (14:00-15:00 ET):
  - PDH/PDL Fade
  - EMA Scalping
```

### Risk Tolerance

- **Conservative**: ORB only (4-8 trades/day)
- **Moderate**: PDH/PDL + ORB (10-20 trades/day)
- **Aggressive**: All strategies (150+ trades/day)

---

## Conclusion

The TSX Trading Bot V5 implements a comprehensive suite of trading strategies, each optimized for specific market conditions. The modular architecture allows for:

1. **Easy strategy addition**: Implement interface, add to factory
2. **Independent operation**: Each strategy maintains own state
3. **Risk isolation**: Bot and aggregator level controls
4. **Performance tracking**: Individual strategy metrics
5. **Real-time adaptation**: Market condition awareness

The system is production-ready with appropriate safeguards for real-money trading while maintaining flexibility for strategy development and optimization.