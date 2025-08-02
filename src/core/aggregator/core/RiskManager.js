/**
 * RiskManager - Core risk validation and management for aggregated orders
 * Ensures all orders meet risk criteria before processing
 */

class RiskManager {
    constructor(config = {}) {
        this.config = {
            // Account-level limits
            maxPositionSize: config.maxPositionSize || 10,
            maxDailyLoss: config.maxDailyLoss || 500,
            maxDailyProfit: config.maxDailyProfit || 1000, // Stop trading when daily profit target reached
            maxOpenPositions: config.maxOpenPositions || 5,
            
            // Order-level validation
            minOrderSize: config.minOrderSize || 1,
            maxOrderSize: config.maxOrderSize || 10,
            maxLeverage: config.maxLeverage || 1,
            
            // Risk calculations
            defaultRiskPercent: config.defaultRiskPercent || 1,
            maxRiskPerTrade: config.maxRiskPerTrade || 2,
            
            // Time-based restrictions
            allowedTradingHours: config.allowedTradingHours !== undefined ? config.allowedTradingHours : { start: '09:30', end: '16:00' },
            blockedDates: config.blockedDates || [],
            
            // REMOVED: Shadow mode - Now enforces risk controls in ALL modes
            // Risk enforcement is ALWAYS active for safety
            enforceRisk: true
        };
        
        // Store reference to ConnectionManagerAdapter for real account data
        this.connectionManagerAdapter = config.connectionManagerAdapter || null;
        
        // Track current risk state
        this.state = {
            openPositions: new Map(),
            dailyPnL: 0,
            dailyLossCount: 0,
            accountBalance: config.accountBalance || 50000, // Fallback if no connection
            accountBalanceCache: null,
            accountBalanceCacheTime: null,
            violations: []
        };
        
        // Risk violation history for analysis
        this.violationHistory = [];
    }
    
    /**
     * Get current account balance from Connection Manager or cache
     * @param {string} accountId - Account ID to get balance for
     * @returns {Promise<number>} Current account balance
     */
    async getCurrentAccountBalance(accountId) {
        try {
            // Use cached balance if fresh (within 5 minutes)
            const cacheAge = this.state.accountBalanceCacheTime ? 
                Date.now() - this.state.accountBalanceCacheTime : Infinity;
            
            if (this.state.accountBalanceCache && cacheAge < 5 * 60 * 1000) {
                return this.state.accountBalanceCache;
            }
            
            // Get fresh balance from Connection Manager if available
            if (this.connectionManagerAdapter && this.connectionManagerAdapter.isConnected) {
                // Fetch account balance through the Connection Manager adapter
                const url = accountId ? `/account/balance?accountId=${accountId}` : '/account/balance';
                const balanceResponse = await this.connectionManagerAdapter.httpClient.get(url);
                
                if (balanceResponse.data) {
                    let balance = 0;
                    
                    // Check different response formats
                    if (balanceResponse.data.totalBalance !== undefined) {
                        // New format from Connection Manager
                        balance = balanceResponse.data.totalBalance;
                    } else if (balanceResponse.data.balance !== undefined) {
                        // Legacy format
                        balance = balanceResponse.data.balance;
                    } else if (balanceResponse.data.accounts && Array.isArray(balanceResponse.data.accounts)) {
                        // Find account by ID if we have multiple accounts
                        const account = balanceResponse.data.accounts.find(acc => acc.id === accountId);
                        if (account && account.balance !== undefined) {
                            balance = account.balance;
                        } else if (balanceResponse.data.accounts.length > 0) {
                            // Use first account's balance as fallback
                            balance = balanceResponse.data.accounts[0].balance || 0;
                        }
                    }
                    
                    if (balance > 0) {
                        // Update cache
                        this.state.accountBalanceCache = balance;
                        this.state.accountBalanceCacheTime = Date.now();
                        this.state.accountBalance = balance;
                        
                        console.log(`💰 Real account balance: $${balance.toLocaleString()}`);
                        return balance;
                    }
                }
            }
            
            // Fallback to configured/default balance
            console.log(`⚠️ Using fallback balance: $${this.state.accountBalance.toLocaleString()}`);
            return this.state.accountBalance;
            
        } catch (error) {
            console.error('❌ Error fetching account balance:', error.message);
            // Return fallback balance on error
            return this.state.accountBalance;
        }
    }
    
