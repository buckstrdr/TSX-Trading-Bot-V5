/**
 * QueueManager - Manages prioritized order queuing and processing
 * Handles order sequencing, priority management, and throttling
 */

const EventEmitter = require('events');

class QueueManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Queue settings
            maxQueueSize: config.maxQueueSize || 1000,
            processingInterval: config.processingInterval || 100, // ms
            maxConcurrentOrders: config.maxConcurrentOrders || 5,
            
            // Priority weights
            priorityWeights: {
                marketOrder: config.marketOrderPriority || 10,
                stopLoss: config.stopLossPriority || 9,
                takeProfit: config.takeProfitPriority || 7,
                limitOrder: config.limitOrderPriority || 5,
                modification: config.modificationPriority || 8,
                cancellation: config.cancellationPriority || 8
            },
            
            // Throttling
            maxOrdersPerSecond: config.maxOrdersPerSecond || 10,
            burstLimit: config.burstLimit || 20,
            
            // Shadow mode
            // REMOVED: Shadow mode - Always enforce queue processing
        };
        
        // Queue state
        this.queues = {
            high: [],    // Priority 8-10
            medium: [],  // Priority 5-7
            low: []      // Priority 0-4
        };
        
        this.processing = false;
        this.activeOrders = new Map();
        this.orderHistory = [];
        
        // Throttling state
        this.throttle = {
            tokens: this.config.burstLimit,
            lastRefill: Date.now()
        };
        
        // Start processing loop
        this.startProcessing();
    }
    
    /**
     * Add order to queue with priority calculation
     */
    enqueue(order) {
        if (this.getTotalQueueSize() >= this.config.maxQueueSize) {
            this.emit('queueFull', { order, queueSize: this.getTotalQueueSize() });
            return {
                success: false,
                reason: 'QUEUE_FULL',
                queueSize: this.getTotalQueueSize()
            };
        }
        
        // Calculate priority
        const priority = this.calculatePriority(order);
        order.priority = priority;
        order.queuedAt = new Date();
        order.queueId = this.generateQueueId();
        
        // Add to appropriate queue
        if (priority >= 8) {
            this.queues.high.push(order);
        } else if (priority >= 5) {
            this.queues.medium.push(order);
        } else {
            this.queues.low.push(order);
        }
        
        // Sort queue by priority (descending)
        this.sortQueue(priority >= 8 ? 'high' : priority >= 5 ? 'medium' : 'low');
        
        this.emit('orderQueued', {
            order,
            priority,
            queueSize: this.getTotalQueueSize(),
            position: this.getQueuePosition(order.queueId)
        });
        
        return {
            success: true,
            queueId: order.queueId,
            priority,
            estimatedProcessingTime: this.estimateProcessingTime(order)
        };
    }
    
    /**
     * Calculate order priority based on type and urgency
     */
    calculatePriority(order) {
        let priority = 5; // Base priority
        
        // Order type priority
        if (order.type === 'MARKET') {
            priority = this.config.priorityWeights.marketOrder;
        } else if (order.type === 'STOP_LOSS' || order.isStopLoss) {
            priority = this.config.priorityWeights.stopLoss;
        } else if (order.type === 'TAKE_PROFIT' || order.isTakeProfit) {
            priority = this.config.priorityWeights.takeProfit;
        } else if (order.action === 'MODIFY') {
            priority = this.config.priorityWeights.modification;
        } else if (order.action === 'CANCEL') {
            priority = this.config.priorityWeights.cancellation;
        } else if (order.type === 'LIMIT') {
            priority = this.config.priorityWeights.limitOrder;
        }
        
        // Urgency modifiers
        if (order.urgent) priority += 2;
        if (order.source === 'MANUAL') priority += 1;
        if (order.retryCount > 0) priority += 1;
        
        // Cap priority at 10
        return Math.min(priority, 10);
    }
    
    /**
     * Process orders from queues
     */
    async processQueues() {
        if (this.processing || this.activeOrders.size >= this.config.maxConcurrentOrders) {
            return;
        }
        
        this.processing = true;
        
        try {
            // Refill throttle tokens
            this.refillThrottleTokens();
            
            // Process orders by priority
            const order = this.getNextOrder();
            
            if (order && this.canProcessOrder()) {
                await this.processOrder(order);
            }
        } catch (error) {
            console.error('Queue processing error:', error);
            this.emit('processingError', { error });
        } finally {
            this.processing = false;
        }
    }
    
    /**
     * Get next order from queues (highest priority first)
     */
    getNextOrder() {
        if (this.queues.high.length > 0) {
            return this.queues.high.shift();
        } else if (this.queues.medium.length > 0) {
            return this.queues.medium.shift();
        } else if (this.queues.low.length > 0) {
            return this.queues.low.shift();
        }
        return null;
    }
    
    /**
     * Process a single order
     */
    async processOrder(order) {
        const processingStart = Date.now();
        
        // Consume throttle token
        this.throttle.tokens--;
        
        // Track active order
        this.activeOrders.set(order.queueId, {
            order,
            startTime: processingStart
        });
        
        try {
            // In shadow mode, simulate processing
            
            // Emit for actual processing by aggregator
            this.emit('processOrder', {
                order,
                queueMetrics: {
                    waitTime: processingStart - order.queuedAt.getTime(),
                    queueSize: this.getTotalQueueSize(),
                    activeOrders: this.activeOrders.size
                }
            });
            
            // Record in history
            this.orderHistory.push({
                ...order,
                processedAt: new Date(),
                processingTime: Date.now() - processingStart,
                waitTime: processingStart - order.queuedAt.getTime()
            });
            
        } catch (error) {
            this.emit('orderProcessingFailed', { order, error });
            
            // Retry logic
            if (order.retryCount < 3) {
                order.retryCount = (order.retryCount || 0) + 1;
                this.enqueue(order); // Re-queue with higher priority
            }
        } finally {
            this.activeOrders.delete(order.queueId);
        }
    }
    
    /**
     * Simulate processing delay in shadow mode
     */
    async simulateProcessing(order) {
        const baseDelay = 50;
        const variableDelay = Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, baseDelay + variableDelay));
    }
    
    /**
     * Check if we can process another order (throttling)
     */
    canProcessOrder() {
        return this.throttle.tokens > 0;
    }
    
    /**
     * Refill throttle tokens
     */
    refillThrottleTokens() {
        const now = Date.now();
        const elapsed = now - this.throttle.lastRefill;
        const tokensToAdd = Math.floor(elapsed / 1000 * this.config.maxOrdersPerSecond);
        
        if (tokensToAdd > 0) {
            this.throttle.tokens = Math.min(
                this.throttle.tokens + tokensToAdd,
                this.config.burstLimit
            );
            this.throttle.lastRefill = now;
        }
    }
    
    /**
     * Sort queue by priority
     */
    sortQueue(queueName) {
        this.queues[queueName].sort((a, b) => b.priority - a.priority);
    }
    
    /**
     * Get total queue size
     */
    getTotalQueueSize() {
        return this.queues.high.length + this.queues.medium.length + this.queues.low.length;
    }
    
    /**
     * Get queue position for an order
     */
    getQueuePosition(queueId) {
        let position = 0;
        
        for (const queue of ['high', 'medium', 'low']) {
            for (let i = 0; i < this.queues[queue].length; i++) {
                position++;
                if (this.queues[queue][i].queueId === queueId) {
                    return position;
                }
            }
        }
        
        return -1;
    }
    
    /**
     * Estimate processing time for an order
     */
    estimateProcessingTime(order) {
        const queuePosition = this.getQueuePosition(order.queueId);
        const activeOrders = this.activeOrders.size;
        const avgProcessingTime = this.getAverageProcessingTime();
        
        return {
            estimatedMs: (queuePosition + activeOrders) * avgProcessingTime,
            queuePosition,
            activeOrders
        };
    }
    
    /**
     * Get average processing time from history
     */
    getAverageProcessingTime() {
        if (this.orderHistory.length === 0) return 100;
        
        const recent = this.orderHistory.slice(-20);
        const totalTime = recent.reduce((sum, order) => sum + order.processingTime, 0);
        
        return totalTime / recent.length;
    }
    
    /**
     * Remove order from queue
     */
    removeFromQueue(queueId) {
        for (const queue of ['high', 'medium', 'low']) {
            const index = this.queues[queue].findIndex(o => o.queueId === queueId);
            if (index !== -1) {
                const removed = this.queues[queue].splice(index, 1)[0];
                this.emit('orderRemoved', { order: removed, queue });
                return removed;
            }
        }
        return null;
    }
    
    /**
     * Clear all queues
     */
    clearQueues() {
        const totalCleared = this.getTotalQueueSize();
        this.queues.high = [];
        this.queues.medium = [];
        this.queues.low = [];
        this.emit('queuesCleared', { totalCleared });
    }
    
    /**
     * Get queue metrics
     */
    getMetrics() {
        return {
            queues: {
                high: this.queues.high.length,
                medium: this.queues.medium.length,
                low: this.queues.low.length,
                total: this.getTotalQueueSize()
            },
            processing: {
                active: this.activeOrders.size,
                maxConcurrent: this.config.maxConcurrentOrders,
                avgProcessingTime: this.getAverageProcessingTime()
            },
            throttle: {
                tokens: this.throttle.tokens,
                maxTokens: this.config.burstLimit,
                ordersPerSecond: this.config.maxOrdersPerSecond
            },
            history: {
                processed: this.orderHistory.length,
                avgWaitTime: this.getAverageWaitTime()
            }
        };
    }
    
    /**
     * Get average wait time from history
     */
    getAverageWaitTime() {
        if (this.orderHistory.length === 0) return 0;
        
        const recent = this.orderHistory.slice(-20);
        const totalWait = recent.reduce((sum, order) => sum + order.waitTime, 0);
        
        return totalWait / recent.length;
    }
    
    /**
     * Start processing loop
     */
    startProcessing() {
        this.processingInterval = setInterval(() => {
            this.processQueues();
        }, this.config.processingInterval);
    }
    
    /**
     * Stop processing
     */
    stopProcessing() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
    }
    
    /**
     * Generate unique queue ID
     */
    generateQueueId() {
        return `Q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

module.exports = QueueManager;