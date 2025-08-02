/**
 * EventBus - Internal pub/sub system for TSX Trading Bot V4
 * Provides decoupled communication between modules
 */
class EventBus {
  constructor() {
    this.handlers = new Map(); // event -> Set of handlers
    this.wildcardHandlers = new Map(); // wildcard pattern -> Set of handlers
    this.eventHistory = []; // circular buffer for last 100 events
    this.maxHistorySize = 100;
    this.deadLetterQueue = [];
    this.maxDeadLetterSize = 50;
    this.metrics = new Map(); // event type -> metrics
    this.isShuttingDown = false;
  }

  /**
   * Register an event handler
   * @param {string} eventPattern - Event name or pattern (e.g., 'order.*')
   * @param {Function} handler - Callback function
   * @param {Object} options - Handler options
   * @returns {Function} Unsubscribe function
   */
  on(eventPattern, handler, options = {}) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    const handlerWrapper = {
      handler,
      options,
      pattern: eventPattern,
      id: this._generateHandlerId()
    };

    if (eventPattern.includes('*')) {
      // Wildcard pattern
      if (!this.wildcardHandlers.has(eventPattern)) {
        this.wildcardHandlers.set(eventPattern, new Set());
      }
      this.wildcardHandlers.get(eventPattern).add(handlerWrapper);
    } else {
      // Exact match
      if (!this.handlers.has(eventPattern)) {
        this.handlers.set(eventPattern, new Set());
      }
      this.handlers.get(eventPattern).add(handlerWrapper);
    }

