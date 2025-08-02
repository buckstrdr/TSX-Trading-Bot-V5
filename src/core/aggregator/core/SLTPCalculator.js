/**
 * SLTPCalculator - Calculates and manages stop loss and take profit levels
 * Based on actual fill prices, not order prices
 * 
 * NOTE: This is primarily for fallback scenarios. Most trading bots manage
 * their own SL/TP strategies and don't rely on aggregator calculations.
 */

class SLTPCalculator {
    constructor(config = {}) {
        this.config = {
            // Default SL/TP settings
            defaultStopLossPercent: config.defaultStopLossPercent || 1.0,
            defaultTakeProfitPercent: config.defaultTakeProfitPercent || 2.0,
            
            // Tick sizes for different instruments
            tickSizes: {
                MES: config.tickSizeMES,
                MNQ: config.tickSizeMNQ,
                MGC: config.tickSizeMGC,
                MCL: config.tickSizeMCL,
                M2K: config.tickSizeM2K,
                MYM: config.tickSizeMYM,
                default: 0.01
            },
            
            // Risk/Reward ratios
            minRiskRewardRatio: config.minRiskRewardRatio || 1.0,
            defaultRiskRewardRatio: config.defaultRiskRewardRatio || 2.0,
            
            // Trailing stop settings
            enableTrailingStop: config.enableTrailingStop || false,
            trailingStopTriggerPercent: config.trailingStopTriggerPercent || 1.0,
            trailingStopDistancePercent: config.trailingStopDistancePercent || 0.5,
            
            // ATR-based calculations
            useATR: config.useATR || false,
            atrMultiplierSL: config.atrMultiplierSL || 2.0,
            atrMultiplierTP: config.atrMultiplierTP || 3.0
        };
        
        // Track active positions for trailing stops
        this.activePositions = new Map();
        
        // Cache for market data (ATR, volatility)
        this.marketDataCache = new Map();
    }
    
    /**
     * Calculate SL/TP based on fill price
     * @param {Object} fill - Fill information
     * @param {Object} params - Calculation parameters
     * @returns {Object} Calculated SL/TP levels
     */
    calculateFromFill(fill, params = {}) {
        const {
            instrument,
            fillPrice,
            quantity,
            side, // 'BUY' or 'SELL'
            orderType
        } = fill;
        
        const {
            stopLossPercent = this.config.defaultStopLossPercent,
            takeProfitPercent = this.config.defaultTakeProfitPercent,
            stopLossPrice,
            takeProfitPrice,
            stopLossAmount,
            takeProfitAmount,
            riskRewardRatio = this.config.defaultRiskRewardRatio,
            useATR = this.config.useATR,
            marketData = {}
        } = params;
        
        const tickSize = this.getTickSize(instrument);
        
        let sl, tp;
        
        // Use provided prices if available
        if (stopLossPrice && takeProfitPrice) {
            sl = this.roundToTick(stopLossPrice, tickSize);
            tp = this.roundToTick(takeProfitPrice, tickSize);
        }
        // Calculate based on dollar amounts
        else if (stopLossAmount && takeProfitAmount) {
            const slDistance = stopLossAmount / quantity;
            const tpDistance = takeProfitAmount / quantity;
            
            if (side === 'BUY') {
                sl = fillPrice - slDistance;
                tp = fillPrice + tpDistance;
            } else {
                sl = fillPrice + slDistance;
                tp = fillPrice - tpDistance;
            }
            
            sl = this.roundToTick(sl, tickSize);
            tp = this.roundToTick(tp, tickSize);
        }
        // Calculate based on ATR if available
        else if (useATR && marketData.atr) {
            const atr = marketData.atr;
            const slDistance = atr * this.config.atrMultiplierSL;
            const tpDistance = atr * this.config.atrMultiplierTP;
            
            if (side === 'BUY') {
                sl = fillPrice - slDistance;
                tp = fillPrice + tpDistance;
            } else {
                sl = fillPrice + slDistance;
                tp = fillPrice - tpDistance;
            }
            
            sl = this.roundToTick(sl, tickSize);
            tp = this.roundToTick(tp, tickSize);
        }
        // Calculate based on percentage
        else {
            const slDistance = fillPrice * (stopLossPercent / 100);
            const tpDistance = fillPrice * (takeProfitPercent / 100);
            
            if (side === 'BUY') {
                sl = fillPrice - slDistance;
                tp = fillPrice + tpDistance;
            } else {
                sl = fillPrice + slDistance;
                tp = fillPrice - tpDistance;
            }
            
            sl = this.roundToTick(sl, tickSize);
            tp = this.roundToTick(tp, tickSize);
        }
        
        // Validate risk/reward ratio
        const actualRiskReward = this.calculateRiskRewardRatio(fillPrice, sl, tp, side);
        
        // Adjust TP if risk/reward is below minimum
        if (actualRiskReward < this.config.minRiskRewardRatio) {
            const slDistance = Math.abs(fillPrice - sl);
            const minTpDistance = slDistance * this.config.minRiskRewardRatio;
            
            if (side === 'BUY') {
                tp = fillPrice + minTpDistance;
            } else {
                tp = fillPrice - minTpDistance;
            }
            
            tp = this.roundToTick(tp, tickSize);
        }
        
        // Calculate dollar amounts
        const stopLossAmountCalc = Math.abs(fillPrice - sl) * quantity;
        const takeProfitAmountCalc = Math.abs(tp - fillPrice) * quantity;
        
        const result = {
            stopLoss: sl,
            takeProfit: tp,
            stopLossAmount: stopLossAmountCalc,
            takeProfitAmount: takeProfitAmountCalc,
            riskRewardRatio: this.calculateRiskRewardRatio(fillPrice, sl, tp, side),
            calculations: {
                fillPrice,
                side,
                quantity,
                tickSize,
                method: stopLossPrice ? 'price' : stopLossAmount ? 'amount' : useATR ? 'atr' : 'percent'
            }
        };
        
        // Store for trailing stop management if enabled
        if (this.config.enableTrailingStop) {
            this.activePositions.set(fill.orderId, {
                ...result,
                instrument,
                highWaterMark: side === 'BUY' ? fillPrice : null,
                lowWaterMark: side === 'SELL' ? fillPrice : null,
                trailingActivated: false
            });
        }
        
        return result;
    }
    
