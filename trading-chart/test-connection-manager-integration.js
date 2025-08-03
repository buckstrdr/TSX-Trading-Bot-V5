// Test script to verify Connection Manager -> Redis -> Trading Chart integration
const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  retryDelayOnFailover: 100,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

async function testConnectionManagerIntegration() {
  try {
    console.log('🧪 Testing Connection Manager -> Redis -> Trading Chart integration...\n');
    
    // Test 1: Simulate market data that Connection Manager would publish
    console.log('📊 Test 1: Publishing market data (simulating Connection Manager)...');
    
    const marketDataQuote = {
      payload: {
        instrument: 'CON.F.US.MNQ.U25',
        type: 'QUOTE',
        data: {
          bid: 21875.25,
          ask: 21875.75,
          bidSize: 10,
          askSize: 15,
          timestamp: Date.now()
        }
      },
      timestamp: new Date().toISOString(),
      correlationId: `quote-test-${Date.now()}`
    };
    
    await redis.publish('market:data', JSON.stringify(marketDataQuote));
    console.log('✅ Published QUOTE data');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const marketDataTrade = {
      payload: {
        instrument: 'CON.F.US.MNQ.U25',
        type: 'TRADE',
        data: {
          price: 21875.50,
          size: 5,
          side: 'BUY',
          timestamp: Date.now()
        }
      },
      timestamp: new Date().toISOString(),
      correlationId: `trade-test-${Date.now()}`
    };
    
    await redis.publish('market:data', JSON.stringify(marketDataTrade));
    console.log('✅ Published TRADE data');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Test 2: Simulate order fills from Connection Manager
    console.log('\n📋 Test 2: Publishing order fills (from Connection Manager)...');
    
    const orderFill = {
      orderId: 'test-order-001',
      accountId: 'TEST_ACCOUNT',
      instrument: 'CON.F.US.MNQ.U25',
      side: 'BUY',
      filledPrice: 21875.50,
      filledQuantity: 5,
      positionId: 'test-pos-001',
      timestamp: Date.now()
    };
    
    await redis.publish('ORDER_FILLED', JSON.stringify(orderFill));
    console.log('✅ Published ORDER_FILLED event');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Test 3: Simulate position updates from Connection Manager
    console.log('\n📊 Test 3: Publishing position updates (from Connection Manager)...');
    
    const positionUpdate = {
      accountId: 'TEST_ACCOUNT',
      positionId: 'test-pos-001',
      instrument: 'CON.F.US.MNQ.U25',
      type: 'LONG',
      size: 5,
      averagePrice: 21875.50,
      unrealizedPnL: 25.00,
      realizedPnL: 0,
      timestamp: Date.now()
    };
    
    await redis.publish('POSITION_UPDATE', JSON.stringify(positionUpdate));
    console.log('✅ Published POSITION_UPDATE event');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Test 4: Test Stop Loss / Take Profit (if implemented in Connection Manager)
    console.log('\n🎯 Test 4: Publishing SL/TP updates...');
    
    const slTpUpdate = {
      positionId: 'test-pos-001',
      stopLoss: 21850.00,
      takeProfit: 21925.00,
      instrument: 'CON.F.US.MNQ.U25'
    };
    
    await redis.publish('SL_TP_UPDATE', JSON.stringify(slTpUpdate));
    console.log('✅ Published SL_TP_UPDATE event');
    
    console.log('\n🎉 Integration test completed!');
    console.log('\n📋 What to check in your Trading Chart:');
    console.log('   1. Chart should show live candlesticks from market data');
    console.log('   2. Buy arrow marker should appear at $21875.50');
    console.log('   3. Green position line should appear at $21875.50');
    console.log('   4. Red dashed stop loss line at $21850.00');
    console.log('   5. Green dashed take profit line at $21925.00');
    console.log('   6. Position counter should show: Positions: 1');
    console.log('   7. Order fills counter should show: Fills: 1');
    
    console.log('\n🚀 Next Steps:');
    console.log('   1. Start Connection Manager: npm run start (in connection-manager folder)');
    console.log('   2. Start Trading Chart: npm run dev (in trading-chart folder)');
    console.log('   3. Connection Manager will automatically publish live data to Redis');
    console.log('   4. Trading Chart will receive and display the data');
    
  } catch (error) {
    console.error('❌ Integration test failed:', error);
  } finally {
    redis.disconnect();
  }
}

// Run the integration test
testConnectionManagerIntegration();