    // Return unsubscribe function
    return () => this.off(eventPattern, handlerWrapper);
  }

  /**
   * Register a one-time event handler
   * @param {string} eventPattern - Event name or pattern
   * @param {Function} handler - Callback function
   * @returns {Function} Unsubscribe function
   */
  once(eventPattern, handler) {
    const wrappedHandler = (...args) => {
      handler(...args);
      this.off(eventPattern, wrappedHandler);
    };
    return this.on(eventPattern, wrappedHandler);
  }

  /**
   * Remove an event handler
   * @param {string} eventPattern - Event name or pattern
   * @param {Object} handlerWrapper - Handler wrapper to remove
   */
  off(eventPattern, handlerWrapper) {
    if (eventPattern.includes('*')) {
      const handlers = this.wildcardHandlers.get(eventPattern);
      if (handlers) {
        handlers.delete(handlerWrapper);
        if (handlers.size === 0) {
          this.wildcardHandlers.delete(eventPattern);
        }
      }
    } else {
      const handlers = this.handlers.get(eventPattern);
      if (handlers) {
        handlers.delete(handlerWrapper);
        if (handlers.size === 0) {
          this.handlers.delete(eventPattern);
        }
      }
    }
  }

  /**
   * Emit an event
   * @param {string} eventName - Event name
   * @param {*} data - Event data
   * @returns {Promise<Object>} Emission result
   */
  async emit(eventName, data = {}) {
    if (this.isShuttingDown) {
      return { success: false, error: 'EventBus is shutting down' };
    }

    const event = {
      name: eventName,
      data,
      timestamp: Date.now(),
      id: this._generateEventId()
    };

    // Add to history
    this._addToHistory(event);

    // Update metrics
    this._updateMetrics(eventName, 'emitted');

    // Get all matching handlers
    const matchingHandlers = this._getMatchingHandlers(eventName);
    
    if (matchingHandlers.length === 0) {
      return { success: true, handled: false, handlers: 0 };
    }

    const results = await Promise.allSettled(
      matchingHandlers.map(handlerWrapper => 
        this._executeHandler(handlerWrapper, event)
      )
    );

    const errors = results.filter(r => r.status === 'rejected');
    const successes = results.filter(r => r.status === 'fulfilled');

    return {
      success: errors.length === 0,
      handled: true,
      handlers: matchingHandlers.length,
      succeeded: successes.length,
      failed: errors.length,
      errors: errors.map(e => e.reason)
    };
  }

  /**
   * Emit an event synchronously
   * @param {string} eventName - Event name
   * @param {*} data - Event data
   * @returns {Object} Emission result
   */
  emitSync(eventName, data = {}) {
    if (this.isShuttingDown) {
      return { success: false, error: 'EventBus is shutting down' };
    }

    const event = {
      name: eventName,
      data,
      timestamp: Date.now(),
      id: this._generateEventId()
    };

    // Add to history
    this._addToHistory(event);

    // Update metrics
    this._updateMetrics(eventName, 'emitted');

    // Get all matching handlers
    const matchingHandlers = this._getMatchingHandlers(eventName);
    
    if (matchingHandlers.length === 0) {
      return { success: true, handled: false, handlers: 0 };
    }

    const errors = [];
    let succeeded = 0;

    for (const handlerWrapper of matchingHandlers) {
      try {
        const result = handlerWrapper.handler(event.data, event);
        if (result instanceof Promise) {
          console.warn(`Sync handler returned Promise for event: ${eventName}`);
        }
        succeeded++;
      } catch (error) {
        errors.push(error);
        this._handleError(handlerWrapper, event, error);
      }
    }

    return {
      success: errors.length === 0,
      handled: true,
      handlers: matchingHandlers.length,
      succeeded,
      failed: errors.length,
      errors
    };
  }

  /**
   * Get event history
   * @param {string} eventPattern - Optional pattern to filter by
   * @returns {Array} Event history
   */
  getHistory(eventPattern = null) {
    if (!eventPattern) {
      return [...this.eventHistory];
    }

    return this.eventHistory.filter(event => 
      this._matchesPattern(event.name, eventPattern)
    );
  }

  /**
   * Get dead letter queue
   * @returns {Array} Failed events
   */
  getDeadLetterQueue() {
    return [...this.deadLetterQueue];
  }

  /**
   * Get metrics for event types
   * @param {string} eventType - Optional event type to filter by
   * @returns {Object} Metrics
   */
  getMetrics(eventType = null) {
    if (eventType) {
      return this.metrics.get(eventType) || this._createMetrics();
    }

    const allMetrics = {};
    for (const [type, metrics] of this.metrics) {
      allMetrics[type] = { ...metrics };
    }
    return allMetrics;
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.eventHistory = [];
  }

  /**
   * Clear dead letter queue
   */
  clearDeadLetterQueue() {
    this.deadLetterQueue = [];
  }

  /**
   * Reset all metrics
   */
  resetMetrics() {
    this.metrics.clear();
  }

  /**
   * Remove all handlers
   */
  removeAllHandlers() {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /**
   * Shutdown the event bus
   */
  async shutdown() {
    this.isShuttingDown = true;
    
    // Emit shutdown event
    await this.emit('eventbus.shutdown');
    
    // Clear all handlers
    this.removeAllHandlers();
    
    // Clear history and queues
    this.clearHistory();
    this.clearDeadLetterQueue();
    this.resetMetrics();
  }

  // Private methods

  _getMatchingHandlers(eventName) {
    const handlers = [];

    // Exact match handlers
    if (this.handlers.has(eventName)) {
      handlers.push(...this.handlers.get(eventName));
    }

    // Wildcard handlers
    for (const [pattern, wildcardHandlers] of this.wildcardHandlers) {
      if (this._matchesPattern(eventName, pattern)) {
        handlers.push(...wildcardHandlers);
      }
    }

    return handlers;
  }

  _matchesPattern(eventName, pattern) {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(eventName);
  }

  async _executeHandler(handlerWrapper, event) {
    const { handler, options } = handlerWrapper;
    const startTime = Date.now();

    try {
      // Apply timeout if specified
      if (options.timeout) {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Handler timeout')), options.timeout)
        );
        await Promise.race([
          handler(event.data, event),
          timeoutPromise
        ]);
      } else {
        await handler(event.data, event);
      }

      // Update metrics
      this._updateMetrics(event.name, 'handled', Date.now() - startTime);
    } catch (error) {
      this._handleError(handlerWrapper, event, error);
      throw error;
    }
  }

  _handleError(handlerWrapper, event, error) {
    // Update metrics
    this._updateMetrics(event.name, 'error');

    // Add to dead letter queue
    this._addToDeadLetterQueue({
      event,
      handler: {
        pattern: handlerWrapper.pattern,
        id: handlerWrapper.id
      },
      error: {
        message: error.message,
        stack: error.stack
      },
      timestamp: Date.now()
    });

    // Emit error event
    this.emit('eventbus.error', {
      event,
      handlerPattern: handlerWrapper.pattern,
      error
    });
  }

  _addToHistory(event) {
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }
  }

  _addToDeadLetterQueue(failedEvent) {
    this.deadLetterQueue.push(failedEvent);
    if (this.deadLetterQueue.length > this.maxDeadLetterSize) {
      this.deadLetterQueue.shift();
    }
  }

  _updateMetrics(eventType, action, duration = null) {
    if (!this.metrics.has(eventType)) {
      this.metrics.set(eventType, this._createMetrics());
    }

    const metrics = this.metrics.get(eventType);
    
    switch (action) {
      case 'emitted':
        metrics.emitted++;
        metrics.lastEmitted = Date.now();
        break;
      case 'handled':
        metrics.handled++;
        if (duration !== null) {
          metrics.totalDuration += duration;
          metrics.avgDuration = metrics.totalDuration / metrics.handled;
          if (duration > metrics.maxDuration) {
            metrics.maxDuration = duration;
          }
          if (duration < metrics.minDuration) {
            metrics.minDuration = duration;
          }
        }
        break;
      case 'error':
        metrics.errors++;
        break;
    }
  }

  _createMetrics() {
    return {
      emitted: 0,
      handled: 0,
      errors: 0,
      totalDuration: 0,
      avgDuration: 0,
      minDuration: Infinity,
      maxDuration: 0,
      lastEmitted: null
    };
  }

  _generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  _generateHandlerId() {
    return `hdl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = EventBus;