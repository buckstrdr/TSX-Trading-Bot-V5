/**
 * RedisMetricsPublisher - Publishes aggregator metrics to Redis for control panel consumption
 * Integrates with existing Redis pub/sub infrastructure
 */

const EventEmitter = require('events');
const redis = require('redis');

class RedisMetricsPublisher extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            host: config.host || 'localhost',
            port: config.port || 6379,
            password: config.password || null,
            db: config.db || 0,
            
            // Publishing intervals
            metricsInterval: config.metricsInterval || 1000, // 1 second
            summaryInterval: config.summaryInterval || 60000, // 1 minute
            
            // Redis channels
            channels: {
                metrics: 'aggregator:metrics',
                health: 'aggregator:health',
                alerts: 'aggregator:alerts',
                summary: 'aggregator:summary'
            },
            
            // Redis keys for storing metrics
            keys: {
                currentMetrics: 'aggregator:metrics:current',
                historicalMetrics: 'aggregator:metrics:history',
                health: 'aggregator:health:status',
                alerts: 'aggregator:alerts:active'
            },
            
            // Alert thresholds
            alertThresholds: {
                queueDepth: config.alertThresholds?.queueDepth || 50,
                processingTime: config.alertThresholds?.processingTime || 1000, // ms
                riskViolationRate: config.alertThresholds?.riskViolationRate || 0.1, // 10%
                errorRate: config.alertThresholds?.errorRate || 0.05, // 5%
                memoryUsage: config.alertThresholds?.memoryUsage || 500 // MB
            }
        };
        
        this.publisher = null;
        this.storageClient = null;
        this.metricsCollector = null;
        this.aggregator = null;
        
        this.publishIntervals = {
            metrics: null,
            summary: null
        };
        
        this.activeAlerts = new Set();
        this.lastMetrics = null;
    }
    
    /**
     * Initialize Redis connections
     */
    async initialize() {
        try {
            // Create publisher client
            this.publisher = redis.createClient({
                host: this.config.host,
                port: this.config.port,
                password: this.config.password,
                db: this.config.db
            });
            
            // Create storage client (for SET/GET operations)
            this.storageClient = redis.createClient({
                host: this.config.host,
                port: this.config.port,
                password: this.config.password,
                db: this.config.db
            });
            
            // Setup error handlers
            this.publisher.on('error', (err) => {
                this.emit('error', { type: 'publisher', error: err });
            });
            
            this.storageClient.on('error', (err) => {
                this.emit('error', { type: 'storage', error: err });
            });
            
            // Connect both clients
            await this.connectClient(this.publisher, 'publisher');
            await this.connectClient(this.storageClient, 'storage');
            
            this.emit('connected');
            this.log('Redis metrics publisher initialized');
            
        } catch (error) {
            this.emit('error', { type: 'initialization', error });
            throw error;
        }
    }
    
    /**
     * Connect Redis client with promise
     */
    connectClient(client, name) {
        return new Promise((resolve, reject) => {
            client.on('ready', () => {
                this.log(`Redis ${name} client connected`);
                resolve();
            });
            
            client.on('error', (err) => {
                reject(err);
            });
        });
    }
    
    /**
     * Attach metrics collector and aggregator
     */
    attach(metricsCollector, aggregator) {
        this.metricsCollector = metricsCollector;
        this.aggregator = aggregator;
        
        // Start publishing intervals
        this.startPublishing();
        
        // Subscribe to important events for immediate publishing
        metricsCollector.on('orderRejected', (data) => {
            if (data.reason === 'RISK_VIOLATION') {
                this.publishAlert('risk_violation', data);
            }
        });
        
        metricsCollector.on('connectionStatusChanged', (data) => {
            if (data.status === 'disconnected') {
                this.publishAlert('connection_lost', data);
            }
        });
        
        this.log('Attached to metrics collector and aggregator');
    }
    
    /**
     * Start publishing metrics
     */
    startPublishing() {
        // Real-time metrics publishing
        this.publishIntervals.metrics = setInterval(() => {
            this.publishMetrics();
        }, this.config.metricsInterval);
        
        // Summary publishing
        this.publishIntervals.summary = setInterval(() => {
            this.publishSummary();
        }, this.config.summaryInterval);
        
        // Initial publish
        this.publishMetrics();
        this.publishHealth();
    }
    
    /**
     * Stop publishing
     */
    stopPublishing() {
        Object.values(this.publishIntervals).forEach(interval => {
            if (interval) clearInterval(interval);
        });
        
        this.publishIntervals = {
            metrics: null,
            summary: null
        };
    }
    
    /**
     * Publish current metrics
     */
    async publishMetrics() {
        if (!this.metricsCollector || !this.aggregator) return;
        
        try {
            const snapshot = this.metricsCollector.getSnapshot();
            const aggregatorMetrics = this.aggregator.getMetrics();
            
            const metrics = {
                timestamp: Date.now(),
                monitoring: snapshot.metrics,
                aggregator: aggregatorMetrics,
                timeWindows: snapshot.timeWindows,
                history: snapshot.history
            };
            
            // Store current metrics in Redis
            await this.storeMetrics(metrics);
            
            // Publish to channel
            this.publisher.publish(
                this.config.channels.metrics,
                JSON.stringify(metrics)
            );
            
            // Check for alerts
            this.checkAlerts(metrics);
            
            this.lastMetrics = metrics;
            
        } catch (error) {
            this.emit('error', { type: 'publish_metrics', error });
        }
    }
    
    /**
     * Store metrics in Redis
     */
    async storeMetrics(metrics) {
        return new Promise((resolve, reject) => {
            // Store current metrics
            this.storageClient.setex(
                this.config.keys.currentMetrics,
                300, // 5 minute TTL
                JSON.stringify(metrics),
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
            
            // Add to historical data (using Redis list)
            const historicalEntry = {
                timestamp: metrics.timestamp,
                orders: metrics.monitoring.orders.received,
                processed: metrics.monitoring.orders.processed,
                rejected: metrics.monitoring.orders.rejected,
                queueDepth: metrics.monitoring.queue.depth,
                violations: metrics.monitoring.risk.violations
            };
            
            this.storageClient.lpush(
                this.config.keys.historicalMetrics,
                JSON.stringify(historicalEntry)
            );
            
            // Trim historical data to last 1 hour (3600 entries at 1 second intervals)
            this.storageClient.ltrim(
                this.config.keys.historicalMetrics,
                0,
                3599
            );
        });
    }
    
    /**
     * Publish health status
     */
    async publishHealth() {
        if (!this.aggregator) return;
        
        try {
            const health = {
                timestamp: Date.now(),
                status: this.aggregator.state.status,
                uptime: Date.now() - this.aggregator.state.startTime.getTime(),
                shadowMode: this.aggregator.config.shadowMode,
                components: {
                    riskManager: 'healthy',
                    queueManager: 'healthy',
                    sltpCalculator: 'healthy',
                    redis: this.publisher.connected ? 'connected' : 'disconnected',
                    connectionManager: this.aggregator.connectionManagerAdapter ? 'connected' : 'disconnected'
                },
                metrics: {
                    ordersProcessed: this.aggregator.state.metrics.ordersProcessed,
                    activeOrders: this.aggregator.state.orders.size,
                    openPositions: this.aggregator.state.positions.size
                }
            };
            
            // Store health status
            this.storageClient.setex(
                this.config.keys.health,
                60, // 1 minute TTL
                JSON.stringify(health)
            );
            
            // Publish to channel
            this.publisher.publish(
                this.config.channels.health,
                JSON.stringify(health)
            );
            
        } catch (error) {
            this.emit('error', { type: 'publish_health', error });
        }
    }
    
    /**
     * Publish summary metrics
     */
    async publishSummary() {
        if (!this.metricsCollector || !this.aggregator) return;
        
        try {
            const snapshot = this.metricsCollector.getSnapshot();
            const aggregatorMetrics = this.aggregator.getMetrics();
            
            const summary = {
                timestamp: Date.now(),
                period: 'last_minute',
                orders: {
                    total: snapshot.timeWindows.oneMinute.orders,
                    processed: aggregatorMetrics.aggregator.ordersProcessed,
                    rejected: aggregatorMetrics.aggregator.ordersFailed,
                    throughput: snapshot.metrics.performance.orderThroughput
                },
                risk: {
                    violations: snapshot.timeWindows.oneMinute.violations,
                    violationRate: snapshot.timeWindows.oneMinute.orders > 0 
                        ? snapshot.timeWindows.oneMinute.violations / snapshot.timeWindows.oneMinute.orders 
                        : 0,
                    topViolations: this.getTopViolations(snapshot.metrics.risk.violationsByType)
                },
                performance: {
                    avgProcessingTime: snapshot.metrics.queue.avgProcessingTime,
                    avgQueueDepth: snapshot.metrics.queue.depth,
                    maxQueueDepth: snapshot.metrics.queue.maxDepth
                },
                sltp: {
                    calculated: snapshot.metrics.sltp.calculated,
                    avgRiskReward: snapshot.metrics.sltp.avgRiskRewardRatio
                },
                system: {
                    cpuUsage: snapshot.metrics.system.cpuUsage,
                    memoryUsage: snapshot.metrics.system.memoryUsage,
                    uptime: snapshot.metrics.system.uptime
                }
            };
            
            // Publish summary
            this.publisher.publish(
                this.config.channels.summary,
                JSON.stringify(summary)
            );
            
            this.emit('summary', summary);
            
        } catch (error) {
            this.emit('error', { type: 'publish_summary', error });
        }
    }
    
    /**
     * Check for alert conditions
     */
    checkAlerts(metrics) {
        const alerts = [];
        
        // Queue depth alert
        if (metrics.monitoring.queue.depth > this.config.alertThresholds.queueDepth) {
            alerts.push({
                type: 'queue_depth_high',
                severity: 'warning',
                value: metrics.monitoring.queue.depth,
                threshold: this.config.alertThresholds.queueDepth
            });
        }
        
        // Processing time alert
        if (metrics.monitoring.queue.avgProcessingTime > this.config.alertThresholds.processingTime) {
            alerts.push({
                type: 'processing_time_high',
                severity: 'warning',
                value: metrics.monitoring.queue.avgProcessingTime,
                threshold: this.config.alertThresholds.processingTime
            });
        }
        
        // Risk violation rate
        const violationRate = metrics.timeWindows.oneMinute.orders > 0
            ? metrics.timeWindows.oneMinute.violations / metrics.timeWindows.oneMinute.orders
            : 0;
            
        if (violationRate > this.config.alertThresholds.riskViolationRate) {
            alerts.push({
                type: 'risk_violation_rate_high',
                severity: 'critical',
                value: violationRate,
                threshold: this.config.alertThresholds.riskViolationRate
            });
        }
        
        // Memory usage alert
        if (metrics.monitoring.system.memoryUsage > this.config.alertThresholds.memoryUsage) {
            alerts.push({
                type: 'memory_usage_high',
                severity: 'warning',
                value: metrics.monitoring.system.memoryUsage,
                threshold: this.config.alertThresholds.memoryUsage
            });
        }
        
        // Publish new alerts
        alerts.forEach(alert => {
            const alertKey = `${alert.type}_${alert.severity}`;
            if (!this.activeAlerts.has(alertKey)) {
                this.publishAlert(alert.type, alert);
                this.activeAlerts.add(alertKey);
            }
        });
        
        // Clear resolved alerts
        const currentAlertKeys = alerts.map(a => `${a.type}_${a.severity}`);
        this.activeAlerts.forEach(key => {
            if (!currentAlertKeys.includes(key)) {
                this.activeAlerts.delete(key);
                // Could publish alert resolution here
            }
        });
    }
    
    /**
     * Publish alert
     */
    publishAlert(type, data) {
        const alert = {
            timestamp: Date.now(),
            type,
            data,
            aggregatorId: 'main' // Could be instance ID in multi-instance setup
        };
        
        // Store alert
        this.storageClient.lpush(
            this.config.keys.alerts,
            JSON.stringify(alert)
        );
        
        // Trim to last 100 alerts
        this.storageClient.ltrim(this.config.keys.alerts, 0, 99);
        
        // Publish alert
        this.publisher.publish(
            this.config.channels.alerts,
            JSON.stringify(alert)
        );
        
        this.emit('alert', alert);
        this.log('Alert published', alert);
    }
    
    /**
     * Get top violations from map
     */
    getTopViolations(violationsMap, limit = 5) {
        const violations = Array.from(violationsMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([type, count]) => ({ type, count }));
            
        return violations;
    }
    
    /**
     * Disconnect from Redis
     */
    async disconnect() {
        this.stopPublishing();
        
        if (this.publisher) {
            this.publisher.quit();
        }
        
        if (this.storageClient) {
            this.storageClient.quit();
        }
        
        this.emit('disconnected');
        this.log('Redis metrics publisher disconnected');
    }
    
    /**
     * Log message
     */
    log(message, data = {}) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            component: 'RedisMetricsPublisher',
            message,
            ...data
        };
        console.log(JSON.stringify(logEntry));
    }
}

module.exports = RedisMetricsPublisher;