/**
 * Test Historical Data Request through Redis Pub/Sub
 * This simulates how a bot should request historical data
 */

const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

async function testRedisHistoricalRequest() {
    console.log('========================================');
    console.log('Redis Historical Data Request Test');
    console.log('========================================\n');
    
    // Create Redis clients
    const publisher = redis.createClient({
        host: 'localhost',
        port: 6379
    });
    
    const subscriber = redis.createClient({
        host: 'localhost',
        port: 6379
    });
    
    // Connect to Redis
    try {
        await publisher.connect();
        await subscriber.connect();
        console.log('✅ Connected to Redis\n');
    } catch (error) {
        console.error('❌ Failed to connect to Redis:', error.message);
        console.log('💡 Make sure Redis is running on port 6379');
        return false;
    }
    
    // Generate unique request ID
    const requestId = uuidv4();
    const instanceId = 'test_bot_' + Date.now();
    
    // Calculate time windows - last 30 minutes
    const now = new Date();
    const endTime = new Date(now);
    const startTime = new Date(now.getTime() - (30 * 60 * 1000)); // 30 minutes ago
    
    console.log(`📊 Request Details:`);
    console.log(`   Request ID: ${requestId}`);
    console.log(`   Instance ID: ${instanceId}`);
    console.log(`   Start Time: ${startTime.toISOString()}`);
    console.log(`   End Time: ${endTime.toISOString()}\n`);
    
    // Subscribe to response channel
    const responseChannel = 'HISTORICAL_DATA_RESPONSE';
    let responseReceived = false;
    
    console.log(`👂 Subscribing to ${responseChannel}...`);
    
    await subscriber.subscribe(responseChannel, (message) => {
        try {
            const response = JSON.parse(message);
            
            // Check if this is our response
            if (response.requestId === requestId) {
                responseReceived = true;
                console.log('\n📥 Received Historical Data Response!');
                console.log(`   Success: ${response.success}`);
                
                if (response.success && response.bars) {
                    console.log(`   Bars received: ${response.bars.length}`);
                    
                    if (response.bars.length > 0) {
                        const firstBar = response.bars[0];
                        const lastBar = response.bars[response.bars.length - 1];
                        
                        console.log('\n📈 First Bar:');
                        console.log(`   Time: ${new Date(firstBar.t).toISOString()}`);
                        console.log(`   OHLC: ${firstBar.o} / ${firstBar.h} / ${firstBar.l} / ${firstBar.c}`);
                        
                        console.log('\n📈 Last Bar:');
                        console.log(`   Time: ${new Date(lastBar.t).toISOString()}`);
                        console.log(`   OHLC: ${lastBar.o} / ${lastBar.h} / ${lastBar.l} / ${lastBar.c}`);
                    }
                } else if (response.error) {
                    console.log(`   Error: ${response.error}`);
                }
            }
        } catch (error) {
            console.error('Error parsing response:', error);
        }
    });
    
    // Prepare request
    const requestData = {
        type: 'REQUEST_HISTORICAL_DATA',
        instanceId: instanceId,
        requestId: requestId,
        instrument: 'F.US.MGC',  // MGC futures
        contractId: 'F.US.MGC',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        unit: 2,                 // 2 = Minute
        unitNumber: 5,           // 5-minute bars
        limit: 10,               // Get 10 bars
        includePartialBar: false
    };
    
    // Publish request
    const requestChannel = 'aggregator:requests';  // Channel that aggregator listens to
    
    console.log(`\n📤 Publishing request to ${requestChannel}...`);
    console.log('📊 Request:', JSON.stringify(requestData, null, 2));
    
    await publisher.publish(requestChannel, JSON.stringify(requestData));
    console.log('✅ Request published\n');
    
    // Wait for response (timeout after 10 seconds)
    console.log('⏳ Waiting for response (10 second timeout)...');
    
    await new Promise(resolve => {
        let timeElapsed = 0;
        const checkInterval = setInterval(() => {
            timeElapsed += 1;
            
            if (responseReceived) {
                clearInterval(checkInterval);
                console.log('\n✅ Response received successfully!');
                resolve();
            } else if (timeElapsed >= 10) {
                clearInterval(checkInterval);
                console.log('\n⏱️ Timeout - no response received');
                console.log('💡 This likely means:');
                console.log('   1. The aggregator is not running');
                console.log('   2. The request channel name is incorrect');
                console.log('   3. The Connection Manager is not handling the request');
                resolve();
            } else {
                process.stdout.write('.');
            }
        }, 1000);
    });
    
    // Alternative: Try direct event broadcaster channel
    if (!responseReceived) {
        console.log('\n🔄 Trying alternative channel: connection-manager:events');
        
        const altRequestData = {
            ...requestData,
            type: 'REQUEST_HISTORICAL_DATA'
        };
        
        await publisher.publish('connection-manager:events', JSON.stringify(altRequestData));
        console.log('✅ Alternative request published');
        
        // Wait briefly for response
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        if (!responseReceived) {
            console.log('⏱️ Still no response on alternative channel');
        }
    }
    
    // Cleanup
    await subscriber.unsubscribe(responseChannel);
    await subscriber.quit();
    await publisher.quit();
    
    console.log('\n========================================');
    console.log('Test Summary:');
    console.log('========================================');
    
    if (responseReceived) {
        console.log('✅ Historical data successfully retrieved through Redis!');
        console.log('📝 The data flow is working correctly:');
        console.log('   Request → Redis → Connection Manager → TSX API → Redis → Response');
        return true;
    } else {
        console.log('⚠️ No response received through Redis channels');
        console.log('📝 Need to verify:');
        console.log('   1. Is the Trading Aggregator running?');
        console.log('   2. Is Redis configured correctly?');
        console.log('   3. Are the channel names correct?');
        console.log('\n💡 To fix: Start the full stack with LAUNCH-CONTROL-PANEL.bat');
        return false;
    }
}

// Run the test
testRedisHistoricalRequest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 Test failed:', error);
    process.exit(1);
});