/**
 * Test Historical Data Request through PROPER Redis channels
 * This uses the correct channel and message format
 */

const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

async function testProperHistoricalRequest() {
    console.log('========================================');
    console.log('Proper Redis Historical Data Request');
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
        return false;
    }
    
    // Generate unique request ID
    const requestId = uuidv4();
    const instanceId = 'bot_1';  // Use a real bot ID
    
    // Calculate time windows - last 30 minutes
    const now = new Date();
    const endTime = new Date(now);
    const startTime = new Date(now.getTime() - (30 * 60 * 1000)); // 30 minutes ago
    
    console.log(`📊 Request Details:`);
    console.log(`   Request ID: ${requestId}`);
    console.log(`   Instance ID: ${instanceId}`);
    console.log(`   Start Time: ${startTime.toISOString()}`);
    console.log(`   End Time: ${endTime.toISOString()}\n`);
    
    // Subscribe to multiple possible response channels
    const responseChannels = [
        'historical:data:response',      // Defined in EventBroadcaster
        'HISTORICAL_DATA_RESPONSE',      // Used by HistoricalDataService
        `${instanceId}:responses`,       // Bot-specific response channel
        'bot_1:historical:response'      // Alternative bot response channel
    ];
    
    let responseReceived = false;
    let responseData = null;
    
    console.log(`👂 Subscribing to response channels...`);
    for (const channel of responseChannels) {
        console.log(`   📡 ${channel}`);
        await subscriber.subscribe(channel, (message) => {
            try {
                const response = JSON.parse(message);
                console.log(`\n📥 Response received on ${channel}!`);
                
                // Check if this is our response
                if (response.requestId === requestId || response.instanceId === instanceId) {
                    responseReceived = true;
                    responseData = response;
                    
                    console.log(`   Success: ${response.success}`);
                    if (response.bars && response.bars.length > 0) {
                        console.log(`   Bars received: ${response.bars.length}`);
                        
                        const firstBar = response.bars[0];
                        const lastBar = response.bars[response.bars.length - 1];
                        
                        console.log(`\n   📈 First Bar:`);
                        console.log(`      Time: ${new Date(firstBar.t).toISOString()}`);
                        console.log(`      OHLC: ${firstBar.o} / ${firstBar.h} / ${firstBar.l} / ${firstBar.c}`);
                        
                        console.log(`\n   📈 Last Bar:`);
                        console.log(`      Time: ${new Date(lastBar.t).toISOString()}`);
                        console.log(`      OHLC: ${lastBar.o} / ${lastBar.h} / ${lastBar.l} / ${lastBar.c}`);
                    } else if (response.error) {
                        console.log(`   Error: ${response.error}`);
                    }
                }
            } catch (error) {
                console.log(`   Parse error on ${channel}: ${error.message}`);
            }
        });
    }
    
    // Method 1: Send through connection-manager:requests with proper format
    const properRequest = {
        type: 'REQUEST_HISTORICAL_DATA',
        payload: {
            instanceId: instanceId,
            requestId: requestId,
            instrument: 'F.US.MGC',
            contractId: 'F.US.MGC',
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            unit: 2,                 // 2 = Minute
            unitNumber: 5,           // 5-minute candles
            limit: 10,               // Get 10 bars
            includePartialBar: false
        },
        requestId: requestId,
        responseChannel: `${instanceId}:responses`
    };
    
    console.log(`\n📤 Publishing to connection-manager:requests...`);
    console.log('📊 Request:', JSON.stringify(properRequest, null, 2));
    
    await publisher.publish('connection-manager:requests', JSON.stringify(properRequest));
    console.log('✅ Request published\n');
    
    // Wait for response (timeout after 5 seconds)
    console.log('⏳ Waiting for response (5 second timeout)...');
    
    await new Promise(resolve => {
        let dots = 0;
        const checkInterval = setInterval(() => {
            if (responseReceived) {
                clearInterval(checkInterval);
                resolve();
            } else if (dots >= 5) {
                clearInterval(checkInterval);
                resolve();
            } else {
                process.stdout.write('.');
                dots++;
            }
        }, 1000);
    });
    
    // If no response, try Method 2: Direct instance control channel
    if (!responseReceived) {
        console.log('\n\n🔄 Trying instance:control channel...');
        
        const instanceControlRequest = {
            type: 'REQUEST_HISTORICAL_DATA',
            payload: {
                instanceId: instanceId,
                requestId: requestId + '_v2',
                instrument: 'F.US.MGC',
                contractId: 'F.US.MGC',
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                unit: 2,
                unitNumber: 5,
                limit: 10,
                includePartialBar: false
            }
        };
        
        await publisher.publish('instance:control', JSON.stringify(instanceControlRequest));
        console.log('✅ Alternative request published');
        
        // Wait briefly
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Cleanup
    for (const channel of responseChannels) {
        await subscriber.unsubscribe(channel);
    }
    await subscriber.quit();
    await publisher.quit();
    
    console.log('\n========================================');
    console.log('Test Summary:');
    console.log('========================================');
    
    if (responseReceived) {
        console.log('✅ SUCCESS! Historical data retrieved through Redis!');
        console.log('📝 The data flow is working:');
        console.log('   Request → Redis → EventBroadcaster → ConnectionManager → TSX API');
        console.log('   Response → Redis → Bot');
        
        if (responseData && responseData.bars) {
            console.log(`\n📊 Data Quality:`);
            console.log(`   Bars received: ${responseData.bars.length}`);
            console.log(`   Time range: ${responseData.bars[0].t} to ${responseData.bars[responseData.bars.length - 1].t}`);
        }
        
        return true;
    } else {
        console.log('⚠️ No response received');
        console.log('\n📝 Troubleshooting steps:');
        console.log('1. Verify Connection Manager is running (port 7500)');
        console.log('2. Check Connection Manager logs for errors');
        console.log('3. Verify TSX API credentials are set');
        console.log('4. Check if market is open (historical data may be limited)');
        
        console.log('\n💡 To check Connection Manager:');
        console.log('   curl http://localhost:7500/health');
        
        return false;
    }
}

// Run the test
testProperHistoricalRequest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 Test failed:', error);
    process.exit(1);
});