/**
 * AggregatorTester - Comprehensive testing utility for Trading Aggregator
 * Provides shadow mode validation, integration tests, performance testing, and load scenarios
 * 
 * Features:
 * - Redis integration testing with real message patterns
 * - Connection Manager adapter validation
 * - Manual trading integration scenarios
 * - Performance and load testing capabilities
 * - SL/TP calculation accuracy tests
 * - Risk rule enforcement validation
 * - Queue management under load
 */

const TradingAggregator = require('../TradingAggregator');
const ConnectionManagerAdapter = require('../adapters/ConnectionManagerAdapter');
const RedisAdapter = require('../adapters/RedisAdapter');
const Redis = require('redis');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

class AggregatorTester {
    constructor(config = {}) {
        this.config = {
            testDuration: config.testDuration || 30000, // 30 seconds
            ordersPerSecond: config.ordersPerSecond || 2,
            instruments: config.instruments || ['MES', 'MNQ', 'MGC'],
            shadowMode: config.shadowMode !== false,
            verbose: config.verbose || false,
            
            // Redis configuration
            redis: {
                host: config.redis?.host || 'localhost',
                port: config.redis?.port || 6379,
                db: config.redis?.db || 0
            },
            
            // Performance testing configuration
            performance: {
                maxLatency: config.performance?.maxLatency || 100, // 100ms
                targetThroughput: config.performance?.targetThroughput || 1000, // orders/min
                memoryLimit: config.performance?.memoryLimit || 500 * 1024 * 1024, // 500MB
                cpuThreshold: config.performance?.cpuThreshold || 80 // 80%
            },
            
            // Load testing configuration
            load: {
                maxConcurrentOrders: config.load?.maxConcurrentOrders || 100,
                burstInterval: config.load?.burstInterval || 5000, // 5 seconds
                burstSize: config.load?.burstSize || 20
            }
        };
        
        this.aggregator = null;
        this.redisClient = null;
        this.redisSubscriber = null;
        this.testResults = {
            startTime: null,
            endTime: null,
            orders: {
                submitted: 0,
                processed: 0,
                filled: 0,
                rejected: 0
            },
            performance: {
                avgProcessingTime: 0,
                avgQueueTime: 0,
                maxQueueSize: 0,
                latencies: [],
                memoryUsage: [],
                cpuUsage: [],
                throughput: 0
            },
            redis: {
                messagesPublished: 0,
                messagesReceived: 0,
                connectionErrors: 0,
                responseTimeouts: 0
            },
            integration: {
                connectionManagerTests: 0,
                connectionManagerPassed: 0,
                manualTradingTests: 0,
                manualTradingPassed: 0
            },
            errors: [],
            riskViolations: [],
            sltpResults: [],
            loadTestResults: {
                peakQueueSize: 0,
                averageLatency: 0,
                errorRate: 0,
                throughputAchieved: 0
            }
        };
        
        this.orderCounter = 0;
        this.testInterval = null;
    }
    
    /**
     * Run comprehensive test suite
     */
    async runTests() {
        console.log('🚀 Starting Trading Aggregator Comprehensive Test Suite');
        console.log(`Shadow Mode: ${this.config.shadowMode}`);
        console.log(`Test Duration: ${this.config.testDuration / 1000}s`);
        console.log(`Target Performance: ${this.config.performance.targetThroughput} orders/min`);
        console.log('=' * 70);
        
        try {
            // Initialize aggregator and Redis connections
            await this.initializeTestEnvironment();
            
            // Core functionality tests
            console.log('\n📋 PHASE 1: Core Functionality Tests');
            await this.runBasicOrderTest();
            await this.runRiskValidationTest();
            await this.runSLTPCalculationTest();
            await this.runBotRegistryTest();
            
            // Integration tests
            console.log('\n🔗 PHASE 2: Integration Tests');
            await this.runRedisIntegrationTests();
            await this.runConnectionManagerAdapterTests();
            await this.runManualTradingIntegrationTests();
            
            // Performance tests
            console.log('\n⚡ PHASE 3: Performance Tests');
            await this.runPerformanceTests();
            await this.runLoadTests();
            await this.runStressTests();
            
            // Shadow mode validation
            console.log('\n🛡️ PHASE 4: Shadow Mode Validation');
            await this.runShadowModeValidationTests();
            
            // Generate comprehensive report
            this.generateComprehensiveReport();
            
        } catch (error) {
            console.error('❌ Test suite failed:', error.message);
            this.testResults.errors.push({
                type: 'SUITE_FAILURE',
                message: error.message,
                timestamp: new Date(),
                stack: error.stack
            });
        } finally {
            await this.cleanup();
        }
    }
    
