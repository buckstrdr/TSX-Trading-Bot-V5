// Test script to publish position data to Redis for chart visualization testing
const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  retryDelayOnFailover: 100,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

async function publishTestPositionData() {
  try {
    console.log('📊 Publishing test position and order data...');
    
    // Test position update - opening a long position
    const longPosition = {
      accountId: 'TEST_ACCOUNT_001',
      positionId: 'pos_long_001',
      instrument: 'CON.F.US.MNQ.U25',
      type: 'LONG',
      size: 5,
      averagePrice: 21850.50,
      unrealizedPnL: 125.50,
      realizedPnL: 0,
      timestamp: Date.now()
    };
    
    await redis.publish('POSITION_UPDATE', JSON.stringify(longPosition));
    console.log('✅ Published LONG position update');
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test order fill
    const orderFill = {
      orderId: 'order_001',
      accountId: 'TEST_ACCOUNT_001',
      instrument: 'CON.F.US.MNQ.U25',
      side: 'BUY',
      filledPrice: 21850.50,
      filledQuantity: 5,
      positionId: 'pos_long_001',
      timestamp: Date.now()
    };
    
    await redis.publish('ORDER_FILLED', JSON.stringify(orderFill));
    console.log('✅ Published order fill');
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test SL/TP update
    const slTpUpdate = {
      positionId: 'pos_long_001',
      stopLoss: 21800.00,
      takeProfit: 21950.00,
      instrument: 'CON.F.US.MNQ.U25'
    };
    
    await redis.publish('SL_TP_UPDATE', JSON.stringify(slTpUpdate));
    console.log('✅ Published SL/TP update');
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test short position update
    const shortPosition = {
      accountId: 'TEST_ACCOUNT_002',
      positionId: 'pos_short_001',
      instrument: 'CON.F.US.MNQ.U25',
      type: 'SHORT',
      size: 3,
      averagePrice: 21880.75,
      unrealizedPnL: -45.25,
      realizedPnL: 0,
      timestamp: Date.now()
    };
    
    await redis.publish('POSITION_UPDATE', JSON.stringify(shortPosition));
    console.log('✅ Published SHORT position update');
    
    // Test short order fill
    const shortOrderFill = {
      orderId: 'order_002',
      accountId: 'TEST_ACCOUNT_002',
      instrument: 'CON.F.US.MNQ.U25',
      side: 'SELL',
      filledPrice: 21880.75,
      filledQuantity: 3,
      positionId: 'pos_short_001',
      timestamp: Date.now()
    };
    
    await redis.publish('ORDER_FILLED', JSON.stringify(shortOrderFill));
    console.log('✅ Published short order fill');
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test closing position (size = 0)
    const closedPosition = {
      accountId: 'TEST_ACCOUNT_001',
      positionId: 'pos_long_001',
      instrument: 'CON.F.US.MNQ.U25',
      type: 'LONG',
      size: 0, // Position closed
      averagePrice: 21850.50,
      unrealizedPnL: 0,
      realizedPnL: 175.50,
      timestamp: Date.now()
    };
    
    await redis.publish('POSITION_UPDATE', JSON.stringify(closedPosition));
    console.log('✅ Published position closure');
    
    console.log('\n🎯 Test data published successfully!');
    console.log('📊 Check your trading chart to see:');
    console.log('   - Green line for LONG position at $21850.50');
    console.log('   - Red dashed line for stop loss at $21800.00');
    console.log('   - Green dashed line for take profit at $21950.00');
    console.log('   - Red line for SHORT position at $21880.75');
    console.log('   - Buy/Sell markers on the chart');
    console.log('   - Position counter in the UI');
    
  } catch (error) {
    console.error('❌ Error publishing test data:', error);
  } finally {
    redis.disconnect();
  }
}

// Run the test
publishTestPositionData();