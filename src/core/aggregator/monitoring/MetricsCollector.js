/**
 * MetricsCollector - Comprehensive metrics collection for Trading Aggregator
 * Tracks all aggregator operations and provides real-time insights
 */

const EventEmitter = require('events');

class MetricsCollector extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            collectionInterval: config.collectionInterval || 1000, // 1 second
            historySize: config.historySize || 300, // 5 minutes of second-by-second data
            enableDetailedTracking: config.enableDetailedTracking !== false
        };
        
        // Core metrics
        this.metrics = {
            // Order metrics
            orders: {
                received: 0,
                processed: 0,
                rejected: 0,
                failed: 0,
                queued: 0,
                bySource: new Map(),
                byInstrument: new Map(),
                byRejectionReason: new Map()
            },
            
            // Risk metrics
            risk: {
                violations: 0,
                violationsByType: new Map(),
                dailyLossTracking: 0,
                positionsOpen: 0,
                marginUsed: 0,
                accountDrawdown: 0
            },
            
            // Queue metrics
            queue: {
                depth: 0,
                processingTime: [],
                waitTime: [],
                maxDepth: 0,
                avgProcessingTime: 0,
                avgWaitTime: 0
            },
            
            // SL/TP metrics
            sltp: {
                calculated: 0,
                placed: 0,
                modified: 0,
                filled: 0,
                avgRiskRewardRatio: 0,
                riskRewardHistory: []
            },
            
            // System metrics
            system: {
                cpuUsage: 0,
                memoryUsage: 0,
                eventLoopLag: 0,
                uptime: 0,
                startTime: Date.now()
            },
            
            // Connection metrics
            connections: {
                redis: { status: 'disconnected', latency: 0, messagesReceived: 0 },
                connectionManager: { status: 'disconnected', latency: 0, requestsSent: 0 },
                websocket: { clients: 0, messagesOut: 0 }
            },
            
            // Performance metrics
            performance: {
                orderThroughput: 0, // orders per second
                fillLatency: [], // time from order submission to fill
                sltpLatency: [], // time from fill to SL/TP placement
                systemLatency: [] // overall system response time
            }
        };
        
        // Historical data
        this.history = {
            timestamps: [],
            orderRate: [],
            queueDepth: [],
            cpuUsage: [],
            memoryUsage: [],
            riskViolations: []
        };
        
        // Time-based tracking
        this.timeWindows = {
            oneMinute: { start: Date.now(), orders: 0, fills: 0, violations: 0 },
            fiveMinutes: { start: Date.now(), orders: 0, fills: 0, violations: 0 },
            oneHour: { start: Date.now(), orders: 0, fills: 0, violations: 0 }
        };
        
        this.collectionInterval = null;
        this.startTime = Date.now();
    }
    
    /**
     * Start metrics collection
     */
    start() {
        this.collectionInterval = setInterval(() => {
            this.collectSystemMetrics();
            this.updateHistoricalData();
            this.updateTimeWindows();
            this.emit('metrics', this.getSnapshot());
        }, this.config.collectionInterval);
        
        this.log('Started metrics collection');
    }
    
    /**
     * Stop metrics collection
     */
    stop() {
        if (this.collectionInterval) {
            clearInterval(this.collectionInterval);
            this.collectionInterval = null;
        }
        this.log('Stopped metrics collection');
    }
    
    /**
     * Record order received
     */
    recordOrderReceived(order) {
        this.metrics.orders.received++;
        this.incrementTimeWindow('orders');
        
        // Track by source
        const sourceCount = this.metrics.orders.bySource.get(order.source) || 0;
        this.metrics.orders.bySource.set(order.source, sourceCount + 1);
        
        // Track by instrument
        const instrumentCount = this.metrics.orders.byInstrument.get(order.instrument) || 0;
        this.metrics.orders.byInstrument.set(order.instrument, instrumentCount + 1);
        
        this.emit('orderReceived', { order, metrics: this.metrics.orders });
    }
    
    /**
     * Record order processed
     */
    recordOrderProcessed(order, processingTime) {
        this.metrics.orders.processed++;
        this.metrics.queue.processingTime.push(processingTime);
        
        // Keep only recent processing times
        if (this.metrics.queue.processingTime.length > 100) {
            this.metrics.queue.processingTime.shift();
        }
        
        this.updateAverages();
        this.emit('orderProcessed', { order, processingTime });
    }
    
    /**
     * Record order rejected
     */
    recordOrderRejected(order, reason, violations) {
        this.metrics.orders.rejected++;
        
        // Track rejection reasons
        const reasonCount = this.metrics.orders.byRejectionReason.get(reason) || 0;
        this.metrics.orders.byRejectionReason.set(reason, reasonCount + 1);
        
        if (reason === 'RISK_VIOLATION') {
            this.recordRiskViolation(violations);
        }
        
        this.emit('orderRejected', { order, reason, violations });
    }
    
    /**
     * Record risk violation
     */
    recordRiskViolation(violations) {
        this.metrics.risk.violations++;
        this.incrementTimeWindow('violations');
        
        // Track violation types
        if (violations && Array.isArray(violations)) {
            violations.forEach(violation => {
                const count = this.metrics.risk.violationsByType.get(violation.type) || 0;
                this.metrics.risk.violationsByType.set(violation.type, count + 1);
            });
        }
        
        this.emit('riskViolation', { violations: violations || [] });
    }
    
    /**
     * Record queue depth
     */
    recordQueueDepth(depth) {
        this.metrics.queue.depth = depth;
        this.metrics.queue.maxDepth = Math.max(this.metrics.queue.maxDepth, depth);
    }
    
    /**
     * Record SL/TP calculation
     */
    recordSLTPCalculation(sltpData) {
        this.metrics.sltp.calculated++;
        
        if (sltpData.riskRewardRatio) {
            this.metrics.sltp.riskRewardHistory.push(sltpData.riskRewardRatio);
            
            // Keep only recent history
            if (this.metrics.sltp.riskRewardHistory.length > 100) {
                this.metrics.sltp.riskRewardHistory.shift();
            }
            
            // Calculate average
            const sum = this.metrics.sltp.riskRewardHistory.reduce((a, b) => a + b, 0);
            this.metrics.sltp.avgRiskRewardRatio = sum / this.metrics.sltp.riskRewardHistory.length;
        }
        
        this.emit('sltpCalculated', { sltpData });
    }
    
    /**
     * Record fill
     */
    recordFill(fill, latency) {
        this.incrementTimeWindow('fills');
        
        if (latency) {
            this.metrics.performance.fillLatency.push(latency);
            
            // Keep only recent latencies
            if (this.metrics.performance.fillLatency.length > 100) {
                this.metrics.performance.fillLatency.shift();
            }
        }
        
        this.emit('fillRecorded', { fill, latency });
    }
    
    /**
     * Update connection status
     */
    updateConnectionStatus(service, status, latency = null) {
        if (this.metrics.connections[service]) {
            this.metrics.connections[service].status = status;
            if (latency !== null) {
                this.metrics.connections[service].latency = latency;
            }
        }
        
        this.emit('connectionStatusChanged', { service, status, latency });
    }
    
    /**
     * Collect system metrics
     */
    collectSystemMetrics() {
        // CPU usage (simplified - in production use proper monitoring)
        const cpuUsage = process.cpuUsage();
        this.metrics.system.cpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
        
        // Memory usage
        const memUsage = process.memoryUsage();
        this.metrics.system.memoryUsage = memUsage.heapUsed / 1024 / 1024; // MB
        
        // Event loop lag (simplified)
        const start = Date.now();
        setImmediate(() => {
            this.metrics.system.eventLoopLag = Date.now() - start;
        });
        
        // Uptime
        this.metrics.system.uptime = Date.now() - this.metrics.system.startTime;
        
        // Calculate throughput
        const timeDiff = (Date.now() - this.timeWindows.oneMinute.start) / 1000; // seconds
        if (timeDiff > 0) {
            this.metrics.performance.orderThroughput = this.timeWindows.oneMinute.orders / timeDiff;
        }
    }
    
    /**
     * Update historical data
     */
    updateHistoricalData() {
        const now = Date.now();
        
        this.history.timestamps.push(now);
        this.history.orderRate.push(this.metrics.performance.orderThroughput);
        this.history.queueDepth.push(this.metrics.queue.depth);
        this.history.cpuUsage.push(this.metrics.system.cpuUsage);
        this.history.memoryUsage.push(this.metrics.system.memoryUsage);
        this.history.riskViolations.push(this.metrics.risk.violations);
        
        // Trim history to configured size
        if (this.history.timestamps.length > this.config.historySize) {
            Object.keys(this.history).forEach(key => {
                this.history[key].shift();
            });
        }
    }
    
    /**
     * Update time windows
     */
    updateTimeWindows() {
        const now = Date.now();
        
        // Reset time windows as needed
        if (now - this.timeWindows.oneMinute.start > 60000) {
            this.timeWindows.oneMinute = { start: now, orders: 0, fills: 0, violations: 0 };
        }
        
        if (now - this.timeWindows.fiveMinutes.start > 300000) {
            this.timeWindows.fiveMinutes = { start: now, orders: 0, fills: 0, violations: 0 };
        }
        
        if (now - this.timeWindows.oneHour.start > 3600000) {
            this.timeWindows.oneHour = { start: now, orders: 0, fills: 0, violations: 0 };
        }
    }
    
    /**
     * Increment time window counters
     */
    incrementTimeWindow(type) {
        ['oneMinute', 'fiveMinutes', 'oneHour'].forEach(window => {
            if (this.timeWindows[window][type] !== undefined) {
                this.timeWindows[window][type]++;
            }
        });
    }
    
    /**
     * Update averages
     */
    updateAverages() {
        // Average processing time
        if (this.metrics.queue.processingTime.length > 0) {
            const sum = this.metrics.queue.processingTime.reduce((a, b) => a + b, 0);
            this.metrics.queue.avgProcessingTime = sum / this.metrics.queue.processingTime.length;
        }
        
        // Average wait time
        if (this.metrics.queue.waitTime.length > 0) {
            const sum = this.metrics.queue.waitTime.reduce((a, b) => a + b, 0);
            this.metrics.queue.avgWaitTime = sum / this.metrics.queue.waitTime.length;
        }
    }
    
    /**
     * Get current metrics snapshot
     */
    getSnapshot() {
        return {
            timestamp: Date.now(),
            metrics: this.metrics,
            timeWindows: this.timeWindows,
            history: {
                latest: {
                    orderRate: this.history.orderRate[this.history.orderRate.length - 1] || 0,
                    queueDepth: this.history.queueDepth[this.history.queueDepth.length - 1] || 0,
                    cpuUsage: this.history.cpuUsage[this.history.cpuUsage.length - 1] || 0,
                    memoryUsage: this.history.memoryUsage[this.history.memoryUsage.length - 1] || 0
                }
            }
        };
    }
    
    /**
     * Get full historical data
     */
    getHistory() {
        return this.history;
    }
    
    /**
     * Reset metrics
     */
    reset() {
        // Reset counters but keep configuration
        Object.keys(this.metrics.orders).forEach(key => {
            if (typeof this.metrics.orders[key] === 'number') {
                this.metrics.orders[key] = 0;
            } else if (this.metrics.orders[key] instanceof Map) {
                this.metrics.orders[key].clear();
            }
        });
        
        // Reset other metrics similarly
        this.log('Metrics reset');
    }
    
    /**
     * Log message
     */
    log(message, data = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            component: 'MetricsCollector',
            message,
            ...data
        };
        console.log(JSON.stringify(logEntry));
    }
}

module.exports = MetricsCollector;