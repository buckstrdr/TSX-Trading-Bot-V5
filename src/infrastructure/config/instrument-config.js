/**
 * Instrument Configuration Manager
 * Loads and provides instrument-specific settings like dollar per point
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

class InstrumentConfig {
    constructor() {
        this.instruments = {};
        this.loaded = false;
    }
    
    async load() {
        try {
            const configPath = path.join(__dirname, '../../../config/instruments.yaml');
            const fileContent = fs.readFileSync(configPath, 'utf8');
            const config = yaml.parse(fileContent);
            
            this.instruments = config.instruments || {};
            this.loaded = true;
            
            console.log('📊 Loaded instrument configurations for:', Object.keys(this.instruments));
            return true;
        } catch (error) {
            console.error('❌ Failed to load instrument config:', error.message);
            return false;
        }
    }
    
    getInstrument(symbol) {
        if (!this.loaded) {
            console.warn('⚠️ Instrument config not loaded, using defaults');
            return this.getDefaults(symbol);
        }
        
        return this.instruments[symbol] || this.getDefaults(symbol);
    }
    
    getDollarPerPoint(symbol) {
        const instrument = this.getInstrument(symbol);
        return instrument.dollarPerPoint;
    }
    
    getDefaults(symbol) {
        // Default values if instrument not found
        const defaults = {
            'CON.F.US.MES.U25': { dollarPerPoint: 5, tickSize: 0.25, tickValue: 1.25 },
            'CON.F.US.MNQ.U25': { dollarPerPoint: 2, tickSize: 0.25, tickValue: 0.50 },
            'CON.F.US.M2K.U25': { dollarPerPoint: 5, tickSize: 0.1, tickValue: 0.50 },
            'CON.F.US.MYM.U25': { dollarPerPoint: 0.50, tickSize: 1, tickValue: 0.50 },
            'CON.F.US.MGC.U25': { dollarPerPoint: 10, tickSize: 0.1, tickValue: 1.00 },
            'CON.F.US.M6E.U25': { dollarPerPoint: 12.50, tickSize: 0.0001, tickValue: 1.25 }
        };
        
        return defaults[symbol] || { dollarPerPoint: 10, tickSize: 0.1, tickValue: 1.00 };
    }
}

// Export singleton instance
module.exports = new InstrumentConfig();