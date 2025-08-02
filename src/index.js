/**
 * TSX Trading Bot V4 - Main Entry Point (JavaScript)
 * This file serves as the CommonJS entry point for the application
 */

const { ConfigurationManager } = require('./infrastructure/config/ConfigurationManager');
const { Logger } = require('./infrastructure/logging/Logger');
const { RedisConnectionManager } = require('./infrastructure/redis/RedisConnectionManager');
const { EventBus } = require('./infrastructure/events/EventBus');

const logger = new Logger({ component: 'Main' });

async function startApplication() {
  try {
    logger.info('Starting TSX Trading Bot V4...');

    // Initialize configuration
    const configManager = ConfigurationManager.getInstance();
    const config = await configManager.getGlobalConfig();
    logger.info('Configuration loaded successfully');

    // Initialize Redis
    const redisManager = new RedisConnectionManager();
    await redisManager.connect();
    logger.info('Redis connection established');

    // Initialize Event Bus
    const eventBus = new EventBus();
    logger.info('Event bus initialized');

    // Setup health check endpoint
    if (process.env.NODE_ENV !== 'test') {
      setupHealthCheck();
    }

    logger.info('TSX Trading Bot V4 started successfully');
  } catch (error) {
    logger.error('Failed to start application', { error });
    process.exit(1);
  }
}

function setupHealthCheck() {
  const http = require('http');
  const port = process.env.HEALTH_CHECK_PORT || 3000;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '4.0.0',
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info(`Health check endpoint listening on port ${port}`);
  });
}

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the application
startApplication().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});

module.exports = { startApplication };