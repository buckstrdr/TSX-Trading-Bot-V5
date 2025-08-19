/**
 * Debug Aggregator P&L Subscription
 */

const RedisAdapter = require('./src/core/aggregator/adapters/RedisAdapter');

async function debugRedisAdapter() {
    console.log('🔍 Testing RedisAdapter P&L subscription...');
    
    try {
        // Create Redis adapter
        const redisAdapter = new RedisAdapter({
            host: 'localhost',
            port: 6379
        });
        
        console.log('✅ RedisAdapter created');
        console.log('Methods available:', Object.getOwnPropertyNames(Object.getPrototypeOf(redisAdapter)));
        
        // Check if subscribeToPnLRequests method exists
        if (typeof redisAdapter.subscribeToPnLRequests === 'function') {
            console.log('✅ subscribeToPnLRequests method exists');
        } else {
            console.log('❌ subscribeToPnLRequests method does not exist');
        }
        
        // Initialize Redis
        console.log('🔌 Initializing Redis...');
        await redisAdapter.initialize();
        console.log('✅ Redis initialized');
        
        // Try to call P&L subscription
        console.log('💰 Setting up P&L subscription...');
        await redisAdapter.subscribeToPnLRequests();
        console.log('✅ P&L subscription completed');
        
        // Wait a moment and then clean up
        console.log('⏰ Waiting 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log('🧹 Cleaning up...');
        await redisAdapter.disconnect();
        console.log('✅ Debug completed successfully');
        
    } catch (error) {
        console.error('❌ Debug failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run debug
debugRedisAdapter().catch(console.error);