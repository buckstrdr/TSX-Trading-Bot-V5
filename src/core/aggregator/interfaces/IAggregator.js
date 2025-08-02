/**
 * IAggregator - Interface definition for trading aggregator implementations
 * Defines the contract for order aggregation and processing
 */

class IAggregator {
    /**
     * Initialize the aggregator
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        throw new Error('initialize() must be implemented');
    }
    
    /**
     * Submit an order for processing
     * @param {Object} order - Order to process
     * @returns {Promise<Object>} Submission result
     */
    async submitOrder(order) {
        throw new Error('submitOrder() must be implemented');
    }
    
    /**
     * Process a fill event
     * @param {Object} fill - Fill information
     * @returns {Promise<void>}
     */
    async processFill(fill) {
        throw new Error('processFill() must be implemented');
    }
    
    /**
     * Get aggregator metrics
     * @returns {Object} Current metrics
     */
    getMetrics() {
        throw new Error('getMetrics() must be implemented');
    }
    
    /**
     * Get aggregator status
     * @returns {Object} Current status
     */
    getStatus() {
        throw new Error('getStatus() must be implemented');
    }
    
    /**
     * Shutdown the aggregator
     * @returns {Promise<void>}
     */
    async shutdown() {
        throw new Error('shutdown() must be implemented');
    }
}

module.exports = IAggregator;