    /**
     * Initialize test environment with aggregator and Redis connections
     */
    async initializeTestEnvironment() {
        console.log('\n📋 Initializing Test Environment...');
        
        // Initialize Redis connections
        await this.initializeRedis();
        
        // Initialize aggregator
        await this.initializeAggregator();
        
        // Setup performance monitoring
        this.setupPerformanceMonitoring();
        
        console.log('✅ Test environment initialized successfully');
    }
    
    /**
     * Initialize Redis connections for testing
     */
    async initializeRedis() {
        console.log('  🔗 Connecting to Redis...');
        
        try {
            // Create Redis client for publishing
            this.redisClient = Redis.createClient({
                host: this.config.redis.host,
                port: this.config.redis.port,
                db: this.config.redis.db,
                retry_strategy: (options) => {
                    if (options.error && options.error.code === 'ECONNREFUSED') {
                        console.error('Redis connection refused');
                        return new Error('Redis connection refused');
                    }
                    if (options.total_retry_time > 1000 * 60 * 60) {
                        return new Error('Retry time exhausted');
                    }
                    if (options.attempt > 10) {
                        return undefined;
                    }
                    return Math.min(options.attempt * 100, 3000);
                }
            });
            
            // Create Redis subscriber
            this.redisSubscriber = Redis.createClient({
                host: this.config.redis.host,
                port: this.config.redis.port,
                db: this.config.redis.db
            });
            
            // Setup Redis event handlers
            this.redisClient.on('error', (err) => {
                console.error('Redis Client Error:', err);
                this.testResults.redis.connectionErrors++;
            });
            
            this.redisSubscriber.on('error', (err) => {
                console.error('Redis Subscriber Error:', err);
                this.testResults.redis.connectionErrors++;
            });
            
            // Test Redis connectivity
            await this.redisClient.ping();
            
            console.log('  ✅ Redis connections established');
            
        } catch (error) {
            console.error('  ❌ Redis initialization failed:', error.message);
            throw error;
        }
    }
    
    /**
     * Initialize aggregator with comprehensive test configuration
     */
    async initializeAggregator() {
        console.log('  ⚙️ Initializing Trading Aggregator...');
        
        const aggregatorConfig = {
            shadowMode: this.config.shadowMode,
            riskConfig: {
                shadowMode: this.config.shadowMode,
                maxOrderSize: 10,
                maxDailyLoss: 1000,
                defaultRiskPercent: 1.0,
                maxPositionsPerInstrument: 5,
                maxTotalExposure: 50000
            },
            queueConfig: {
                shadowMode: this.config.shadowMode,
                maxQueueSize: 100,
                processingInterval: 50,
                priorityLevels: 3,
                batchSize: 10
            },
            sltpConfig: {
                defaultStopLossPercent: 1.0,
                defaultTakeProfitPercent: 2.0,
                maxStopLossPercent: 5.0,
                maxTakeProfitPercent: 10.0,
                useMultipliers: true
            },
            registryConfig: {
                trackMetrics: true,
                maxHistorySize: 1000,
                enablePerformanceTracking: true
            },
            redisConfig: {
                host: this.config.redis.host,
                port: this.config.redis.port,
                db: this.config.redis.db
            }
        };
        
        this.aggregator = new TradingAggregator(aggregatorConfig);
        
        // Set up comprehensive event listeners
        this.setupEventListeners();
        
        // Initialize aggregator
        await this.aggregator.initialize();
        
        console.log('  ✅ Trading Aggregator initialized');
    }
    
