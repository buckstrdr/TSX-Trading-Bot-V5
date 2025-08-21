/**
 * Test and monitor Redis channels for historical data flow
 * This will show us what channels are active and help debug the communication
 */

const redis = require('redis');

async function monitorRedisChannels() {
    console.log('========================================');
    console.log('Redis Channel Monitor');
    console.log('========================================\n');
    
    // Create Redis clients
    const client = redis.createClient({
        host: 'localhost',
        port: 6379
    });
    
    const monitor = redis.createClient({
        host: 'localhost',
        port: 6379
    });
    
    try {
        await client.connect();
        await monitor.connect();
        console.log('✅ Connected to Redis\n');
    } catch (error) {
        console.error('❌ Failed to connect to Redis:', error.message);
        return;
    }
    
    // List all active pub/sub channels
    console.log('📡 Active Pub/Sub Channels:');
    console.log('----------------------------');
    
    try {
        // Use PUBSUB CHANNELS command to list active channels
        const channels = await client.pubSubChannels();
        
        if (channels && channels.length > 0) {
            channels.forEach(channel => {
                console.log(`   📢 ${channel}`);
            });
        } else {
            console.log('   (No active channels)');
        }
    } catch (error) {
        console.log('   Error listing channels:', error.message);
    }
    
    console.log('\n📊 Testing Key Historical Data Channels:');
    console.log('----------------------------------------');
    
    // Key channels for historical data flow
    const testChannels = [
        'aggregator:requests',
        'aggregator:market-data',
        'connection-manager:events',
        'connection-manager:requests', 
        'connection-manager:market-data',
        'REQUEST_HISTORICAL_DATA',
        'HISTORICAL_DATA_REQUEST',
        'HISTORICAL_DATA_RESPONSE',
        'bot_1:requests',
        'bot_1:responses'
    ];
    
    // Subscribe to all channels to monitor activity
    const subscriber = redis.createClient({
        host: 'localhost',
        port: 6379
    });
    await subscriber.connect();
    
    console.log('\n👂 Monitoring channels for 5 seconds...\n');
    
    const channelActivity = {};
    
    // Subscribe to each channel
    for (const channel of testChannels) {
        channelActivity[channel] = 0;
        
        await subscriber.subscribe(channel, (message) => {
            channelActivity[channel]++;
            const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
            console.log(`[${timestamp}] 📥 ${channel}:`);
            
            try {
                const parsed = JSON.parse(message);
                console.log(`   Type: ${parsed.type || 'unknown'}`);
                if (parsed.instrument) console.log(`   Instrument: ${parsed.instrument}`);
                if (parsed.instanceId) console.log(`   Instance: ${parsed.instanceId}`);
            } catch (e) {
                console.log(`   Raw: ${message.substring(0, 100)}...`);
            }
        });
    }
    
    // Also test publishing a historical data request
    console.log('📤 Publishing test historical data request...\n');
    
    const testRequest = {
        type: 'REQUEST_HISTORICAL_DATA',
        instanceId: 'test_monitor',
        requestId: 'test_' + Date.now(),
        instrument: 'F.US.MGC',
        startTime: new Date(Date.now() - 3600000).toISOString(),
        endTime: new Date().toISOString(),
        unit: 2,
        unitNumber: 5,
        limit: 10
    };
    
    // Try different channels to see which one gets picked up
    await client.publish('aggregator:requests', JSON.stringify(testRequest));
    await client.publish('connection-manager:events', JSON.stringify(testRequest));
    await client.publish('REQUEST_HISTORICAL_DATA', JSON.stringify(testRequest));
    
    // Wait and monitor
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Report activity
    console.log('\n📊 Channel Activity Summary:');
    console.log('----------------------------');
    
    let activeChannels = 0;
    for (const [channel, count] of Object.entries(channelActivity)) {
        if (count > 0) {
            console.log(`✅ ${channel}: ${count} messages`);
            activeChannels++;
        } else {
            console.log(`⭕ ${channel}: No activity`);
        }
    }
    
    console.log(`\n📈 Active channels: ${activeChannels}/${testChannels.length}`);
    
    // Check if services are properly connected
    console.log('\n🔍 Service Connection Analysis:');
    console.log('--------------------------------');
    
    if (channelActivity['aggregator:market-data'] > 0) {
        console.log('✅ Aggregator is publishing market data');
    } else {
        console.log('⚠️ Aggregator may not be running or not publishing market data');
    }
    
    if (channelActivity['connection-manager:market-data'] > 0) {
        console.log('✅ Connection Manager is publishing market data');
    } else {
        console.log('⚠️ Connection Manager may not be connected to market feed');
    }
    
    if (channelActivity['HISTORICAL_DATA_RESPONSE'] > 0) {
        console.log('✅ Historical data responses are being published');
    } else {
        console.log('❌ No historical data responses detected');
    }
    
    // Cleanup
    await subscriber.unsubscribe();
    await subscriber.quit();
    await monitor.quit();
    await client.quit();
    
    console.log('\n✅ Monitoring complete');
}

// Run the monitor
monitorRedisChannels().catch(error => {
    console.error('💥 Error:', error);
    process.exit(1);
});