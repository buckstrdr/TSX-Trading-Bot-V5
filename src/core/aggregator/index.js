/**
 * Trading Aggregator - Main Export Module
 * Provides unified access to all aggregator components
 */

// Core components
const TradingAggregator = require('./TradingAggregator');
const RiskManager = require('./core/RiskManager');
const QueueManager = require('./core/QueueManager');
const SLTPCalculator = require('./core/SLTPCalculator');
const BotRegistry = require('./core/BotRegistry');

// Adapters
const ConnectionManagerAdapter = require('./adapters/ConnectionManagerAdapter');
const RedisAdapter = require('./adapters/RedisAdapter');

// Interfaces
const IAggregator = require('./interfaces/IAggregator');
const IOrderSource = require('./interfaces/IOrderSource');

// Utilities and Examples
const AggregatorTester = require('./utils/AggregatorTester');
const ManualTradingIntegration = require('./examples/ManualTradingIntegration');

// Factory function for easy initialization
function createAggregator(config = {}) {
    return new TradingAggregator(config);
}

// Factory function for manual trading integration
function createManualTradingIntegration(config = {}) {
    return new ManualTradingIntegration(config);
}

// Factory function for testing
function createTester(config = {}) {
    return new AggregatorTester(config);
}

module.exports = {
    // Main aggregator
    TradingAggregator,
    createAggregator,
    
    // Core components
    RiskManager,
    QueueManager,
    SLTPCalculator,
    BotRegistry,
    
    // Adapters
    ConnectionManagerAdapter,
    RedisAdapter,
    
    // Interfaces
    IAggregator,
    IOrderSource,
    
    // Utilities and Examples
    AggregatorTester,
    ManualTradingIntegration,
    createTester,
    createManualTradingIntegration,
    
    // Version info
    version: '1.0.0',
    shadowModeSupported: true
};