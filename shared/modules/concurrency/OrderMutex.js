// shared-modules/concurrency/OrderMutex.js
// Distributed Order Mutex System for Race Condition Prevention
// Prevents concurrent order placement and position management issues

const EventEmitter = require('events');

class OrderMutex extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            lockTimeout: config.lockTimeout || 30000,     // 30 seconds max lock time
            queueTimeout: config.queueTimeout || 60000,   // 60 seconds max queue wait
            maxQueueSize: config.maxQueueSize || 50,      // Max 50 queued operations
            enableMetrics: config.enableMetrics !== false,
            logLevel: config.logLevel || 'info',
            ...config
        };
        
        // Lock state
        this.locks = new Map(); // Multiple named locks (account-based, order-based, etc.)
        this.globalQueue = [];  // Global operation queue
        this.lockTimers = new Map(); // Timeout timers for locks
        
        // Statistics
        this.stats = {
            locksAcquired: 0,
            locksReleased: 0,
            lockTimeouts: 0,
            queueTimeouts: 0,
            maxQueueSize: 0,
            totalWaitTime: 0,
            averageWaitTime: 0,
            concurrentOperations: 0,
            maxConcurrentOperations: 0
        };
        
        console.log('🔒 Distributed Order Mutex initialized');
        console.log(`   Lock timeout: ${this.config.lockTimeout}ms`);
        console.log(`   Max queue size: ${this.config.maxQueueSize}`);
    }
    
    /**
     * Acquire a named lock (account-based, order-based, or global)
     */
    async acquire(lockName, identifier = 'unknown', priority = 'normal') {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            // Check queue size limits
            if (this.globalQueue.length >= this.config.maxQueueSize) {
                reject(new Error(`Queue full: ${this.globalQueue.length}/${this.config.maxQueueSize}`));
                return;
            }
            
            const lockInfo = this.locks.get(lockName);
            
            if (!lockInfo || !lockInfo.locked) {
                // Lock is available, acquire immediately
                this._acquireLock(lockName, identifier, priority);
                resolve({
                    acquired: true,
                    lockName,
                    identifier,
                    waitTime: 0,
                    queuePosition: 0
                });
            } else {
                // Lock is held, queue the request
                const queueEntry = {
                    lockName,
                    identifier,
                    priority,
                    resolve,
                    reject,
                    startTime,
                    queuedAt: Date.now()
                };
                
                // Insert based on priority (high priority goes first)
                const insertIndex = this._findQueueInsertIndex(priority);
                this.globalQueue.splice(insertIndex, 0, queueEntry);
                
                this.stats.maxQueueSize = Math.max(this.stats.maxQueueSize, this.globalQueue.length);
                
                if (this.config.logLevel === 'debug') {
                    console.log(`🔒 Queued ${identifier} for lock '${lockName}' (position: ${insertIndex + 1}/${this.globalQueue.length})`);
                }
                
                // Set queue timeout
                const queueTimeout = setTimeout(() => {
                    this._removeFromQueue(queueEntry);
                    this.stats.queueTimeouts++;
                    reject(new Error(`Queue timeout for ${identifier} on lock '${lockName}'`));
                }, this.config.queueTimeout);
                
                queueEntry.timeout = queueTimeout;
            }
        });
    }
    
    /**
     * Release a named lock
     */
    release(lockName, identifier = 'unknown') {
        const lockInfo = this.locks.get(lockName);
        
        if (!lockInfo || !lockInfo.locked) {
            console.warn(`⚠️  Attempted to release unlocked mutex '${lockName}' by ${identifier}`);
            return false;
        }
        
        if (lockInfo.holder !== identifier) {
            console.error(`❌ Lock release mismatch. Lock '${lockName}' held by '${lockInfo.holder}', release attempted by '${identifier}'`);
            return false;
        }
        
        this._releaseLock(lockName, identifier);
        return true;
    }
    
    /**
     * Try-with-resources pattern for automatic lock management
     */
    async withLock(lockName, identifier, operation, priority = 'normal') {
        let lockAcquired = false;
        
        try {
            const lockResult = await this.acquire(lockName, identifier, priority);
            lockAcquired = lockResult.acquired;
            
            if (this.config.logLevel === 'debug') {
                console.log(`🔐 Lock '${lockName}' acquired by ${identifier} (waited: ${lockResult.waitTime}ms)`);
            }
            
            // Execute the operation
            const result = await operation();
            
            return result;
            
        } finally {
            if (lockAcquired) {
                this.release(lockName, identifier);
            }
        }
    }
    
    /**
     * Acquire multiple locks atomically (prevents deadlocks by ordering)
     */
    async acquireMultiple(lockNames, identifier = 'unknown', priority = 'normal') {
        // Sort lock names to prevent deadlocks
        const sortedLockNames = [...lockNames].sort();
        const acquiredLocks = [];
        
        try {
            for (const lockName of sortedLockNames) {
                const result = await this.acquire(lockName, identifier, priority);
                acquiredLocks.push({ lockName, result });
            }
            
            return {
                success: true,
                locks: acquiredLocks,
                totalWaitTime: acquiredLocks.reduce((sum, lock) => sum + lock.result.waitTime, 0)
            };
            
        } catch (error) {
            // Release any acquired locks on failure
            for (const { lockName } of acquiredLocks) {
                this.release(lockName, identifier);
            }
            
            throw error;
        }
    }
    
    /**
     * Release multiple locks
     */
    releaseMultiple(lockNames, identifier = 'unknown') {
        const results = [];
        
        for (const lockName of lockNames) {
            const result = this.release(lockName, identifier);
            results.push({ lockName, released: result });
        }
        
        return results;
    }
    
    /**
     * Execute operation with multiple locks
     */
    async withMultipleLocks(lockNames, identifier, operation, priority = 'normal') {
        let locksAcquired = [];
        
        try {
            const lockResult = await this.acquireMultiple(lockNames, identifier, priority);
            locksAcquired = lockResult.locks.map(l => l.lockName);
            
            const result = await operation();
            return result;
            
        } finally {
            if (locksAcquired.length > 0) {
                this.releaseMultiple(locksAcquired, identifier);
            }
        }
    }
    
    /**
     * Internal: Acquire lock implementation
     */
    _acquireLock(lockName, identifier, priority) {
        const lockInfo = {
            locked: true,
            holder: identifier,
            priority,
            acquiredAt: Date.now(),
            lockName
        };
        
        this.locks.set(lockName, lockInfo);
        this.stats.locksAcquired++;
        this.stats.concurrentOperations++;
        this.stats.maxConcurrentOperations = Math.max(
            this.stats.maxConcurrentOperations, 
            this.stats.concurrentOperations
        );
        
        // Set lock timeout
        const lockTimeout = setTimeout(() => {
            console.error(`⚠️  Lock timeout for '${lockName}' held by ${identifier}. Force releasing...`);
            this.stats.lockTimeouts++;
            this._forceRelease(lockName);
        }, this.config.lockTimeout);
        
        this.lockTimers.set(lockName, lockTimeout);
        
        this.emit('lockAcquired', {
            lockName,
            holder: identifier,
            priority,
            timestamp: Date.now()
        });
    }
    
    /**
     * Internal: Release lock implementation
     */
    _releaseLock(lockName, identifier) {
        const lockInfo = this.locks.get(lockName);
        if (!lockInfo) return;
        
        // Clear timeout
        const timer = this.lockTimers.get(lockName);
        if (timer) {
            clearTimeout(timer);
            this.lockTimers.delete(lockName);
        }
        
        // Update statistics
        this.stats.locksReleased++;
        this.stats.concurrentOperations--;
        
        // Remove lock
        this.locks.delete(lockName);
        
        if (this.config.logLevel === 'debug') {
            console.log(`🔓 Lock '${lockName}' released by ${identifier}`);
        }
        
        this.emit('lockReleased', {
            lockName,
            holder: identifier,
            heldFor: Date.now() - lockInfo.acquiredAt,
            timestamp: Date.now()
        });
        
        // Process queue for this lock or any waiting operations
        this._processQueue();
    }
    
    /**
     * Force release a lock (due to timeout)
     */
    _forceRelease(lockName) {
        const lockInfo = this.locks.get(lockName);
        if (!lockInfo) return;
        
        const previousHolder = lockInfo.holder;
        
        // Clear timeout
        const timer = this.lockTimers.get(lockName);
        if (timer) {
            clearTimeout(timer);
            this.lockTimers.delete(lockName);
        }
        
        this.locks.delete(lockName);
        this.stats.concurrentOperations--;
        
        console.error(`⚠️  Force released lock '${lockName}' from ${previousHolder}`);
        
        this.emit('lockForceReleased', {
            lockName,
            previousHolder,
            queueSize: this.globalQueue.length,
            timestamp: Date.now()
        });
        
        // Process queue
        this._processQueue();
    }
    
    /**
     * Process the operation queue
     */
    _processQueue() {
        const processedEntries = [];
        
        // Find entries that can be processed now
        for (let i = 0; i < this.globalQueue.length; i++) {
            const entry = this.globalQueue[i];
            const lockInfo = this.locks.get(entry.lockName);
            
            if (!lockInfo || !lockInfo.locked) {
                // Lock is available, process this entry
                processedEntries.push({ entry, index: i });
            }
        }
        
        // Process entries (in reverse order to maintain array indices)
        for (const { entry, index } of processedEntries.reverse()) {
            this.globalQueue.splice(index, 1);
            
            // Clear timeout
            if (entry.timeout) {
                clearTimeout(entry.timeout);
            }
            
            const waitTime = Date.now() - entry.startTime;
            this.stats.totalWaitTime += waitTime;
            this.stats.averageWaitTime = this.stats.totalWaitTime / this.stats.locksAcquired;
            
            // Acquire lock
            this._acquireLock(entry.lockName, entry.identifier, entry.priority);
            
            // Resolve the promise
            entry.resolve({
                acquired: true,
                lockName: entry.lockName,
                identifier: entry.identifier,
                waitTime,
                queuePosition: index + 1
            });
        }
    }
    
    /**
     * Find queue insert index based on priority
     */
    _findQueueInsertIndex(priority) {
        if (priority === 'high') {
            // Insert at beginning of high-priority entries
            for (let i = 0; i < this.globalQueue.length; i++) {
                if (this.globalQueue[i].priority !== 'high') {
                    return i;
                }
            }
            return this.globalQueue.length;
        } else {
            // Normal and low priority go at the end
            return this.globalQueue.length;
        }
    }
    
    /**
     * Remove entry from queue
     */
    _removeFromQueue(entryToRemove) {
        const index = this.globalQueue.indexOf(entryToRemove);
        if (index > -1) {
            this.globalQueue.splice(index, 1);
            
            if (entryToRemove.timeout) {
                clearTimeout(entryToRemove.timeout);
            }
        }
    }
    
    /**
     * Check if a specific lock is held
     */
    isLocked(lockName) {
        const lockInfo = this.locks.get(lockName);
        return lockInfo ? lockInfo.locked : false;
    }
    
    /**
     * Get lock holder
     */
    getLockHolder(lockName) {
        const lockInfo = this.locks.get(lockName);
        return lockInfo ? lockInfo.holder : null;
    }
    
    /**
     * Get all active locks
     */
    getActiveLocks() {
        const locks = {};
        for (const [lockName, lockInfo] of this.locks.entries()) {
            locks[lockName] = {
                holder: lockInfo.holder,
                priority: lockInfo.priority,
                acquiredAt: lockInfo.acquiredAt,
                heldFor: Date.now() - lockInfo.acquiredAt
            };
        }
        return locks;
    }
    
    /**
     * Get queue status
     */
    getQueueStatus() {
        return {
            size: this.globalQueue.length,
            entries: this.globalQueue.map((entry, index) => ({
                position: index + 1,
                lockName: entry.lockName,
                identifier: entry.identifier,
                priority: entry.priority,
                waitTime: Date.now() - entry.queuedAt
            }))
        };
    }
    
    /**
     * Get comprehensive statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            activeLocks: this.locks.size,
            queueSize: this.globalQueue.length,
            activeOperations: this.stats.concurrentOperations,
            efficiency: {
                successRate: this.stats.locksAcquired > 0 
                    ? ((this.stats.locksAcquired - this.stats.lockTimeouts) / this.stats.locksAcquired * 100).toFixed(2) + '%'
                    : '0%',
                avgWaitTime: this.stats.averageWaitTime.toFixed(2) + 'ms',
                timeoutRate: this.stats.locksAcquired > 0
                    ? ((this.stats.lockTimeouts + this.stats.queueTimeouts) / this.stats.locksAcquired * 100).toFixed(2) + '%'
                    : '0%'
            }
        };
    }
    
    /**
     * Check system health
     */
    isHealthy() {
        const timeoutRate = this.stats.locksAcquired > 0 
            ? (this.stats.lockTimeouts + this.stats.queueTimeouts) / this.stats.locksAcquired 
            : 0;
            
        const queueUtilization = this.globalQueue.length / this.config.maxQueueSize;
        
        return {
            healthy: timeoutRate < 0.05 && queueUtilization < 0.8, // <5% timeout rate, <80% queue usage
            issues: [
                ...(timeoutRate >= 0.05 ? [`High timeout rate: ${(timeoutRate * 100).toFixed(1)}%`] : []),
                ...(queueUtilization >= 0.8 ? [`High queue utilization: ${(queueUtilization * 100).toFixed(1)}%`] : []),
                ...(this.stats.averageWaitTime > 5000 ? [`High average wait time: ${this.stats.averageWaitTime.toFixed(0)}ms`] : [])
            ],
            metrics: {
                timeoutRate: (timeoutRate * 100).toFixed(2) + '%',
                queueUtilization: (queueUtilization * 100).toFixed(1) + '%',
                avgWaitTime: this.stats.averageWaitTime.toFixed(0) + 'ms'
            }
        };
    }
    
    /**
     * Reset all locks and clear queue (emergency use)
     */
    reset() {
        console.warn('🔄 Resetting OrderMutex - clearing all locks and queue');
        
        // Clear all lock timers
        for (const timer of this.lockTimers.values()) {
            clearTimeout(timer);
        }
        
        // Reject all queued operations
        for (const entry of this.globalQueue) {
            if (entry.timeout) {
                clearTimeout(entry.timeout);
            }
            entry.reject(new Error('OrderMutex reset'));
        }
        
        // Clear state
        this.locks.clear();
        this.lockTimers.clear();
        this.globalQueue = [];
        this.stats.concurrentOperations = 0;
        
        this.emit('reset', { timestamp: Date.now() });
    }
}

module.exports = OrderMutex;