    /**
     * Validate an order against all risk rules
     * @param {Object} order - Order to validate
     * @param {Object} context - Additional context (account, market data)
     * @returns {Object} Validation result with violations if any
     */
    async validateOrder(order, context = {}) {
        const violations = [];
        const timestamp = new Date();
        
        // Position size check
        if (order.quantity > this.config.maxOrderSize) {
            violations.push({
                type: 'MAX_ORDER_SIZE',
                message: `Order size ${order.quantity} exceeds maximum ${this.config.maxOrderSize}`,
                severity: 'HIGH'
            });
        }
        
        if (order.quantity < this.config.minOrderSize) {
            violations.push({
                type: 'MIN_ORDER_SIZE',
                message: `Order size ${order.quantity} below minimum ${this.config.minOrderSize}`,
                severity: 'HIGH'
            });
        }
        
        // Check open positions limit
        const currentPositions = this.state.openPositions.size;
        if (currentPositions >= this.config.maxOpenPositions && order.action === 'BUY') {
            violations.push({
                type: 'MAX_POSITIONS',
                message: `Maximum open positions (${this.config.maxOpenPositions}) reached`,
                severity: 'MEDIUM'
            });
        }
        
        // Daily loss check
        if (this.state.dailyPnL <= -this.config.maxDailyLoss) {
            violations.push({
                type: 'DAILY_LOSS_LIMIT',
                message: `Daily loss limit ($${this.config.maxDailyLoss}) reached`,
                severity: 'CRITICAL'
            });
        }
        
        // Daily profit limit check (stop trading when target reached)
        if (this.state.dailyPnL >= this.config.maxDailyProfit) {
            violations.push({
                type: 'DAILY_PROFIT_LIMIT',
                message: `Daily profit target ($${this.config.maxDailyProfit}) reached - stopping trading`,
                severity: 'HIGH'
            });
        }
        
        // Trading hours check
        if (!this.isWithinTradingHours(timestamp)) {
            violations.push({
                type: 'OUTSIDE_TRADING_HOURS',
                message: 'Order placed outside allowed trading hours',
                severity: 'HIGH'
            });
        }
        
        // Get real account balance for risk calculations
        const accountBalance = await this.getCurrentAccountBalance(order.accountId || order.account);
        
        // Risk per trade check
        if (order.stopLoss) {
            const riskAmount = this.calculateRiskAmount(order, context);
            const riskPercent = (riskAmount / accountBalance) * 100;
            
            if (riskPercent > this.config.maxRiskPerTrade) {
                violations.push({
                    type: 'EXCESSIVE_RISK',
                    message: `Risk ${riskPercent.toFixed(2)}% exceeds maximum ${this.config.maxRiskPerTrade}%`,
                    severity: 'HIGH'
                });
            }
        }
        
        // Store violations for analysis
        if (violations.length > 0) {
            this.violationHistory.push({
                timestamp,
                orderId: order.id,
                source: order.source,
                violations,
                enforced: true // Always enforced now
            });
        }
        
        return {
            valid: violations.length === 0, // CRITICAL FIX: No shadow mode bypass
            violations,
            enforced: true, // Always enforced
            riskMetrics: {
                currentPositions,
                dailyPnL: this.state.dailyPnL,
                accountBalance: accountBalance,
                timestamp
            }
        };
    }
    
    /**
     * Calculate risk amount for an order
     */
    calculateRiskAmount(order, context) {
        if (!order.stopLoss) return 0;
        
        const entryPrice = order.price || context.marketPrice || 0;
        const stopPrice = order.stopLoss;
        const quantity = order.quantity;
        
        return Math.abs(entryPrice - stopPrice) * quantity;
    }
    
    /**
     * Check if current time is within trading hours
     */
    isWithinTradingHours(timestamp = new Date()) {
        // If trading hours are not configured or null, allow trading at all times
        if (!this.config.allowedTradingHours || this.config.allowedTradingHours === null) {
            return true;
        }
        
        const hours = timestamp.getHours();
        const minutes = timestamp.getMinutes();
        const currentTime = hours * 60 + minutes;
        
        const [startHour, startMin] = this.config.allowedTradingHours.start.split(':').map(Number);
        const [endHour, endMin] = this.config.allowedTradingHours.end.split(':').map(Number);
        
        const startTime = startHour * 60 + startMin;
        const endTime = endHour * 60 + endMin;
        
        return currentTime >= startTime && currentTime <= endTime;
    }
    
    /**
     * Update position tracking
     */
    updatePosition(orderId, position) {
        if (position.quantity === 0) {
            this.state.openPositions.delete(orderId);
        } else {
            this.state.openPositions.set(orderId, position);
        }
    }
    
    /**
     * Update daily P&L
     */
    updateDailyPnL(amount) {
        this.state.dailyPnL += amount;
        if (amount < 0) {
            this.state.dailyLossCount++;
        }
    }
    
    /**
     * Reset daily metrics (call at start of trading day)
     */
    resetDailyMetrics() {
        this.state.dailyPnL = 0;
        this.state.dailyLossCount = 0;
        this.violationHistory = this.violationHistory.filter(v => {
            const age = Date.now() - v.timestamp.getTime();
            return age < 7 * 24 * 60 * 60 * 1000; // Keep 7 days
        });
    }
    
    /**
     * Get risk report
     */
    getRiskReport() {
        return {
            currentState: {
                openPositions: this.state.openPositions.size,
                dailyPnL: this.state.dailyPnL,
                accountBalance: this.state.accountBalance,
                dailyLossCount: this.state.dailyLossCount
            },
            violations: {
                total: this.violationHistory.length,
                bySeverity: this.groupViolationsBySeverity(),
                byType: this.groupViolationsByType(),
                recent: this.violationHistory.slice(-10)
            },
            config: this.config
        };
    }
    
    /**
     * Group violations by severity
     */
    groupViolationsBySeverity() {
        const groups = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        this.violationHistory.forEach(record => {
            record.violations.forEach(v => {
                groups[v.severity] = (groups[v.severity] || 0) + 1;
            });
        });
        return groups;
    }
    
    /**
     * Group violations by type
     */
    groupViolationsByType() {
        const groups = {};
        this.violationHistory.forEach(record => {
            record.violations.forEach(v => {
                groups[v.type] = (groups[v.type] || 0) + 1;
            });
        });
        return groups;
    }
}

module.exports = RiskManager;