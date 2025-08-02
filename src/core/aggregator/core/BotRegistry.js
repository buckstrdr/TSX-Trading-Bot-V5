/**
 * BotRegistry - Tracks and manages all order sources (bots, manual trading, etc.)
 * Provides source identification, routing, and analytics
 */

const EventEmitter = require('events');

class BotRegistry extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Registration settings
            requireRegistration: config.requireRegistration !== false,
            allowDynamicRegistration: config.allowDynamicRegistration !== false,
            
            // Source types
            sourceTypes: {
                BOT: 'BOT',
                MANUAL: 'MANUAL',
                API: 'API',
                STRATEGY: 'STRATEGY',
                EXTERNAL: 'EXTERNAL'
            },
            
            // Validation
            validateSources: config.validateSources !== false,
            maxSourcesPerType: config.maxSourcesPerType || 100,
            
            // Analytics
            trackMetrics: config.trackMetrics !== false,
            metricsRetentionDays: config.metricsRetentionDays || 30
        };
        
        // Registry state
        this.sources = new Map();
        this.sourceMetrics = new Map();
        this.sourceHistory = [];
        
        // Source validation schemas
        this.schemas = {
            BOT: {
                required: ['id', 'name', 'version', 'strategy'],
                optional: ['config', 'instruments', 'riskLimits']
            },
            MANUAL: {
                required: ['id', 'traderId'],
                optional: ['name', 'permissions']
            },
            API: {
                required: ['id', 'apiKey', 'permissions'],
                optional: ['name', 'ipWhitelist']
            },
            STRATEGY: {
                required: ['id', 'name', 'type'],
                optional: ['parameters', 'instruments']
            },
            EXTERNAL: {
                required: ['id', 'source'],
                optional: ['credentials', 'config']
            }
        };
        
        // Initialize default sources
        this.initializeDefaultSources();
    }
    
    /**
     * Initialize default sources
     */
    initializeDefaultSources() {
        // Register manual trading source
        this.register({
            id: 'MANUAL_TRADING_V2',
            type: this.config.sourceTypes.MANUAL,
            name: 'Manual Trading Interface',
            traderId: 'SYSTEM',
            permissions: ['TRADE', 'VIEW', 'MODIFY', 'CANCEL']
        });
        
        // Register system source for internal operations
        this.register({
            id: 'SYSTEM',
            type: this.config.sourceTypes.EXTERNAL,
            name: 'System Operations',
            source: 'INTERNAL'
        });
    }
    
    /**
     * Register a new source
     */
    register(source) {
        // Validate source data
        const validation = this.validateSource(source);
        if (!validation.valid) {
            this.emit('registrationFailed', {
                source,
                errors: validation.errors
            });
            return {
                success: false,
                errors: validation.errors
            };
        }
        
        // Check if already registered
        if (this.sources.has(source.id)) {
            return {
                success: false,
                errors: ['Source already registered']
            };
        }
        
        // Check type limits
        const typeCount = this.getSourcesByType(source.type).length;
        if (typeCount >= this.config.maxSourcesPerType) {
            return {
                success: false,
                errors: [`Maximum sources of type ${source.type} reached`]
            };
        }
        
        // Register source
        const registeredSource = {
            ...source,
            registeredAt: new Date(),
            lastActivity: new Date(),
            status: 'ACTIVE',
            metadata: {
                orderCount: 0,
                lastOrderTime: null,
                successRate: 100,
                avgResponseTime: 0
            }
        };
        
        this.sources.set(source.id, registeredSource);
        
        // Initialize metrics
        if (this.config.trackMetrics) {
            this.sourceMetrics.set(source.id, {
                orders: {
                    total: 0,
                    successful: 0,
                    failed: 0,
                    cancelled: 0
                },
                performance: {
                    totalPnL: 0,
                    winRate: 0,
                    avgWin: 0,
                    avgLoss: 0,
                    sharpeRatio: 0
                },
                activity: {
                    lastOrder: null,
                    dailyOrders: [],
                    peakHour: null
                }
            });
        }
        
        this.emit('sourceRegistered', {
            source: registeredSource
        });
        
        // Record in history
        this.sourceHistory.push({
            action: 'REGISTER',
            sourceId: source.id,
            timestamp: new Date(),
            details: registeredSource
        });
        
        return {
            success: true,
            source: registeredSource
        };
    }
    
    /**
     * Validate source data
     */
    validateSource(source) {
        const errors = [];
        
        if (!source.id) {
            errors.push('Source ID is required');
        }
        
        if (!source.type || !Object.values(this.config.sourceTypes).includes(source.type)) {
            errors.push('Valid source type is required');
        }
        
        // Type-specific validation
        if (source.type && this.schemas[source.type]) {
            const schema = this.schemas[source.type];
            
            // Check required fields
            for (const field of schema.required) {
                if (!source[field]) {
                    errors.push(`Field '${field}' is required for ${source.type} sources`);
                }
            }
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    /**
     * Get source by ID
     */
    getSource(sourceId) {
        return this.sources.get(sourceId);
    }
    
    /**
     * Get sources by type
     */
    getSourcesByType(type) {
        return Array.from(this.sources.values()).filter(s => s.type === type);
    }
    
    /**
     * Update source status
     */
    updateSourceStatus(sourceId, status) {
        const source = this.sources.get(sourceId);
        if (!source) {
            return { success: false, error: 'Source not found' };
        }
        
        const validStatuses = ['ACTIVE', 'PAUSED', 'DISABLED', 'MAINTENANCE'];
        if (!validStatuses.includes(status)) {
            return { success: false, error: 'Invalid status' };
        }
        
        source.status = status;
        source.lastActivity = new Date();
        
        this.emit('sourceStatusChanged', {
            sourceId,
            oldStatus: source.status,
            newStatus: status
        });
        
        this.sourceHistory.push({
            action: 'STATUS_CHANGE',
            sourceId,
            timestamp: new Date(),
            details: { status }
        });
        
        return { success: true };
    }
    
    /**
     * Record order from source
     */
    recordOrder(sourceId, order, result) {
        let source = this.sources.get(sourceId);
        if (!source) {
            // Allow dynamic registration if enabled
            if (this.config.allowDynamicRegistration) {
                const registrationResult = this.register({
                    id: sourceId,
                    type: this.config.sourceTypes.EXTERNAL,
                    name: `Dynamic Source ${sourceId}`,
                    source: 'DYNAMIC'
                });
                
                if (!registrationResult.success) {
                    return registrationResult;
                }
                
                // Get the newly registered source
                source = this.sources.get(sourceId);
                if (!source) {
                    return { success: false, error: 'Failed to register source dynamically' };
                }
            } else {
                return { success: false, error: 'Source not registered' };
            }
        }
        
        // Ensure source has metadata (defensive programming)
        if (!source.metadata) {
            source.metadata = {
                orderCount: 0,
                lastOrderTime: null,
                successRate: 100,
                avgResponseTime: 0
            };
        }
        
        // Update source metadata
        source.metadata.orderCount++;
        source.metadata.lastOrderTime = new Date();
        source.lastActivity = new Date();
        
        // Update metrics if tracking enabled
        if (this.config.trackMetrics) {
            const metrics = this.sourceMetrics.get(sourceId);
            if (metrics) {
                metrics.orders.total++;
                
                if (result.success) {
                    metrics.orders.successful++;
                } else if (result.cancelled) {
                    metrics.orders.cancelled++;
                } else {
                    metrics.orders.failed++;
                }
                
                // Update success rate
                source.metadata.successRate = 
                    (metrics.orders.successful / metrics.orders.total) * 100;
                
                // Track daily activity
                const today = new Date().toISOString().split('T')[0];
                const dailyEntry = metrics.activity.dailyOrders.find(d => d.date === today);
                
                if (dailyEntry) {
                    dailyEntry.count++;
                } else {
                    metrics.activity.dailyOrders.push({ date: today, count: 1 });
                }
                
                // Keep only recent daily data
                metrics.activity.dailyOrders = metrics.activity.dailyOrders
                    .slice(-this.config.metricsRetentionDays);
                
                metrics.activity.lastOrder = new Date();
            }
        }
        
        return { success: true };
    }
    
    /**
     * Update source performance metrics
     */
    updatePerformanceMetrics(sourceId, trade) {
        if (!this.config.trackMetrics) return;
        
        const metrics = this.sourceMetrics.get(sourceId);
        if (!metrics) return;
        
        const { pnl, isWin } = trade;
        
        metrics.performance.totalPnL += pnl;
        
        if (isWin) {
            metrics.performance.avgWin = 
                (metrics.performance.avgWin * metrics.performance.winRate + pnl) / 
                (metrics.performance.winRate + 1);
            metrics.performance.winRate++;
        } else {
            metrics.performance.avgLoss = 
                (metrics.performance.avgLoss * (metrics.orders.total - metrics.performance.winRate) + Math.abs(pnl)) / 
                (metrics.orders.total - metrics.performance.winRate + 1);
        }
        
        // Calculate Sharpe ratio (simplified)
        // This would need more sophisticated calculation in production
        if (metrics.orders.total > 20) {
            const winRate = metrics.performance.winRate / metrics.orders.total;
            const avgReturn = metrics.performance.totalPnL / metrics.orders.total;
            const riskFreeRate = 0.02 / 252; // Daily risk-free rate
            
            metrics.performance.sharpeRatio = 
                Math.sqrt(252) * (avgReturn - riskFreeRate) / 
                Math.sqrt(metrics.performance.avgWin + metrics.performance.avgLoss);
        }
    }
    
    /**
     * Get source analytics
     */
    getSourceAnalytics(sourceId) {
        const source = this.sources.get(sourceId);
        if (!source) return null;
        
        const metrics = this.sourceMetrics.get(sourceId);
        
        return {
            source: {
                id: source.id,
                name: source.name,
                type: source.type,
                status: source.status,
                registeredAt: source.registeredAt,
                lastActivity: source.lastActivity
            },
            metadata: source.metadata,
            metrics: metrics || {},
            analysis: this.analyzeSource(sourceId)
        };
    }
    
    /**
     * Analyze source performance
     */
    analyzeSource(sourceId) {
        const metrics = this.sourceMetrics.get(sourceId);
        if (!metrics || !this.config.trackMetrics) return {};
        
        const analysis = {
            performance: 'UNKNOWN',
            reliability: 'UNKNOWN',
            activity: 'UNKNOWN',
            recommendations: []
        };
        
        // Performance rating
        if (metrics.orders.total > 10) {
            const successRate = (metrics.orders.successful / metrics.orders.total) * 100;
            if (successRate > 80) {
                analysis.performance = 'EXCELLENT';
            } else if (successRate > 60) {
                analysis.performance = 'GOOD';
            } else if (successRate > 40) {
                analysis.performance = 'FAIR';
            } else {
                analysis.performance = 'POOR';
                analysis.recommendations.push('Consider reviewing source configuration');
            }
        }
        
        // Reliability rating
        const failureRate = (metrics.orders.failed / metrics.orders.total) * 100;
        if (failureRate < 5) {
            analysis.reliability = 'HIGH';
        } else if (failureRate < 15) {
            analysis.reliability = 'MEDIUM';
        } else {
            analysis.reliability = 'LOW';
            analysis.recommendations.push('High failure rate detected');
        }
        
        // Activity rating
        const daysSinceLastOrder = metrics.activity.lastOrder 
            ? (Date.now() - metrics.activity.lastOrder.getTime()) / (1000 * 60 * 60 * 24)
            : Infinity;
            
        if (daysSinceLastOrder < 1) {
            analysis.activity = 'ACTIVE';
        } else if (daysSinceLastOrder < 7) {
            analysis.activity = 'MODERATE';
        } else {
            analysis.activity = 'INACTIVE';
            analysis.recommendations.push('Source has been inactive');
        }
        
        return analysis;
    }
    
    /**
     * Get registry statistics
     */
    getStatistics() {
        const stats = {
            totalSources: this.sources.size,
            byType: {},
            byStatus: {},
            activeCount: 0,
            recentActivity: []
        };
        
        // Count by type and status
        for (const source of this.sources.values()) {
            stats.byType[source.type] = (stats.byType[source.type] || 0) + 1;
            stats.byStatus[source.status] = (stats.byStatus[source.status] || 0) + 1;
            
            if (source.status === 'ACTIVE') {
                stats.activeCount++;
            }
            
            // Recent activity
            const hoursSinceActivity = 
                (Date.now() - source.lastActivity.getTime()) / (1000 * 60 * 60);
                
            if (hoursSinceActivity < 24) {
                stats.recentActivity.push({
                    sourceId: source.id,
                    name: source.name,
                    lastActivity: source.lastActivity,
                    orderCount: source.metadata.orderCount
                });
            }
        }
        
        // Sort recent activity
        stats.recentActivity.sort((a, b) => 
            b.lastActivity.getTime() - a.lastActivity.getTime()
        );
        
        return stats;
    }
    
    /**
     * Clean up old history
     */
    cleanupHistory() {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.config.metricsRetentionDays);
        
        this.sourceHistory = this.sourceHistory.filter(
            entry => entry.timestamp > cutoffDate
        );
    }
    
    /**
     * Export registry data
     */
    exportData() {
        return {
            sources: Array.from(this.sources.entries()),
            metrics: Array.from(this.sourceMetrics.entries()),
            history: this.sourceHistory,
            config: this.config,
            exportedAt: new Date()
        };
    }
}

module.exports = BotRegistry;