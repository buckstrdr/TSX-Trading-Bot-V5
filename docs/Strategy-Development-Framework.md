# TSX Trading Bot V5 - Strategy Development Framework

**The Complete Strategy Developer's Guide**

**Version:** 2.0  
**Last Updated:** January 19, 2025  
**Status:** Production Ready  

---

## 📖 Table of Contents

1. [Overview](#overview)
2. [Strategy Architecture](#strategy-architecture)
3. [Required Interface](#required-interface)
4. [Communication Protocols](#communication-protocols)
5. [Market Data Integration](#market-data-integration)
6. [Signal Generation Standards](#signal-generation-standards)
7. [State Management](#state-management)
8. [Risk Management Integration](#risk-management-integration)
9. [Configuration Integration](#configuration-integration)
10. [Bot Communication](#bot-communication)
11. [Copy-Paste Templates](#copy-paste-templates)
12. [Testing Guidelines](#testing-guidelines)
13. [Performance Optimization](#performance-optimization)
14. [Error Handling](#error-handling)
15. [Debugging and Logging](#debugging-and-logging)

---

## Overview

This framework provides everything needed to develop production-ready trading strategies for the TSX Trading Bot V5. Each strategy is a self-contained module that processes market data and generates trading signals while integrating seamlessly with the bot's infrastructure.

### Strategy Communication Flow

```
Market Data → Strategy.processMarketData() → Signal → TradingBot → AggregatorClient → Connection Manager → TopStepX API
```

### Existing Strategy Examples

- **TEST_TIME** (`src/strategies/test/testTimeStrategy.js`) - Time-based testing strategy
- **EMA** (`src/strategies/ema/emaStrategy.js`) - EMA retracement scalping with state machine
- **ORB** (`src/strategies/orb-rubber-band/ORBRubberBandStrategy.js`) - Opening range breakout strategy

---

## Strategy Architecture

### Core Principles

1. **Single Responsibility** - Each strategy focuses on one specific trading approach
2. **Stateless Signals** - Strategies generate signals; TradingBot manages positions
3. **Configuration Driven** - All parameters come from YAML configuration files
4. **Bot Integration** - Strategies integrate with bot modules via mainBot reference
5. **Error Resilience** - Strategies handle errors gracefully and maintain state

### File Structure

```
src/strategies/
├── your-strategy/
│   ├── YourStrategy.js           # Main strategy class
│   ├── YourStrategySignalGenerator.js  # Optional: Signal generation logic
│   └── helpers/                  # Optional: Strategy-specific utilities
├── index.js                      # Strategy registry
└── README.md                     # Strategy documentation
```

---

## Required Interface

Every strategy MUST implement this interface:

### Essential Methods

```javascript
class YourStrategy {
    constructor(config = {}, mainBot = null) {
        // Initialize strategy with config and bot reference
    }

    processMarketData(price, volume = 1000, timestamp = null) {
        // Process real-time market data
        // Returns: { ready, signal, environment, debug }
    }

    isStrategyReady() {
        // Returns: boolean - whether strategy is ready to trade
    }

    getStatusSummary() {
        // Returns: Object with module status for UI display
    }

    reset() {
        // Reset strategy state (called on bot restart)
    }
}
```

### Optional Methods

```javascript
class YourStrategy {
    onPositionClosed(timestamp, wasProfit) {
        // Called when bot closes a position
    }

    getParameters() {
        // Returns: strategy parameters for debugging
    }

    getDebugInfo() {
        // Returns: detailed debug information
    }
}
```

### Required Properties

```javascript
this.name = 'YOUR_STRATEGY_NAME';
this.version = '1.0';
this.mainBot = mainBot; // CRITICAL: Store bot reference
```

---

## Communication Protocols

### TradingBot Integration

```javascript
// Access bot modules through mainBot reference
if (this.mainBot && this.mainBot.modules) {
    // Position management
    const positions = this.mainBot.modules.positionManagement.getAllPositions();
    
    // Health monitoring (for quiet mode)
    const quietStatus = this.mainBot.modules.healthMonitoring.getQuietModeStatus();
    
    // Keyboard interface (check for prompts)
    const promptState = this.mainBot.modules.keyboardInterface.getPromptState();
    
    // Manual trading state
    const awaitingConfirmation = this.mainBot.modules.manualTrading.awaitingConfirmation;
}
```

### AggregatorClient Communication

The strategy doesn't communicate directly with AggregatorClient. Instead:

1. Strategy generates signals in `processMarketData()`
2. TradingBot receives signals and forwards to AggregatorClient
3. AggregatorClient handles Redis communication and order management

### Connection Manager Integration

Connection Manager receives orders from AggregatorClient and:
1. Forwards to TopStepX API
2. Publishes position updates via Redis
3. Handles API authentication and error recovery

---

## Market Data Integration

### processMarketData() Implementation

```javascript
processMarketData(price, volume = 1000, timestamp = null) {
    if (!timestamp) timestamp = new Date();
    
    // 1. Update internal candle data
    this.updateCandle(price, volume, timestamp);
    
    // 2. Check if strategy is ready
    if (!this.isStrategyReady()) {
        return {
            ready: false,
            signal: null,
            debug: { reason: 'Strategy not ready' }
        };
    }
    
    // 3. Process your strategy logic here
    const signal = this.generateSignal(price, timestamp);
    
    // 4. Return standardized response
    return {
        ready: true,
        signal: signal,
        environment: this.analyzeMarketEnvironment(price),
        debug: { reason: signal ? 'Signal generated' : 'Monitoring' }
    };
}
```

### Candle Data Management

```javascript
updateCandle(price, volume, timestamp) {
    const candleTime = new Date(timestamp);
    candleTime.setSeconds(0, 0); // Round to minute
    const candleTimeMs = candleTime.getTime();
    
    // Start new candle if time changed
    if (!this.lastCandleTime || candleTimeMs !== this.lastCandleTime) {
        // Close previous candle
        if (this.currentCandle && this.currentCandle.close !== null) {
            this.candles.push({ ...this.currentCandle });
            
            // Keep only last 200 candles for memory management
            if (this.candles.length > 200) {
                this.candles = this.candles.slice(-200);
            }
        }
        
        // Start new candle
        this.currentCandle = {
            timestamp: candleTimeMs,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: volume
        };
        this.lastCandleTime = candleTimeMs;
        
        return true; // Candle changed
    } else {
        // Update current candle
        this.currentCandle.high = Math.max(this.currentCandle.high, price);
        this.currentCandle.low = Math.min(this.currentCandle.low, price);
        this.currentCandle.close = price;
        this.currentCandle.volume += volume;
        
        return false; // Same candle
    }
}
```

---

## Signal Generation Standards

### Standard Signal Format

```javascript
const signal = {
    // REQUIRED CORE PROPERTIES
    direction: 'LONG' | 'SHORT' | 'CLOSE_POSITION',
    confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'TEST',
    entryPrice: 3380.50,
    stopLoss: 3375.00,
    takeProfit: 3390.00,
    instrument: 'MGC', // Set for aggregator routing
    
    // REQUIRED RISK METRICS
    riskPoints: 5.50,
    rewardPoints: 9.50,
    riskRewardRatio: 1.73,
    
    // REQUIRED POSITION SIZING
    positionSize: 1,
    dollarRisk: 55.00,
    dollarReward: 95.00,
    
    // REQUIRED METADATA
    timestamp: Date.now(),
    reason: 'Strategy-specific explanation',
    strategyName: 'YOUR_STRATEGY_NAME',
    strategyVersion: '1.0',
    signalStrength: 1.0, // 0.0 - 1.0
    
    // OPTIONAL EXTENSIONS
    subStrategy: 'VARIANT_NAME',
    environment: environmentData,
    indicators: { /* strategy-specific data */ },
    testData: { /* test-specific data */ }
};
```

### Signal Types

#### Entry Signals (LONG/SHORT)
- Must include all risk metrics
- Position sizing calculated from dollarRiskPerTrade config
- Entry price should be current market price or strategy-specific level

#### Close Position Signals
```javascript
const closeSignal = {
    direction: 'CLOSE_POSITION',
    confidence: 'TEST',
    instrument: 'MGC',
    positionSize: this.params.positionSize,
    reason: 'Strategy-specific close reason',
    timestamp: timestamp,
    strategyName: this.name,
    strategyVersion: this.version,
    closeType: 'full', // 'full' or 'partial'
    testData: {
        closeReason: 'TIME_LIMIT' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL'
    }
};
```

---

## State Management

### Position Persistence

Strategies should save critical state to survive bot restarts:

```javascript
// Position state file path
this.stateFilePath = path.join(__dirname, '..', '..', '..', 
    'data', 'strategy-state', `${this.name}_state.json`);

// Save position state
async savePositionState() {
    try {
        const dir = path.dirname(this.stateFilePath);
        await fs.mkdir(dir, { recursive: true });
        
        const stateData = {
            currentPosition: this.state.currentPosition,
            positionOpenTime: this.state.positionOpenTime ? 
                this.state.positionOpenTime.toISOString() : null,
            lastTradeTime: this.state.lastTradeTime ? 
                this.state.lastTradeTime.toISOString() : null,
            // Add other critical state
            savedAt: new Date().toISOString(),
            version: this.version
        };
        
        await fs.writeFile(this.stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
    } catch (error) {
        console.log(`❌ Failed to save position state: ${error.message}`);
    }
}

// Load position state on startup
async loadPositionState() {
    try {
        const stateContent = await fs.readFile(this.stateFilePath, 'utf8');
        const stateData = JSON.parse(stateContent);
        
        if (stateData.currentPosition) {
            this.state.currentPosition = stateData.currentPosition;
            this.state.positionOpenTime = stateData.positionOpenTime ? 
                new Date(stateData.positionOpenTime) : null;
            // Restore other state
            
            // Verify position still exists with aggregator
            await this.verifyPositionWithAggregator();
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`📂 No existing state file found, starting fresh`);
        } else {
            console.log(`❌ Failed to load position state: ${error.message}`);
        }
    }
}
```

### Position Verification

Check if saved positions still exist in the broker:

```javascript
async verifyPositionWithAggregator() {
    try {
        // Create Redis clients for position verification
        const redis = require('redis');
        const { v4: uuidv4 } = require('uuid');
        
        const publisher = redis.createClient({ host: 'localhost', port: 6379 });
        const subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        const requestId = `pos-verify-${Date.now()}`;
        const responseChannel = 'position-response';
        
        // Set up position verification with timeout
        const positionPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                subscriber.unsubscribe(responseChannel);
                publisher.quit();
                subscriber.quit();
                resolve('TIMEOUT');
            }, 10000);
            
            subscriber.subscribe(responseChannel, async (message) => {
                try {
                    const response = JSON.parse(message);
                    if (response.requestId === requestId) {
                        clearTimeout(timeout);
                        await subscriber.unsubscribe(responseChannel);
                        await publisher.quit();
                        await subscriber.quit();
                        resolve(response);
                    }
                } catch (error) {
                    clearTimeout(timeout);
                    reject(error);
                }
            });
        });
        
        // Send position query request
        const positionRequest = {
            type: 'GET_POSITIONS',
            requestId: requestId,
            accountId: parseInt(this.mainBot.config.accountId || '9627376'),
            responseChannel: responseChannel,
            timestamp: Date.now()
        };
        
        await publisher.publish('aggregator:requests', JSON.stringify(positionRequest));
        
        // Wait for response
        const positionResponse = await positionPromise;
        
        if (positionResponse === 'TIMEOUT') {
            console.log(`⏰ Position verification timed out - maintaining saved position for safety`);
            return;
        }
        
        // Check if we have matching positions
        const positions = positionResponse.positions || [];
        const hasMatchingPosition = positions.some(pos => {
            return pos.instrument === 'MGC' || 
                   pos.contractId?.includes('MGC') || 
                   pos.symbol?.includes('MGC');
        });
        
        if (hasMatchingPosition) {
            console.log(`✅ Position verified with broker: ${this.state.currentPosition} position still active`);
        } else {
            console.log(`⚠️ No matching position found - clearing saved state`);
            this.state.currentPosition = null;
            this.state.positionOpenTime = null;
            await this.savePositionState();
        }
        
    } catch (error) {
        console.log(`❌ Error verifying position: ${error.message}`);
        // Keep position on error - better safe than sorry
    }
}
```

---

## Risk Management Integration

### Position Sizing Calculation

```javascript
calculatePositionSize(riskPoints, direction) {
    // Get risk configuration
    const dollarRisk = this.params.dollarRiskPerTrade;
    const pointValue = this.params.dollarPerPoint;
    
    if (!dollarRisk || dollarRisk <= 0) {
        throw new Error('Invalid risk configuration - dollarRiskPerTrade not set');
    }
    
    if (!pointValue || pointValue <= 0) {
        throw new Error('Invalid contract configuration - dollarPerPoint not set');
    }
    
    // Calculate exact position size
    const exactPositionSize = dollarRisk / (Math.abs(riskPoints) * pointValue);
    
    // Smart rounding - up to 50% over budget allowed
    let positionSize = Math.ceil(exactPositionSize);
    
    // Check if rounding up would exceed 50% over budget
    const roundedUpRisk = positionSize * Math.abs(riskPoints) * pointValue;
    const overRiskPercent = ((roundedUpRisk / dollarRisk - 1) * 100);
    
    if (overRiskPercent > 50) {
        // Too much risk, round down instead
        positionSize = Math.floor(exactPositionSize);
    }
    
    positionSize = Math.max(1, positionSize); // Ensure at least 1 contract
    
    // Calculate actual dollar amounts
    const actualDollarRisk = positionSize * Math.abs(riskPoints) * pointValue;
    const actualDollarReward = positionSize * Math.abs(rewardPoints) * pointValue;
    
    return {
        positionSize,
        actualDollarRisk,
        actualDollarReward,
        exactPositionSize
    };
}
```

### Risk Filters

```javascript
passesRiskFilter(tradeParams) {
    const maxRiskPoints = this.params.maxRiskPoints || 3.0;
    const minRiskPoints = 0.1;
    
    // Check risk point limits
    if (tradeParams.riskPoints > maxRiskPoints) {
        console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts > ${maxRiskPoints} pts max`);
        return false;
    }
    
    if (tradeParams.riskPoints < minRiskPoints) {
        console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts < ${minRiskPoints} pts minimum`);
        return false;
    }
    
    // Check position size limits
    if (tradeParams.positionSize > 10) {
        console.log(`🚫 Risk Filter: Position size ${tradeParams.positionSize} too large (max 10)`);
        return false;
    }
    
    // Check if risk budget exceeded
    const riskBudget = this.params.dollarRiskPerTrade;
    const actualRisk = tradeParams.actualDollarRisk;
    const overRiskPercent = ((actualRisk / riskBudget - 1) * 100);
    
    if (overRiskPercent > 50) {
        console.log(`🚫 Risk Filter: Actual risk ${actualRisk.toFixed(2)} is ${overRiskPercent.toFixed(1)}% over budget`);
        return false;
    }
    
    return true;
}
```

---

## Configuration Integration

### YAML Configuration Structure

```yaml
# config/bots/BOT_YOUR_STRATEGY.yaml
bot:
  name: "BOT_YOUR_STRATEGY"
  strategy: "YourStrategy"
  enabled: true

strategy:
  # Risk Management
  dollarRiskPerTrade: 100
  dollarPerPoint: 10
  maxRiskPoints: 3.0
  riskRewardRatio: 2
  
  # Strategy-Specific Parameters
  yourParameter1: 30
  yourParameter2: true
  yourParameter3: "CONSERVATIVE"
  
  # Optional nested configuration
  indicators:
    period: 20
    threshold: 0.5
    
  # Session configuration
  activeSessions:
    - "LONDON"
    - "NEW_YORK"
```

### Configuration Mapping in Constructor

```javascript
constructor(config = {}, mainBot = null) {
    this.mainBot = mainBot;
    this.name = 'YOUR_STRATEGY_NAME';
    this.version = '1.0';
    
    // Map configuration with defaults
    this.params = {
        // Risk management (required)
        dollarRiskPerTrade: config.dollarRiskPerTrade || 100,
        dollarPerPoint: config.dollarPerPoint || 10,
        maxRiskPoints: config.maxRiskPoints || 3.0,
        riskRewardRatio: config.riskRewardRatio || 2,
        
        // Strategy-specific parameters
        yourParameter1: config.yourParameter1 || 30,
        yourParameter2: config.yourParameter2 !== false, // boolean with default true
        yourParameter3: config.yourParameter3 || 'STANDARD',
        
        // Nested configuration
        indicatorPeriod: config.indicators?.period || 20,
        indicatorThreshold: config.indicators?.threshold || 0.5,
        
        // Position management
        oneTradeAtTime: config.oneTradeAtTime !== false,
        maxTradeDurationMs: (config.maxTradeDurationMinutes || 480) * 60 * 1000,
        
        // Signal settings
        signalCooldownMs: config.signalCooldownMs || 300000 // 5 minutes
    };
    
    console.log(`📊 ${this.name} v${this.version} initialized`);
    console.log(`💰 Risk per trade: ${this.params.dollarRiskPerTrade}`);
    console.log(`🎯 Risk:Reward: 1:${this.params.riskRewardRatio}`);
}
```

---

## Bot Communication

### Quiet Mode Integration

Respect bot's quiet mode during prompts or manual operations:

```javascript
isQuietModeActive() {
    try {
        // Check health monitoring manager's quiet mode status
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.healthMonitoring) {
            const quietStatus = this.mainBot.modules.healthMonitoring.getQuietModeStatus();
            if (quietStatus.currentlyQuiet) {
                return true;
            }
        }
        
        // Check keyboard interface prompt state
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.keyboardInterface) {
            const promptState = this.mainBot.modules.keyboardInterface.getPromptState();
            if (promptState.isPromptActive) {
                return true;
            }
        }
        
        // Check manual trading awaiting confirmation
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.manualTrading) {
            if (this.mainBot.modules.manualTrading.awaitingConfirmation) {
                return true;
            }
        }
        
        return false;
    } catch (error) {
        return false; // Default to verbose if error occurs
    }
}

// Use in logging
if (!this.isQuietModeActive()) {
    console.log('📊 Strategy logging message');
}
```

### Position Management Integration

Check for existing positions before generating signals:

```javascript
generateSignal(price, timestamp) {
    // Check for existing positions
    if (this.mainBot && this.mainBot.modules && this.mainBot.modules.positionManagement) {
        const positions = this.mainBot.modules.positionManagement.getAllPositions();
        if (positions && positions.length > 0) {
            // Only log occasionally to avoid spam
            if (!this.lastPositionBlockLog || Date.now() - this.lastPositionBlockLog > 30000) {
                console.log('🚫 Signal generation blocked - position already exists');
                this.lastPositionBlockLog = Date.now();
            }
            return null;
        }
    }
    
    // Generate signal logic here...
}
```

### UI Status Integration

Provide status for UI display:

```javascript
getStatusSummary() {
    return {
        module: 'Strategy',
        status: this.isStrategyReady() ? 'READY' : 'INITIALIZING',
        name: this.name,
        version: this.version,
        strategyType: 'YOUR_STRATEGY_TYPE',
        isReady: this.isStrategyReady(),
        debug: {
            // Add strategy-specific debug info
            parameter1: this.params.yourParameter1,
            lastSignalTime: this.lastSignalTime,
            positionCount: this.state.currentPosition ? 1 : 0
        }
    };
}
```

---

## Copy-Paste Templates

### Basic Strategy Template

```javascript
const fs = require('fs').promises;
const path = require('path');

class YourStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'YOUR_STRATEGY_NAME';
        this.version = '1.0';
        this.mainBot = mainBot;
        
        // Strategy parameters with defaults
        this.params = {
            // Risk management (required)
            dollarRiskPerTrade: config.dollarRiskPerTrade || 100,
            dollarPerPoint: config.dollarPerPoint || 10,
            maxRiskPoints: config.maxRiskPoints || 3.0,
            riskRewardRatio: config.riskRewardRatio || 2,
            
            // Strategy-specific parameters
            yourParameter1: config.yourParameter1 || 30,
            yourParameter2: config.yourParameter2 || 'STANDARD'
        };
        
        // State tracking
        this.state = {
            currentPosition: null,
            lastSignalTime: null,
            isReady: false
        };
        
        // Market data tracking
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        console.log(`📊 ${this.name} v${this.version} initialized`);
        console.log(`💰 Risk per trade: ${this.params.dollarRiskPerTrade}`);
    }
    
    processMarketData(price, volume = 1000, timestamp = null) {
        if (!timestamp) timestamp = new Date();
        
        // Update candle data
        this.updateCandle(price, volume, timestamp);
        
        // Check if ready
        if (!this.isStrategyReady()) {
            return {
                ready: false,
                signal: null,
                debug: { reason: 'Strategy not ready' }
            };
        }
        
        // Your strategy logic here
        const signal = this.generateSignal(price, timestamp);
        
        return {
            ready: true,
            signal: signal,
            environment: this.analyzeMarketEnvironment(price),
            debug: { reason: signal ? 'Signal generated' : 'Monitoring' }
        };
    }
    
    generateSignal(price, timestamp) {
        // Check for existing positions
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.positionManagement) {
            const positions = this.mainBot.modules.positionManagement.getAllPositions();
            if (positions && positions.length > 0) {
                return null;
            }
        }
        
        // Your signal generation logic here
        // Return null if no signal, or signal object if signal generated
        
        return null;
    }
    
    updateCandle(price, volume, timestamp) {
        const candleTime = new Date(timestamp);
        candleTime.setSeconds(0, 0);
        const candleTimeMs = candleTime.getTime();
        
        if (!this.lastCandleTime || candleTimeMs !== this.lastCandleTime) {
            if (this.currentCandle && this.currentCandle.close !== null) {
                this.candles.push({ ...this.currentCandle });
                if (this.candles.length > 200) {
                    this.candles = this.candles.slice(-200);
                }
            }
            
            this.currentCandle = {
                timestamp: candleTimeMs,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume
            };
            this.lastCandleTime = candleTimeMs;
            return true;
        } else {
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
            this.currentCandle.volume += volume;
            return false;
        }
    }
    
    analyzeMarketEnvironment(price) {
        return {
            currentTime: new Date(),
            price: price,
            trend: 'NEUTRAL' // Your trend analysis here
        };
    }
    
    isStrategyReady() {
        // Your readiness logic here
        if (!this.state.isReady) {
            this.state.isReady = true;
            console.log('🎯 Strategy now READY');
        }
        return this.state.isReady;
    }
    
    getStatusSummary() {
        return {
            module: 'Strategy',
            status: this.isStrategyReady() ? 'READY' : 'INITIALIZING',
            name: this.name,
            version: this.version,
            strategyType: 'YOUR_STRATEGY_TYPE',
            isReady: this.isStrategyReady(),
            debug: {
                lastSignalTime: this.state.lastSignalTime,
                candleCount: this.candles.length
            }
        };
    }
    
    reset() {
        this.state = {
            currentPosition: null,
            lastSignalTime: null,
            isReady: false
        };
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        console.log('🔄 Strategy reset complete');
    }
}

module.exports = YourStrategy;
```

### Signal Generation Template

```javascript
createSignal(direction, entryPrice, stopLoss, takeProfit, reason) {
    // Calculate risk metrics
    const riskPoints = Math.abs(entryPrice - stopLoss);
    const rewardPoints = Math.abs(takeProfit - entryPrice);
    const riskRewardRatio = rewardPoints / riskPoints;
    
    // Calculate position sizing
    const positionSizing = this.calculatePositionSize(riskPoints, direction);
    
    // Apply risk filter
    if (!this.passesRiskFilter({ riskPoints, positionSize: positionSizing.positionSize })) {
        return null;
    }
    
    const signal = {
        // Core signal properties
        direction: direction,
        confidence: 'HIGH',
        entryPrice: entryPrice,
        stopLoss: stopLoss,
        takeProfit: takeProfit,
        instrument: 'MGC',
        
        // Risk metrics
        riskPoints: riskPoints,
        rewardPoints: rewardPoints,
        riskRewardRatio: riskRewardRatio,
        
        // Position sizing
        positionSize: positionSizing.positionSize,
        dollarRisk: positionSizing.actualDollarRisk,
        dollarReward: positionSizing.actualDollarReward,
        
        // Metadata
        timestamp: Date.now(),
        reason: reason,
        strategyName: this.name,
        strategyVersion: this.version,
        signalStrength: 1.0,
        
        // Strategy-specific data
        indicators: {
            // Add your indicator values here
        }
    };
    
    // Log signal generation
    console.log(`🎯 ${this.name} ${direction} signal generated`);
    console.log(`   Entry: ${entryPrice.toFixed(2)}`);
    console.log(`   Stop: ${stopLoss.toFixed(2)}`);
    console.log(`   Target: ${takeProfit.toFixed(2)}`);
    console.log(`   Risk: ${riskPoints.toFixed(2)} pts`);
    console.log(`   Position: ${positionSizing.positionSize} contracts`);
    
    return signal;
}
```

---

## Testing Guidelines

### Unit Testing Structure

```javascript
// tests/strategies/YourStrategy.test.js
const YourStrategy = require('../../src/strategies/your-strategy/YourStrategy');

describe('YourStrategy', () => {
    let strategy;
    let mockBot;
    
    beforeEach(() => {
        mockBot = {
            config: { accountId: '9627376' },
            modules: {
                positionManagement: {
                    getAllPositions: () => []
                },
                healthMonitoring: {
                    getQuietModeStatus: () => ({ currentlyQuiet: false })
                }
            }
        };
        
        strategy = new YourStrategy({
            dollarRiskPerTrade: 100,
            dollarPerPoint: 10,
            maxRiskPoints: 3.0
        }, mockBot);
    });
    
    test('should initialize with correct parameters', () => {
        expect(strategy.name).toBe('YOUR_STRATEGY_NAME');
        expect(strategy.version).toBe('1.0');
        expect(strategy.params.dollarRiskPerTrade).toBe(100);
    });
    
    test('should process market data correctly', () => {
        const result = strategy.processMarketData(3380.50, 1000);
        
        expect(result).toHaveProperty('ready');
        expect(result).toHaveProperty('signal');
        expect(result).toHaveProperty('debug');
    });
    
    test('should generate valid signals', () => {
        // Setup test conditions
        strategy.state.isReady = true;
        
        // Process market data to trigger signal
        const result = strategy.processMarketData(3380.50, 1000);
        
        if (result.signal) {
            expect(result.signal).toHaveProperty('direction');
            expect(result.signal).toHaveProperty('entryPrice');
            expect(result.signal).toHaveProperty('stopLoss');
            expect(result.signal).toHaveProperty('takeProfit');
            expect(result.signal).toHaveProperty('positionSize');
        }
    });
    
    test('should respect existing positions', () => {
        // Mock existing position
        mockBot.modules.positionManagement.getAllPositions = () => [
            { instrument: 'MGC', size: 1 }
        ];
        
        strategy.state.isReady = true;
        const result = strategy.processMarketData(3380.50, 1000);
        
        expect(result.signal).toBeNull();
    });
});
```

### Integration Testing

```javascript
// tests/integration/StrategyIntegration.test.js
const TradingBot = require('../../src/core/trading/TradingBot');
const YourStrategy = require('../../src/strategies/your-strategy/YourStrategy');

describe('Strategy Integration', () => {
    let bot;
    
    beforeEach(async () => {
        const config = {
            strategy: 'YourStrategy',
            dollarRiskPerTrade: 100,
            dollarPerPoint: 10
        };
        
        bot = new TradingBot(config);
        await bot.initialize();
    });
    
    afterEach(async () => {
        await bot.shutdown();
    });
    
    test('should integrate with trading bot', async () => {
        // Send market data
        await bot.processMarketData(3380.50, 1000);
        
        // Check bot state
        const status = bot.getStatusSummary();
        expect(status.modules.strategy.status).toBe('READY');
    });
});
```

### Manual Testing Checklist

1. **Configuration Loading**
   - [ ] Strategy loads parameters from YAML config
   - [ ] Default values are applied correctly
   - [ ] Invalid configurations are handled gracefully

2. **Market Data Processing**
   - [ ] Strategy processes real-time price updates
   - [ ] Candle data is built correctly
   - [ ] Memory usage remains stable over time

3. **Signal Generation**
   - [ ] Signals are generated when conditions are met
   - [ ] Signal format matches standard specification
   - [ ] Risk calculations are accurate

4. **Position Management**
   - [ ] Strategy respects existing positions
   - [ ] Position state is saved and restored correctly
   - [ ] Position verification works with aggregator

5. **Bot Integration**
   - [ ] Strategy integrates with TradingBot
   - [ ] UI displays strategy status correctly
   - [ ] Quiet mode is respected during prompts

6. **Error Handling**
   - [ ] Strategy handles invalid market data
   - [ ] Network errors don't crash strategy
   - [ ] State corruption is detected and handled

---

## Performance Optimization

### Memory Management

```javascript
// Keep limited candle history
if (this.candles.length > 200) {
    this.candles = this.candles.slice(-200);
}

// Clear old state data periodically
if (this.stateHistory.length > 50) {
    this.stateHistory = this.stateHistory.slice(-50);
}
```

### Logging Optimization

```javascript
// Reduce logging frequency during high-frequency updates
if (!this.isQuietModeActive() && this.logCount % 100 === 0) {
    console.log('📊 Periodic status update');
}
this.logCount++;

// Use conditional logging for non-critical information
if (this.params.verboseLogging) {
    console.log('🔍 Detailed debug information');
}
```

### CPU Optimization

```javascript
// Cache expensive calculations
if (!this.cachedCalculation || this.lastCacheTime < timestamp - 60000) {
    this.cachedCalculation = this.expensiveCalculation();
    this.lastCacheTime = timestamp;
}

// Batch operations when possible
if (this.pendingOperations.length >= 10) {
    this.processBatchOperations();
}
```

---

## Error Handling

### Graceful Error Recovery

```javascript
processMarketData(price, volume = 1000, timestamp = null) {
    try {
        // Validate inputs
        if (price === null || price === undefined || isNaN(price)) {
            console.log('🚨 Invalid price data, skipping');
            return {
                ready: false,
                signal: null,
                debug: { reason: 'Invalid price data' }
            };
        }
        
        // Main processing logic
        return this.processMarketDataInternal(price, volume, timestamp);
        
    } catch (error) {
        console.log(`❌ Error in processMarketData: ${error.message}`);
        
        // Return safe default response
        return {
            ready: false,
            signal: null,
            debug: { 
                reason: 'Processing error',
                error: error.message 
            }
        };
    }
}
```

### Configuration Validation

```javascript
validateConfiguration(config) {
    const errors = [];
    
    // Required parameters
    if (!config.dollarRiskPerTrade || config.dollarRiskPerTrade <= 0) {
        errors.push('dollarRiskPerTrade must be a positive number');
    }
    
    if (!config.dollarPerPoint || config.dollarPerPoint <= 0) {
        errors.push('dollarPerPoint must be a positive number');
    }
    
    // Parameter ranges
    if (config.maxRiskPoints && config.maxRiskPoints > 10) {
        errors.push('maxRiskPoints should not exceed 10');
    }
    
    if (errors.length > 0) {
        throw new Error(`Configuration errors: ${errors.join(', ')}`);
    }
}
```

### Network Error Handling

```javascript
async verifyPositionWithTimeout() {
    try {
        const result = await Promise.race([
            this.verifyPositionWithAggregator(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 10000)
            )
        ]);
        return result;
    } catch (error) {
        if (error.message === 'Timeout') {
            console.log('⏰ Position verification timed out - keeping saved state');
        } else {
            console.log(`❌ Position verification error: ${error.message}`);
        }
        // Don't clear position on error - better safe than sorry
        return null;
    }
}
```

---

## Debugging and Logging

### Structured Logging

```javascript
log(level, message, data = {}) {
    if (this.isQuietModeActive() && level !== 'ERROR') {
        return;
    }
    
    const timestamp = new Date().toISOString();
    const prefix = this.params.logPrefix || `[${this.name}]`;
    
    const logEntry = {
        timestamp,
        level,
        strategy: this.name,
        version: this.version,
        message,
        data
    };
    
    switch (level) {
        case 'ERROR':
            console.error(`❌ ${prefix} ${message}`, data);
            break;
        case 'WARN':
            console.warn(`⚠️ ${prefix} ${message}`, data);
            break;
        case 'INFO':
            console.log(`ℹ️ ${prefix} ${message}`, data);
            break;
        case 'DEBUG':
            if (this.params.enableDebugLogging) {
                console.log(`🔍 ${prefix} ${message}`, data);
            }
            break;
        default:
            console.log(`${prefix} ${message}`, data);
    }
    
    // Optionally save to file
    if (this.params.enableFileLogging) {
        this.saveLogEntry(logEntry);
    }
}

// Usage
this.log('INFO', 'Signal generated', { direction: 'LONG', price: 3380.50 });
this.log('ERROR', 'Configuration error', { error: error.message });
this.log('DEBUG', 'State update', { oldState: 'NEUTRAL', newState: 'LONG_SETUP' });
```

### Debug Information Export

```javascript
getDebugInfo() {
    return {
        strategy: {
            name: this.name,
            version: this.version,
            isReady: this.isStrategyReady(),
            uptime: Date.now() - this.initializationTime
        },
        parameters: { ...this.params },
        state: {
            currentPosition: this.state.currentPosition,
            lastSignalTime: this.state.lastSignalTime,
            candles: this.candles.length,
            lastCandle: this.candles.length > 0 ? 
                this.candles[this.candles.length - 1] : null
        },
        performance: {
            signalsGenerated: this.signalCount || 0,
            lastProcessingTime: this.lastProcessingTime,
            averageProcessingTime: this.averageProcessingTime
        }
    };
}
```

### Performance Monitoring

```javascript
processMarketDataWithTiming(price, volume, timestamp) {
    const startTime = Date.now();
    
    try {
        const result = this.processMarketData(price, volume, timestamp);
        
        // Track performance
        const processingTime = Date.now() - startTime;
        this.updatePerformanceMetrics(processingTime);
        
        return result;
    } catch (error) {
        const processingTime = Date.now() - startTime;
        this.log('ERROR', 'Processing error', { 
            error: error.message, 
            processingTime 
        });
        throw error;
    }
}

updatePerformanceMetrics(processingTime) {
    this.processingTimes = this.processingTimes || [];
    this.processingTimes.push(processingTime);
    
    // Keep only last 1000 measurements
    if (this.processingTimes.length > 1000) {
        this.processingTimes = this.processingTimes.slice(-1000);
    }
    
    // Calculate average
    this.averageProcessingTime = this.processingTimes.reduce((a, b) => a + b, 0) / 
        this.processingTimes.length;
    
    // Log slow processing
    if (processingTime > 100) {
        this.log('WARN', 'Slow processing detected', { 
            processingTime, 
            average: this.averageProcessingTime.toFixed(2) 
        });
    }
}
```

---

## Final Notes

### Strategy Registration

Add your strategy to the strategy index:

```javascript
// src/strategies/index.js
const YourStrategy = require('./your-strategy/YourStrategy');

module.exports = {
    TestTimeStrategy: require('./test/testTimeStrategy'),
    EMAStrategy: require('./ema/emaStrategy'),
    ORBRubberBandStrategy: require('./orb-rubber-band/ORBRubberBandStrategy'),
    YourStrategy: YourStrategy  // Add your strategy here
};
```

### Bot Configuration

Create a bot configuration file:

```yaml
# config/bots/BOT_YOUR_STRATEGY.yaml
bot:
  name: "BOT_YOUR_STRATEGY"
  strategy: "YourStrategy"
  enabled: true
  port: 3010

strategy:
  dollarRiskPerTrade: 100
  dollarPerPoint: 10
  maxRiskPoints: 3.0
  riskRewardRatio: 2
  yourParameter1: 30
  yourParameter2: "CONSERVATIVE"
```

### Production Deployment

1. **Test thoroughly** with practice account
2. **Verify position management** works correctly  
3. **Monitor memory usage** over extended periods
4. **Test error recovery** scenarios
5. **Validate risk calculations** with small positions
6. **Monitor logs** for any unexpected behavior

### Common Pitfalls to Avoid

- ❌ Not storing `mainBot` reference in constructor
- ❌ Generating signals when positions already exist
- ❌ Missing required signal properties
- ❌ Not handling invalid market data
- ❌ Excessive logging during quiet mode
- ❌ Not implementing proper state persistence
- ❌ Hardcoding configuration values
- ❌ Not validating risk calculations

---

**This framework ensures your strategy integrates seamlessly with the TSX Trading Bot V5 infrastructure while maintaining professional standards for production trading.**

**Happy Trading! 🚀**