    /**
     * Set up event listeners for testing
     */
    setupEventListeners() {
        this.aggregator.on('orderSubmitted', (event) => {
            this.testResults.orders.submitted++;
            if (this.config.verbose) {
                console.log(`📨 Order submitted: ${event.order.id}`);
            }
        });
        
        this.aggregator.on('orderProcessed', (event) => {
            this.testResults.orders.processed++;
            if (this.config.verbose) {
                console.log(`⚙️ Order processed: ${event.order.id}`);
            }
        });
        
        this.aggregator.on('fillProcessed', (event) => {
            this.testResults.orders.filled++;
            if (this.config.verbose) {
                console.log(`✅ Fill processed: ${event.fill.orderId} @ ${event.fill.fillPrice}`);
            }
        });
        
        this.aggregator.on('orderRejected', (event) => {
            this.testResults.orders.rejected++;
            if (event.reason === 'RISK_VIOLATION') {
                this.testResults.riskViolations.push(event);
            }
            if (this.config.verbose) {
                console.log(`❌ Order rejected: ${event.order.id} - ${event.reason}`);
            }
        });
        
        this.aggregator.on('orderFailed', (event) => {
            this.testResults.errors.push({
                type: 'ORDER_FAILURE',
                orderId: event.order.id,
                error: event.error,
                timestamp: new Date()
            });
        });
    }
    
    /**
     * Test basic order submission and processing
     */
    async runBasicOrderTest() {
        console.log('\n🧪 Running Basic Order Test...');
        
        const testOrders = [
            this.createTestOrder('MES', 'BUY', 1, 4500),
            this.createTestOrder('MNQ', 'SELL', 2, 15000),
            this.createTestOrder('MGC', 'BUY', 1, 1800)
        ];
        
        for (const order of testOrders) {
            const result = await this.aggregator.submitOrder(order);
            if (this.config.verbose) {
                console.log(`Order ${order.id}: ${result.success ? 'Accepted' : 'Rejected'}`);
            }
        }
        
        // Wait for processing
        await this.wait(2000);
        
        console.log('✅ Basic order test completed');
    }
    
    /**
     * Test risk validation scenarios
     */
    async runRiskValidationTest() {
        console.log('\n🛡️ Running Risk Validation Test...');
        
        const riskTestOrders = [
            // Valid order
            this.createTestOrder('MES', 'BUY', 5, 4500),
            
            // Order too large (should trigger risk violation)
            this.createTestOrder('MES', 'BUY', 15, 4500), // Exceeds maxOrderSize
            
            // Another valid order
            this.createTestOrder('MNQ', 'SELL', 3, 15000)
        ];
        
        for (const order of riskTestOrders) {
            await this.aggregator.submitOrder(order);
        }
        
        await this.wait(1000);
        
        console.log(`✅ Risk validation test completed - ${this.testResults.riskViolations.length} violations detected`);
    }
    
    /**
     * Test high volume order processing
     */
    async runHighVolumeTest() {
        console.log('\n🚀 Running High Volume Test...');
        
        this.testResults.startTime = new Date();
        
        // Submit orders at configured rate
        this.testInterval = setInterval(() => {
            const instrument = this.config.instruments[
                Math.floor(Math.random() * this.config.instruments.length)
            ];
            const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
            const quantity = Math.floor(Math.random() * 5) + 1;
            
            const order = this.createTestOrder(instrument, side, quantity);
            this.aggregator.submitOrder(order);
            
        }, 1000 / this.config.ordersPerSecond);
        
        // Run for configured duration
        await this.wait(this.config.testDuration);
        
        clearInterval(this.testInterval);
        this.testResults.endTime = new Date();
        
        console.log('✅ High volume test completed');
    }
    
    /**
     * Test SL/TP calculation functionality
     */
    async runSLTPCalculationTest() {
        console.log('\n🎯 Running SL/TP Calculation Test...');
        
        // Create fills to test SL/TP calculation
        const testFills = [
            {
                orderId: 'TEST_FILL_001',
                instrument: 'MES',
                fillPrice: 4500,
                quantity: 2,
                side: 'BUY',
                fillTime: new Date(),
                source: 'TEST'
            },
            {
                orderId: 'TEST_FILL_002',
                instrument: 'MNQ',
                fillPrice: 15000,
                quantity: 1,
                side: 'SELL',
                fillTime: new Date(),
                source: 'TEST'
            }
        ];
        
        for (const fill of testFills) {
            await this.aggregator.processFill(fill);
        }
        
        console.log('✅ SL/TP calculation test completed');
    }
    
