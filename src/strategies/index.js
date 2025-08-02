/**
 * Strategy exports for TSX Trading Bot V4
 * Exports the two main strategies: ORB+Rubber Band and EMA
 */

// Import strategies
const ORBRubberBandStrategy = require('./orb-rubber-band/ORBRubberBandStrategy');
const EMAStrategy = require('./ema/emaStrategy');

// Strategy factory
const strategies = {
    ORB_RUBBER_BAND: ORBRubberBandStrategy,
    EMA_CROSS: EMAStrategy
};

/**
 * Create a strategy instance
 * @param {string} type - Strategy type (ORB_RUBBER_BAND or EMA_CROSS)
 * @param {Object} config - Strategy configuration
 * @param {Object} mainBot - Reference to main bot for position management
 * @returns {Object} Strategy instance
 */
function createStrategy(type, config, mainBot) {
    const StrategyClass = strategies[type];
    
    if (!StrategyClass) {
        throw new Error(`Unknown strategy type: ${type}`);
    }
    
    return new StrategyClass(config, mainBot);
}

module.exports = {
    ORBRubberBandStrategy,
    EMAStrategy,
    createStrategy,
    availableStrategies: Object.keys(strategies)
};