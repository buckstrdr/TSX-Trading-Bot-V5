/**
 * IOrderSource - Interface for order sources (bots, manual trading, etc.)
 * Defines how different sources should interact with the aggregator
 */

class IOrderSource {
    /**
     * Get source identifier
     * @returns {string} Unique source ID
     */
    getSourceId() {
        throw new Error('getSourceId() must be implemented');
    }
    
    /**
     * Get source type
     * @returns {string} Source type (BOT, MANUAL, API, etc.)
     */
    getSourceType() {
        throw new Error('getSourceType() must be implemented');
    }
    
    /**
     * Get source configuration
     * @returns {Object} Source configuration
     */
    getConfiguration() {
        throw new Error('getConfiguration() must be implemented');
    }
    
    /**
     * Validate order before submission
     * @param {Object} order - Order to validate
     * @returns {Object} Validation result
     */
    validateOrder(order) {
        throw new Error('validateOrder() must be implemented');
    }
    
    /**
     * Handle order acknowledgment from aggregator
     * @param {Object} acknowledgment - Order acknowledgment
     * @returns {void}
     */
    handleOrderAck(acknowledgment) {
        throw new Error('handleOrderAck() must be implemented');
    }
    
    /**
     * Handle order rejection from aggregator
     * @param {Object} rejection - Order rejection
     * @returns {void}
     */
    handleOrderRejection(rejection) {
        throw new Error('handleOrderRejection() must be implemented');
    }
    
    /**
     * Handle fill notification
     * @param {Object} fill - Fill information
     * @returns {void}
     */
    handleFill(fill) {
        throw new Error('handleFill() must be implemented');
    }
    
    /**
     * Get source statistics
     * @returns {Object} Source performance statistics
     */
    getStatistics() {
        throw new Error('getStatistics() must be implemented');
    }
}

module.exports = IOrderSource;