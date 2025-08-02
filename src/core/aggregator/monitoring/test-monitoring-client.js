/**
 * Test client for Aggregator Monitoring WebSocket
 * Demonstrates how to connect and subscribe to real-time metrics
 */

const WebSocket = require('ws');
const axios = require('axios');

class MonitoringTestClient {
    constructor() {
        this.apiUrl = 'http://localhost:7600';
        this.wsUrl = 'ws://localhost:7600';
        this.ws = null;
    }
    
    /**
     * Test REST API endpoints
     */
    async testRestApi() {
        console.log('\n📊 Testing REST API Endpoints...\n');
        
        try {
            // Test health endpoint
            console.log('Testing /health...');
            const health = await axios.get(`${this.apiUrl}/health`);
            console.log('Health:', JSON.stringify(health.data, null, 2));
            
            // Test metrics endpoint
            console.log('\nTesting /api/metrics...');
            const metrics = await axios.get(`${this.apiUrl}/api/metrics`);
            console.log('Metrics Summary:', {
                orders: {
                    received: metrics.data.monitoring.orders.received,
                    processed: metrics.data.monitoring.orders.processed,
                    rejected: metrics.data.monitoring.orders.rejected
                },
                queue: {
                    depth: metrics.data.monitoring.queue.depth,
                    avgProcessingTime: metrics.data.monitoring.queue.avgProcessingTime
                },
                risk: {
                    violations: metrics.data.monitoring.risk.violations
                }
            });
            
            // Test specific endpoints
            console.log('\nTesting /api/metrics/orders...');
            const orders = await axios.get(`${this.apiUrl}/api/metrics/orders`);
            console.log('Order Metrics:', orders.data.orders);
            
            console.log('\nTesting /api/metrics/risk...');
            const risk = await axios.get(`${this.apiUrl}/api/metrics/risk`);
            console.log('Risk Metrics:', risk.data.monitoring);
            
        } catch (error) {
            console.error('REST API Error:', error.message);
        }
    }
    
    /**
     * Test WebSocket connection
     */
    async testWebSocket() {
        console.log('\n🔌 Testing WebSocket Connection...\n');
        
        return new Promise((resolve) => {
            this.ws = new WebSocket(this.wsUrl);
            
            this.ws.on('open', () => {
                console.log('✅ WebSocket connected');
                
                // Subscribe to all channels
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    channels: ['all']
                }));
                
                // Subscribe to specific channels
                setTimeout(() => {
                    console.log('\nSubscribing to specific channels...');
                    this.ws.send(JSON.stringify({
                        type: 'subscribe',
                        channels: ['orders', 'risk', 'sltp']
                    }));
                }, 2000);
                
                // Test ping
                setTimeout(() => {
                    console.log('\nTesting ping...');
                    this.ws.send(JSON.stringify({
                        type: 'ping'
                    }));
                }, 3000);
            });
            
            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                
                switch (message.type) {
                    case 'welcome':
                        console.log('📨 Welcome message:', message);
                        break;
                        
                    case 'subscribed':
                        console.log('✅ Subscribed to channels:', message.channels);
                        break;
                        
                    case 'pong':
                        console.log('🏓 Pong received');
                        break;
                        
                    case 'metrics':
                        console.log(`\n📊 [${message.channel}] Metrics Update:`);
                        
                        if (message.channel === 'orders') {
                            console.log('  Order Event:', message.data);
                        } else if (message.channel === 'risk') {
                            console.log('  Risk Event:', message.data);
                        } else if (message.channel === 'sltp') {
                            console.log('  SL/TP Event:', message.data);
                        } else if (message.channel === 'metrics') {
                            console.log('  General Metrics:', {
                                orders: message.data.metrics.orders.received,
                                queue: message.data.metrics.queue.depth,
                                cpu: message.data.metrics.system.cpuUsage.toFixed(2),
                                memory: `${message.data.metrics.system.memoryUsage.toFixed(2)} MB`
                            });
                        }
                        break;
                        
                    default:
                        console.log('Unknown message type:', message.type);
                }
            });
            
            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error.message);
            });
            
            this.ws.on('close', () => {
                console.log('WebSocket connection closed');
                resolve();
            });
            
            // Close after 30 seconds
            setTimeout(() => {
                console.log('\n📴 Closing WebSocket connection...');
                this.ws.close();
            }, 30000);
        });
    }
    
    /**
     * Run all tests
     */
    async runTests() {
        console.log('🚀 Starting Aggregator Monitoring Tests');
        console.log('=====================================\n');
        
        // Test REST API
        await this.testRestApi();
        
        // Test WebSocket
        await this.testWebSocket();
        
        console.log('\n✅ All tests completed');
    }
}

// Run the test client
if (require.main === module) {
    const client = new MonitoringTestClient();
    
    client.runTests().catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });
}

module.exports = MonitoringTestClient;