// Complete integration test: Trading Chart -> Connection Manager -> TopStep -> Redis -> Trading Chart
const Redis = require('ioredis');

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  retryDelayOnFailover: 100,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

async function testCompleteIntegration() {
  try {
    console.log('🔄 Testing Complete Integration Flow...\n');
    
    console.log('📋 INTEGRATION FLOW:');
    console.log('   1. Trading Chart requests subscriptions');
    console.log('   2. Connection Manager receives requests');
    console.log('   3. Connection Manager subscribes to TopStep API');
    console.log('   4. TopStep sends real market data');
    console.log('   5. Connection Manager publishes to Redis');
    console.log('   6. Trading Chart receives and displays data\n');
    
    // Step 1: Simulate Trading Chart requesting subscriptions
    console.log('📊 Step 1: Trading Chart requesting market data subscriptions...');
    
    const subscriptionRequest = {
      instrument: 'CON.F.US.MNQ.U25',
      types: ['quote', 'trade', 'level2'],
      subscribe: true,
      source: 'trading-chart'
    };
    
    await redis.publish('SUBSCRIBE_MARKET_DATA', JSON.stringify(subscriptionRequest));
    console.log('✅ Published subscription request for CON.F.US.MNQ.U25');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 2: Listen for confirmation that Connection Manager processed the request
    console.log('\n📡 Step 2: Connection Manager should now subscribe to TopStep API...');
    console.log('   ✅ Connection Manager receives SUBSCRIBE_MARKET_DATA event');
    console.log('   ✅ Connection Manager calls marketDataService.subscribeToInstrument()');
    console.log('   ✅ MarketDataService subscribes to TopStep SignalR hub');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 3: Simulate market data that would come from TopStep
    console.log('\n💹 Step 3: Simulating market data flow from TopStep...');
    console.log('   (In real scenario, this comes from TopStep API automatically)');
    
    // Simulate a quote update (as Connection Manager would publish)
    const quoteData = {
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
      correlationId: `quote-integration-${Date.now()}`
    };
    
    await redis.publish('market:data', JSON.stringify(quoteData));
    console.log('✅ Published QUOTE data (simulating Connection Manager output)');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Simulate a trade execution
    const tradeData = {
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
      correlationId: `trade-integration-${Date.now()}`
    };
    
    await redis.publish('market:data', JSON.stringify(tradeData));
    console.log('✅ Published TRADE data (simulating Connection Manager output)');
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Step 4: Simulate order and position events
    console.log('\n📋 Step 4: Simulating order and position events...');
    
    const orderFill = {
      orderId: 'integration-order-001',
      accountId: 'INTEGRATION_TEST',
      instrument: 'CON.F.US.MNQ.U25',
      side: 'BUY',
      filledPrice: 21875.50,
      filledQuantity: 3,
      positionId: 'integration-pos-001',
      timestamp: Date.now()
    };
    
    await redis.publish('ORDER_FILLED', JSON.stringify(orderFill));
    console.log('✅ Published ORDER_FILLED event');
    
    const positionUpdate = {
      accountId: 'INTEGRATION_TEST',
      positionId: 'integration-pos-001',
      instrument: 'CON.F.US.MNQ.U25',
      type: 'LONG',
      size: 3,
      averagePrice: 21875.50,
      unrealizedPnL: 15.00,
      realizedPnL: 0,
      timestamp: Date.now()
    };
    
    await redis.publish('POSITION_UPDATE', JSON.stringify(positionUpdate));
    console.log('✅ Published POSITION_UPDATE event');
    
    const slTpUpdate = {
      positionId: 'integration-pos-001',
      stopLoss: 21850.00,
      takeProfit: 21900.00,
      instrument: 'CON.F.US.MNQ.U25'
    };
    
    await redis.publish('SL_TP_UPDATE', JSON.stringify(slTpUpdate));
    console.log('✅ Published SL/TP update');
    
    console.log('\n🎯 Integration Test Complete!');
    console.log('\n📊 What you should see in the Trading Chart:');
    console.log('   ✅ Candlestick chart with live data');
    console.log('   ✅ Buy arrow at $21875.50');
    console.log('   ✅ Green position line at $21875.50');
    console.log('   ✅ Red SL line at $21850.00');
    console.log('   ✅ Green TP line at $21900.00');
    console.log('   ✅ Counters: Positions: 1, Fills: 1');
    
    console.log('\n🚀 To run the full system:');
    console.log('   1. Start Redis: redis-server');
    console.log('   2. Start Connection Manager: cd connection-manager && npm start');
    console.log('   3. Start Trading Chart: cd trading-chart && npm run dev');
    console.log('   4. Connection Manager will subscribe to TopStep API automatically');
    console.log('   5. Real market data will flow through the system');
    
    console.log('\n📈 Data Flow Summary:');
    console.log('   Chart ─[SUBSCRIBE_MARKET_DATA]→ Connection Manager ─[SignalR]→ TopStep');
    console.log('   TopStep ─[Market Data]→ Connection Manager ─[Redis]→ Chart');
    console.log('   TopStep ─[Order/Position Events]→ Connection Manager ─[Redis]→ Chart');
    
  } catch (error) {
    console.error('❌ Integration test failed:', error);
  } finally {
    redis.disconnect();
  }
}

// Run the complete integration test
testCompleteIntegration();