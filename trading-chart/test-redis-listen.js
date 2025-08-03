// Test script to listen for data from trading bot
import Redis from 'ioredis';

async function testRedisListener() {
    console.log('🎧 Starting Redis listener test...');
    
    const redis = new Redis({
        host: 'localhost',
        port: 6379,
        retryDelayOnFailover: 100,
        retryDelayOn503: 100,
        maxRetriesPerRequest: 3
    });

    redis.on('connect', () => {
        console.log('✅ Connected to Redis');
    });

    redis.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
    });

    // Subscribe to the channels our chart app is listening to
    const channels = ['market:data', 'orders:executions', 'system:alerts'];
    
    for (const channel of channels) {
        await redis.subscribe(channel);
        console.log(`📻 Subscribed to: ${channel}`);
    }

    redis.on('message', (channel, message) => {
        console.log(`\n📨 [${new Date().toISOString()}] Channel: ${channel}`);
        try {
            const parsed = JSON.parse(message);
            console.log('📦 Data:', JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.log('📦 Raw message:', message);
        }
    });

    console.log('\n⏳ Listening for messages... (Press Ctrl+C to stop)');
    console.log('If your trading bot is running, you should see messages here.');
    
    // Also test if we can publish a test message
    setTimeout(async () => {
        const testRedis = new Redis();
        const testMessage = {
            payload: {
                symbol: 'TEST',
                price: 100.50,
                volume: 100,
                timestamp: Date.now(),
                bid: 100.49,
                ask: 100.51
            },
            timestamp: new Date().toISOString(),
            correlationId: 'test-123'
        };
        
        console.log('\n🧪 Publishing test message to market:data channel...');
        await testRedis.publish('market:data', JSON.stringify(testMessage));
        await testRedis.quit();
    }, 2000);

    // Keep alive
    process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down...');
        await redis.quit();
        process.exit(0);
    });
}

testRedisListener().catch(console.error);