const winston = require('winston');
const path = require('path');
const fs = require('fs');

/**
 * Logger class for TSX Trading Bot V4
 * Provides structured JSON logging with multiple levels, context injection,
 * performance metrics, and error tracking
 */
class Logger {
    constructor(options = {}) {
        this.context = options.context || {};
        this.logDirectory = options.logDirectory || path.join(process.cwd(), 'logs');
        this.logLevel = options.logLevel || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
        
        // Ensure log directory exists
        this._ensureLogDirectory();
        
        // Create Winston logger instance
        this.logger = this._createLogger();
        
        // Store performance timers
        this.timers = new Map();
    }

    /**
     * Ensure log directory exists
     * @private
     */
    _ensureLogDirectory() {
        if (!fs.existsSync(this.logDirectory)) {
            fs.mkdirSync(this.logDirectory, { recursive: true });
        }
    }

    /**
     * Create Winston logger instance with file and console transports
     * @private
     */
    _createLogger() {
        const logFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
            winston.format.errors({ stack: true }),
            winston.format.json()
        );

        const consoleFormat = winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                const contextStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                return `[${timestamp}] [${level}] ${message}${contextStr}`;
            })
        );

        return winston.createLogger({
            level: this.logLevel,
            format: logFormat,
            defaultMeta: this.context,
            transports: [
                // Console transport with colored output
                new winston.transports.Console({
                    format: consoleFormat
                }),
                // File transport for all logs
                new winston.transports.File({
                    filename: path.join(this.logDirectory, 'combined.log'),
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 5,
                    tailable: true
                }),
                // Separate file for errors
                new winston.transports.File({
                    filename: path.join(this.logDirectory, 'error.log'),
                    level: 'error',
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 5,
                    tailable: true
                })
            ]
        });
    }

    /**
     * Log debug message
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     */
    debug(message, context = {}) {
        this.logger.debug(message, this._mergeContext(context));
    }

    /**
     * Log info message
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     */
    info(message, context = {}) {
        this.logger.info(message, this._mergeContext(context));
    }

    /**
     * Log warning message
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     */
    warn(message, context = {}) {
        this.logger.warn(message, this._mergeContext(context));
    }

    /**
     * Log error message with stack trace
     * @param {string} message - Log message
     * @param {Error|Object} errorOrContext - Error object or additional context
     */
    error(message, errorOrContext = {}) {
        const context = errorOrContext instanceof Error 
            ? this._serializeError(errorOrContext)
            : errorOrContext;
        
        this.logger.error(message, this._mergeContext(context));
    }

    /**
     * Create child logger with additional context
     * @param {Object} childContext - Additional context for child logger
     * @returns {Logger} New logger instance with inherited context
     */
    child(childContext = {}) {
        return new Logger({
            context: { ...this.context, ...childContext },
            logDirectory: this.logDirectory,
            logLevel: this.logLevel
        });
    }

    /**
     * Start performance timer
     * @param {string} name - Timer name
     * @param {Object} metadata - Additional metadata to log with timer
     */
    startTimer(name, metadata = {}) {
        this.timers.set(name, {
            start: Date.now(),
            metadata
        });
        
        this.debug(`Timer started: ${name}`, {
            timer: name,
            ...metadata
        });
    }

    /**
     * End performance timer and log duration
     * @param {string} name - Timer name
     * @param {Object} additionalMetadata - Additional metadata to include
     */
    endTimer(name, additionalMetadata = {}) {
        const timer = this.timers.get(name);
        if (!timer) {
            this.warn(`Timer not found: ${name}`);
            return;
        }

        const duration = Date.now() - timer.start;
        this.timers.delete(name);

        this.info(`Timer completed: ${name}`, {
            timer: name,
            duration,
            durationMs: duration,
            ...timer.metadata,
            ...additionalMetadata
        });

        return duration;
    }

    /**
     * Log performance metric
     * @param {string} metric - Metric name
     * @param {number} value - Metric value
     * @param {Object} context - Additional context
     */
    metric(metric, value, context = {}) {
        this.info(`Metric: ${metric}`, {
            metric,
            value,
            type: 'metric',
            ...context
        });
    }

    /**
     * Merge context with logger's default context
     * @private
     */
    _mergeContext(context) {
        // Remove undefined values
        const cleanContext = {};
        for (const [key, value] of Object.entries(context)) {
            if (value !== undefined) {
                cleanContext[key] = value;
            }
        }
        return cleanContext;
    }

    /**
     * Serialize error object for logging
     * @private
     */
    _serializeError(error) {
        return {
            error: {
                message: error.message,
                name: error.name,
                stack: error.stack,
                code: error.code,
                ...error // Include any custom properties
            }
        };
    }

    /**
     * Set log level dynamically
     * @param {string} level - New log level
     */
    setLevel(level) {
        this.logLevel = level;
        this.logger.level = level;
    }

    /**
     * Get current log level
     * @returns {string} Current log level
     */
    getLevel() {
        return this.logLevel;
    }

    /**
     * Flush logs and close transports
     */
    async close() {
        return new Promise((resolve) => {
            this.logger.end(() => {
                resolve();
            });
        });
    }
}

module.exports = Logger;