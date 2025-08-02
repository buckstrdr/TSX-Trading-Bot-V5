/**
 * Order Mutex - Race Condition Prevention for SL/TP Orders
 * Implements order-level locking and idempotency keys
 */

const crypto = require('crypto');

class OrderMutex {
    constructor(options = {}) {
        this.locks = new Map(); // orderId -> { locked: boolean, lockId: string, lockedAt: timestamp, ttl: number }
        this.idempotencyCache = new Map(); // key -> result
        this.lockTTL = options.lockTTL || 30000; // 30 seconds default TTL
        this.cleanupInterval = options.cleanupInterval || 10000; // 10 seconds cleanup interval
        
        // Start automatic cleanup of expired locks
        this.startCleanupTimer();
    }

    /**
     * Acquire a lock for a specific order ID
     */
    async acquireLock(orderId, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const lockId = crypto.randomUUID();

            const tryAcquire = () => {
                const existingLock = this.locks.get(orderId);
                
                // Check if existing lock is expired
                if (existingLock && (Date.now() - existingLock.lockedAt) > this.lockTTL) {
                    this.locks.delete(orderId);
                }

                // Try to acquire lock
                if (!this.locks.has(orderId) || !this.locks.get(orderId).locked) {
                    this.locks.set(orderId, {
                        locked: true,
                        lockId: lockId,
                        lockedAt: Date.now(),
                        ttl: this.lockTTL
                    });
                    resolve(true);
                    return;
                }

                // Check timeout
                if (Date.now() - startTime >= timeout) {
                    reject(new Error('Lock timeout'));
                    return;
                }

                // Retry after a short delay
                setTimeout(tryAcquire, 10);
            };

            tryAcquire();
        });
    }

    /**
     * Try to acquire lock without waiting
     */
    async tryAcquireLock(orderId) {
        const existingLock = this.locks.get(orderId);
        
        // Check if existing lock is expired
        if (existingLock && (Date.now() - existingLock.lockedAt) > this.lockTTL) {
            this.locks.delete(orderId);
        }

        // Try to acquire lock
        if (!this.locks.has(orderId) || !this.locks.get(orderId).locked) {
            const lockId = crypto.randomUUID();
            this.locks.set(orderId, {
                locked: true,
                lockId: lockId,
                lockedAt: Date.now(),
                ttl: this.lockTTL
            });
            return true;
        }

        return false;
    }

    /**
     * Release a lock for a specific order ID
     */
    async releaseLock(orderId) {
        if (this.locks.has(orderId)) {
            this.locks.delete(orderId);
            return true;
        }
        return false;
    }

    /**
     * Generate idempotency key for preventing duplicate operations
     */
    generateIdempotencyKey(orderId, operation) {
        return crypto.createHash('sha256')
            .update(`${orderId}:${operation}`)
            .digest('hex');
    }

    /**
     * Execute operation only once using idempotency key
     */
    async executeOnce(idempotencyKey, operation) {
        // Check if we've already executed this operation
        if (this.idempotencyCache.has(idempotencyKey)) {
            return this.idempotencyCache.get(idempotencyKey);
        }

        // Execute the operation
        const result = await operation();
        
        // Cache the result
        this.idempotencyCache.set(idempotencyKey, result);
        
        return result;
    }

    /**
     * Get lock status for an order ID
     */
    getLockStatus(orderId) {
        const lock = this.locks.get(orderId);
        
        if (!lock) {
            return { locked: false };
        }

        // Check if expired
        if ((Date.now() - lock.lockedAt) > this.lockTTL) {
            this.locks.delete(orderId);
            return { locked: false };
        }

        return {
            locked: lock.locked,
            lockId: lock.lockId,
            lockedAt: lock.lockedAt,
            ttl: this.lockTTL
        };
    }

    /**
     * Start automatic cleanup of expired locks
     */
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [orderId, lock] of this.locks.entries()) {
                if ((now - lock.lockedAt) > this.lockTTL) {
                    this.locks.delete(orderId);
                }
            }
        }, this.cleanupInterval);
    }

    /**
     * Stop cleanup timer and clean up resources
     */
    cleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.locks.clear();
        this.idempotencyCache.clear();
    }
}

module.exports = OrderMutex;