    /**
     * Calculate SL/TP based on points from fill price
     * @param {Object} fill - Fill information
     * @param {Number} stopLossPoints - Stop loss in points
     * @param {Number} takeProfitPoints - Take profit in points
     * @returns {Object} Calculated SL/TP levels
     */
    calculateFromPoints(fill, stopLossPoints, takeProfitPoints) {
        const {
            instrument,
            fillPrice,
            quantity,
            side // 'BUY' or 'SELL'
        } = fill;
        
        const tickSize = this.getTickSize(instrument);
        
        let sl = null, tp = null;
        
        // Calculate stop loss from points
        if (stopLossPoints && stopLossPoints > 0) {
            if (side === 'BUY') {
                // For BUY: SL is below fill price
                sl = fillPrice - stopLossPoints;
            } else {
                // For SELL: SL is above fill price
                sl = fillPrice + stopLossPoints;
            }
            sl = this.roundToTick(sl, tickSize);
        }
        
        // Calculate take profit from points
        if (takeProfitPoints && takeProfitPoints > 0) {
            if (side === 'BUY') {
                // For BUY: TP is above fill price
                tp = fillPrice + takeProfitPoints;
            } else {
                // For SELL: TP is below fill price
                tp = fillPrice - takeProfitPoints;
            }
            tp = this.roundToTick(tp, tickSize);
        }
        
        // Calculate dollar amounts
        const stopLossAmount = sl ? Math.abs(fillPrice - sl) * quantity : 0;
        const takeProfitAmount = tp ? Math.abs(tp - fillPrice) * quantity : 0;
        
        const result = {
            stopLoss: sl,
            takeProfit: tp,
            stopLossAmount: stopLossAmount,
            takeProfitAmount: takeProfitAmount,
            riskRewardRatio: sl && tp ? this.calculateRiskRewardRatio(fillPrice, sl, tp, side) : null,
            calculations: {
                fillPrice,
                side,
                quantity,
                tickSize,
                method: 'points',
                stopLossPoints,
                takeProfitPoints
            }
        };
        
        return result;
    }
    