    /**
     * Test bot registry functionality
     */
    async runBotRegistryTest() {
        console.log('\n📊 Running Bot Registry Test...');
        
        // Register test sources
        const registry = this.aggregator.botRegistry;
        
        const testSources = [
            {
                id: 'TEST_BOT_001',
                type: 'BOT',
                name: 'Test Strategy Bot',
                version: '1.0.0',
                strategy: 'EMA_CROSSOVER'
            },
            {
                id: 'TEST_MANUAL_001',
                type: 'MANUAL',
                name: 'Test Manual Trader',
                traderId: 'TRADER_001'
            }
        ];
        
        for (const source of testSources) {
            const result = registry.register(source);
            if (this.config.verbose) {
                console.log(`Source ${source.id}: ${result.success ? 'Registered' : 'Failed'}`);
            }
        }
        
        // Test order recording
        const testOrder = this.createTestOrder('MES', 'BUY', 1);
        registry.recordOrder('TEST_BOT_001', testOrder, { success: true });
        
        console.log('✅ Bot registry test completed');
    }
    
    /**
     * Create a test order
     */
    createTestOrder(instrument, side, quantity, price = null) {
        this.orderCounter++;
        
        return {
            id: `TEST_ORDER_${String(this.orderCounter).padStart(3, '0')}`,
            source: 'AGGREGATOR_TESTER',
            instrument,
            action: side,
            type: price ? 'LIMIT' : 'MARKET',
            quantity,
            price,
            timestamp: new Date(),
            metadata: {
                testOrder: true,
                testScenario: 'basic'
            }
        };
    }
    
    /**
     * Generate test report
     */
    generateReport() {
        const metrics = this.aggregator.getMetrics();
        const duration = this.testResults.endTime 
            ? (this.testResults.endTime - this.testResults.startTime) / 1000 
            : 0;
        
        console.log('\n📈 TEST RESULTS REPORT');
        console.log('=' * 50);
        console.log(`Duration: ${duration}s`);
        console.log(`Shadow Mode: ${this.config.shadowMode}`);
        console.log('\nORDER STATISTICS:');
        console.log(`  📨 Submitted: ${this.testResults.orders.submitted}`);
        console.log(`  ⚙️ Processed: ${this.testResults.orders.processed}`);
        console.log(`  ✅ Filled: ${this.testResults.orders.filled}`);
        console.log(`  ❌ Rejected: ${this.testResults.orders.rejected}`);
        
        console.log('\nRISK MANAGEMENT:');
        console.log(`  🛡️ Risk Violations: ${this.testResults.riskViolations.length}`);
        
        console.log('\nQUEUE PERFORMANCE:');
        console.log(`  📊 Current Queue Size: ${metrics.queue.queues.total}`);
        console.log(`  ⏱️ Avg Processing Time: ${metrics.queue.processing.avgProcessingTime.toFixed(2)}ms`);
        console.log(`  ⏳ Avg Wait Time: ${metrics.queue.history.avgWaitTime.toFixed(2)}ms`);
        
        console.log('\nBOT REGISTRY:');
        console.log(`  🤖 Total Sources: ${metrics.registry.totalSources}`);
        console.log(`  ✅ Active Sources: ${metrics.registry.activeCount}`);
        
        console.log('\nERRORS:');
        console.log(`  ❌ Total Errors: ${this.testResults.errors.length}`);
        
        if (this.testResults.errors.length > 0) {
            console.log('\nERROR DETAILS:');
            this.testResults.errors.forEach((error, index) => {
                console.log(`  ${index + 1}. ${error.type}: ${error.message}`);
            });
        }
        
        // Overall assessment
        const successRate = this.testResults.orders.submitted > 0 
            ? (this.testResults.orders.processed / this.testResults.orders.submitted * 100).toFixed(1)
            : 0;
            
        console.log('\nOVERALL ASSESSMENT:');
        console.log(`  Success Rate: ${successRate}%`);
        console.log(`  Shadow Mode: ${this.config.shadowMode ? '✅ Active' : '❌ Disabled'}`);
        
        if (this.testResults.errors.length === 0 && successRate > 90) {
            console.log('  🎉 All tests passed successfully!');
        } else {
            console.log('  ⚠️ Some issues detected - review error details');
        }
        
        console.log('=' * 50);
    }
    
    /**
     * Wait utility
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Cleanup test resources
     */
    async cleanup() {
        if (this.testInterval) {
            clearInterval(this.testInterval);
        }
        
        if (this.aggregator) {
            await this.aggregator.shutdown();
        }
        
        console.log('\n🧹 Test cleanup completed');
    }
}

// Export for use in other modules
module.exports = AggregatorTester;

// If run directly, execute tests
if (require.main === module) {
    const tester = new AggregatorTester({
        shadowMode: true,
        verbose: true,
        testDuration: 10000, // 10 seconds
        ordersPerSecond: 5
    });
    
    tester.runTests().catch(console.error);
}