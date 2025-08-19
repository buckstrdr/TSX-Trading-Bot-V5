/**
 * Test script to debug statistics flow from Bot UI to TopStepX API
 * This tests the entire chain: Bot -> Aggregator -> Connection Manager -> TopStepX
 */

const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

async function testStatisticsFlow() {
    let publisher = null;
    let subscriber = null;
    
    try {
        console.log('🚀 Starting statistics flow test...\n');
        
        // Create Redis clients
        publisher = redis.createClient({ host: 'localhost', port: 6379 });
        subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        console.log('✅ Redis connections established\n');
        
        const requestId = uuidv4();
        const responseChannel = `statistics:response:${requestId}`;
        const accountId = '9627376'; // Your account ID
        
        console.log('📋 Test Configuration:');
        console.log(`   Request ID: ${requestId}`);
        console.log(`   Account ID: ${accountId}`);
        console.log(`   Response Channel: ${responseChannel}`);
        console.log('');
        
        // Set up response listener
        const responsePromise = new Promise((resolve, reject) => {
            let isResolved = false;
            
            const timeout = setTimeout(async () => {
                if (!isResolved) {
                    isResolved = true;
                    console.log('⏱️ Timeout waiting for response (10 seconds)');
                    await subscriber.unsubscribe(responseChannel);
                    reject(new Error('Timeout waiting for statistics response'));
                }
            }, 10000);
            
            console.log(`👂 Subscribing to response channel: ${responseChannel}\n`);
            
            subscriber.subscribe(responseChannel, async (message) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    console.log('📨 Received response on channel:', responseChannel);
                    
                    try {
                        const response = JSON.parse(message);
                        console.log('📊 Response data:', JSON.stringify(response, null, 2));
                        await subscriber.unsubscribe(responseChannel);
                        resolve(response);
                    } catch (error) {
                        console.error('❌ Error parsing response:', error);
                        reject(error);
                    }
                }
            });
        });
        
        // Create the statistics request
        const request = {
            type: 'GET_STATISTICS',
            requestId: requestId,
            responseChannel: responseChannel,
            accountId: accountId,
            statisticsType: 'todaystats', // or 'lifetimestats'
            timestamp: Date.now()
        };
        
        console.log('📤 Publishing statistics request to aggregator:requests');
        console.log('   Request:', JSON.stringify(request, null, 2));
        console.log('');
        
        // Publish the request
        await publisher.publish('aggregator:requests', JSON.stringify(request));
        console.log('✅ Request published, waiting for response...\n');
        
        // Wait for response
        const response = await responsePromise;
        
        console.log('\n🎉 SUCCESS! Statistics received:');
        if (response.statistics) {
            console.log('   Total Trades:', response.statistics.totalTrades || 0);
            console.log('   Win Rate:', response.statistics.winRate || 0, '%');
            console.log('   Total P&L: $', response.statistics.totalPnL || 0);
            console.log('   Profit Factor:', response.statistics.profitFactor || 0);
            console.log('   Average Win: $', response.statistics.averageWin || 0);
            console.log('   Average Loss: $', response.statistics.averageLoss || 0);
        } else {
            console.log('   No statistics data in response');
        }
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        
        console.log('\n🔍 Debugging tips:');
        console.log('1. Check if Redis is running: redis-cli ping');
        console.log('2. Check if Trading Aggregator is running on port 7600');
        console.log('3. Check if Connection Manager is running on port 7500');
        console.log('4. Check Connection Manager logs for API errors');
        console.log('5. Monitor Redis: redis-cli monitor');
        
    } finally {
        // Clean up
        if (publisher) {
            await publisher.disconnect();
            console.log('\n🔌 Publisher disconnected');
        }
        if (subscriber) {
            await subscriber.disconnect();
            console.log('🔌 Subscriber disconnected');
        }
    }
}

// Also monitor all Redis traffic for debugging
async function monitorRedis() {
    const monitor = redis.createClient({ host: 'localhost', port: 6379 });
    await monitor.connect();
    
    console.log('\n📡 Monitoring Redis channels for statistics-related messages...\n');
    
    // Subscribe to all relevant channels
    const channels = [
        'aggregator:requests',
        'connection-manager:response',
        'aggregator:responses',
        'statistics:*'
    ];
    
    for (const channel of channels) {
        await monitor.pSubscribe(channel, (message, ch) => {
            console.log(`[${new Date().toISOString()}] Channel: ${ch}`);
            try {
                const data = JSON.parse(message);
                if (data.type === 'GET_STATISTICS' || data.type === 'STATISTICS_RESPONSE') {
                    console.log('  📊 Statistics Message:', JSON.stringify(data, null, 2));
                } else {
                    console.log('  Message type:', data.type);
                }
            } catch (e) {
                console.log('  Raw message:', message.substring(0, 100));
            }
            console.log('');
        });
    }
    
    console.log('Monitoring channels:', channels.join(', '));
    console.log('Press Ctrl+C to stop monitoring\n');
}

// Run the test
console.log('═══════════════════════════════════════════════════════════════');
console.log('     TOPSTEPX STATISTICS FLOW TEST');
console.log('═══════════════════════════════════════════════════════════════\n');

// Start monitoring in background
monitorRedis().catch(console.error);

// Wait a bit for monitor to set up, then run test
setTimeout(() => {
    testStatisticsFlow().then(() => {
        console.log('\n✅ Test completed');
        process.exit(0);
    }).catch((error) => {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    });
}, 1000);