    /**
     * Update trailing stop for a position
     * @param {String} orderId - Order ID
     * @param {Number} currentPrice - Current market price
     * @returns {Object|null} Updated stop loss if changed
     */
    updateTrailingStop(orderId, currentPrice) {
        if (!this.config.enableTrailingStop) return null;
        
        const position = this.activePositions.get(orderId);
        if (!position) return null;
        
        const { side, fillPrice, stopLoss, tickSize } = position.calculations;
        const triggerDistance = fillPrice * (this.config.trailingStopTriggerPercent / 100);
        const trailDistance = currentPrice * (this.config.trailingStopDistancePercent / 100);
        
        let newStopLoss = null;
        
        if (side === 'BUY') {
            // Check if we should activate trailing
            if (!position.trailingActivated && currentPrice >= fillPrice + triggerDistance) {
                position.trailingActivated = true;
            }
            
            // Update high water mark
            if (currentPrice > (position.highWaterMark || 0)) {
                position.highWaterMark = currentPrice;
                
                if (position.trailingActivated) {
                    const proposedStop = currentPrice - trailDistance;
                    if (proposedStop > position.stopLoss) {
                        newStopLoss = this.roundToTick(proposedStop, tickSize);
                        position.stopLoss = newStopLoss;
                    }
                }
            }
        } else {
            // SELL side
            if (!position.trailingActivated && currentPrice <= fillPrice - triggerDistance) {
                position.trailingActivated = true;
            }
            
            // Update low water mark
            if (currentPrice < (position.lowWaterMark || Infinity)) {
                position.lowWaterMark = currentPrice;
                
                if (position.trailingActivated) {
                    const proposedStop = currentPrice + trailDistance;
                    if (proposedStop < position.stopLoss) {
                        newStopLoss = this.roundToTick(proposedStop, tickSize);
                        position.stopLoss = newStopLoss;
                    }
                }
            }
        }
        
        if (newStopLoss) {
            return {
                orderId,
                newStopLoss,
                oldStopLoss: stopLoss,
                currentPrice,
                trailingActivated: position.trailingActivated
            };
        }
        
        return null;
    }
    
    /**
     * Calculate risk/reward ratio
     */
    calculateRiskRewardRatio(entry, stopLoss, takeProfit, side) {
        const risk = Math.abs(entry - stopLoss);
        const reward = Math.abs(takeProfit - entry);
        
        return risk > 0 ? reward / risk : 0;
    }
    
    /**
     * Get tick size for instrument
     */
    getTickSize(instrument) {
        const symbol = instrument.toUpperCase();
        
        // Check configured tick sizes
        for (const [key, value] of Object.entries(this.config.tickSizes)) {
            if (symbol.includes(key)) {
                return value;
            }
        }
        
        return this.config.tickSizes.default;
    }
    
    /**
     * Round price to nearest tick
     */
    roundToTick(price, tickSize) {
        // Validate price
        if (price === null || price === undefined || isNaN(price)) {
            throw new Error(`Invalid price for rounding: ${price}`);
        }

        // Validate tick size to prevent division by zero
        if (!tickSize || tickSize <= 0 || isNaN(tickSize)) {
            throw new Error(`Invalid tick size: ${tickSize}`);
        }

        return Math.round(price / tickSize) * tickSize;
    }
    
    /**
     * Validate SL/TP levels
     */
    validateLevels(entry, stopLoss, takeProfit, side) {
        const errors = [];
        
        if (side === 'BUY') {
            if (stopLoss >= entry) {
                errors.push('Stop loss must be below entry for long positions');
            }
            if (takeProfit <= entry) {
                errors.push('Take profit must be above entry for long positions');
            }
        } else {
            if (stopLoss <= entry) {
                errors.push('Stop loss must be above entry for short positions');
            }
            if (takeProfit >= entry) {
                errors.push('Take profit must be below entry for short positions');
            }
        }
        
        const riskReward = this.calculateRiskRewardRatio(entry, stopLoss, takeProfit, side);
        if (riskReward < this.config.minRiskRewardRatio) {
            errors.push(`Risk/reward ratio ${riskReward.toFixed(2)} below minimum ${this.config.minRiskRewardRatio}`);
        }
        
        return {
            valid: errors.length === 0,
            errors,
            riskReward
        };
    }
    
    /**
     * Update market data cache
     */
    updateMarketData(instrument, data) {
        this.marketDataCache.set(instrument, {
            ...this.marketDataCache.get(instrument),
            ...data,
            timestamp: new Date()
        });
    }
    
    /**
     * Get market data for instrument
     */
    getMarketData(instrument) {
        return this.marketDataCache.get(instrument) || {};
    }
    
    /**
     * Clear position tracking
     */
    clearPosition(orderId) {
        this.activePositions.delete(orderId);
    }
    
    /**
     * Get all active positions with trailing stops
     */
    getActiveTrailingStops() {
        const active = [];
        
        for (const [orderId, position] of this.activePositions) {
            if (position.trailingActivated) {
                active.push({
                    orderId,
                    ...position
                });
            }
        }
        
        return active;
    }
    
    /**
     * Get calculator statistics
     */
    getStatistics() {
        const positions = Array.from(this.activePositions.values());
        
        return {
            totalPositions: positions.length,
            trailingActive: positions.filter(p => p.trailingActivated).length,
            averageRiskReward: positions.length > 0 
                ? positions.reduce((sum, p) => sum + p.riskRewardRatio, 0) / positions.length 
                : 0,
            config: this.config
        };
    }
}

module.exports = SLTPCalculator;