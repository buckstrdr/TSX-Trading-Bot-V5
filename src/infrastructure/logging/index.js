const Logger = require('./Logger');

// Create a default logger instance
const defaultLogger = new Logger({
    context: {
        service: 'TSX_TRADING_BOT_V4',
        version: '4.0.0',
        environment: process.env.NODE_ENV || 'development'
    }
});

// Export both the class and a default instance
module.exports = {
    Logger,
    logger: defaultLogger
};