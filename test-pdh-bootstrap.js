/**
 * Test script to verify PDH/PDL bootstrap mechanism
 * Tests the enhanced PDHPDLStrategy-Comprehensive.js with historical data loading
 */

const PDHPDLStrategy = require('./src/strategies/PDHPDLStrategy-Comprehensive.js');

async function testPDHBootstrap() {
    console.log('========================================');
    console.log('PDH/PDL Bootstrap Test');
    console.log('========================================\n');
    
    // Create strategy instance with test configuration
    const config = {
        dollarRiskPerTrade: 100,
        dollarPerPoint: 10,
        maxRiskPoints: 3.0,
        riskRewardRatio: 2.0,
        enableVolumeProfile: true,
        enableCumulativeDelta: true,
        enableLiquiditySweeps: true,
        enableBreakoutStrategy: true,
        enableFadeStrategy: true,
        enableTimeBasedOptimization: true
    };
    
    console.log('📝 Creating strategy instance...');
    const strategy = new PDHPDLStrategy(config);
    
    console.log('✅ Strategy created successfully\n');
    
    // Check initial state
    console.log('📊 Initial PDH/PDL State:');
    console.log(`   PDH: ${strategy.state.pdhPdlLevels.pdh}`);
    console.log(`   PDL: ${strategy.state.pdhPdlLevels.pdl}`);
    console.log(`   Valid: ${strategy.state.pdhPdlLevels.validRthCalculation}`);
    console.log(`   Bootstrapped: ${strategy.state.pdhPdlLevels.bootstrapped || false}\n`);
    
    // Initialize with historical data
    console.log('🚀 Starting historical data initialization...');
    console.log('⏳ This may take a few seconds...\n');
    
    await strategy.initializeWithHistoricalData();
    
    console.log('\n📊 Final PDH/PDL State After Bootstrap:');
    console.log(`   PDH: ${strategy.state.pdhPdlLevels.pdh?.toFixed(2) || 'Not Set'}`);
    console.log(`   PDL: ${strategy.state.pdhPdlLevels.pdl?.toFixed(2) || 'Not Set'}`);
    console.log(`   Range: ${strategy.state.pdhPdlLevels.range?.toFixed(2) || 'Not Set'}`);
    console.log(`   Midpoint: ${strategy.state.pdhPdlLevels.midpoint?.toFixed(2) || 'Not Set'}`);
    console.log(`   Valid: ${strategy.state.pdhPdlLevels.validRthCalculation}`);
    console.log(`   Bootstrapped: ${strategy.state.pdhPdlLevels.bootstrapped || false}`);
    console.log(`   Trade Date: ${strategy.state.pdhPdlLevels.tradeDate}`);
    console.log(`   RTH Data Points: ${strategy.state.pdhPdlLevels.rthDataPoints}`);
    
    // Check if strategy is ready
    console.log('\n🎯 Strategy Readiness:');
    console.log(`   Ready for Trading: ${strategy.isStrategyReady()}`);
    console.log(`   Data Points Collected: ${strategy.state.dataPointsCollected}`);
    console.log(`   RTH Data Points Today: ${strategy.state.rthDataPointsToday}`);
    
    // Test signal generation capability
    console.log('\n🔍 Testing Signal Generation Capability:');
    const testPrice = strategy.state.pdhPdlLevels.pdh ? 
        strategy.state.pdhPdlLevels.pdh + 1.0 : 1850.0;
    const testVolume = 5000;
    const testTimestamp = new Date();
    
    const result = await strategy.processMarketData(testPrice, testVolume, testTimestamp);
    
    console.log(`   Test Price: ${testPrice.toFixed(2)}`);
    console.log(`   Strategy Ready: ${result.ready}`);
    console.log(`   Signal Generated: ${result.signal ? 'Yes' : 'No'}`);
    if (result.signal) {
        console.log(`   Signal Type: ${result.signal.type}`);
        console.log(`   Signal Strategy: ${result.signal.strategy}`);
    }
    
    console.log('\n========================================');
    console.log('✅ PDH/PDL Bootstrap Test Complete');
    console.log('========================================\n');
    
    if (strategy.state.pdhPdlLevels.bootstrapped && strategy.state.pdhPdlLevels.validRthCalculation) {
        console.log('🎉 SUCCESS: PDH/PDL values were successfully bootstrapped from historical data!');
        console.log('📈 The strategy can now generate signals immediately without waiting for live candles.');
        return true;
    } else {
        console.log('⚠️ WARNING: PDH/PDL bootstrap may have failed or Connection Manager is not running.');
        console.log('💡 Make sure the Connection Manager is running on port 7500.');
        return false;
    }
}

// Run the test
testPDHBootstrap().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 Test failed with error:', error);
    process.exit(1);
});