/**
 * Contract month mapping and utilities for futures contracts
 * 
 * CME Futures Contract Month Codes:
 * F = January     G = February    H = March
 * J = April       K = May         M = June
 * N = July        Q = August      U = September
 * V = October     X = November    Z = December
 */

class ContractMonths {
    static MONTH_CODES = {
        1: 'F',   // January
        2: 'G',   // February
        3: 'H',   // March
        4: 'J',   // April
        5: 'K',   // May
        6: 'M',   // June
        7: 'N',   // July
        8: 'Q',   // August
        9: 'U',   // September
        10: 'V',  // October
        11: 'X',  // November
        12: 'Z'   // December
    };

    static CODE_TO_MONTH = {
        'F': 1, 'G': 2, 'H': 3, 'J': 4, 'K': 5, 'M': 6,
        'N': 7, 'Q': 8, 'U': 9, 'V': 10, 'X': 11, 'Z': 12
    };

    /**
     * Contract rollover schedules by product
     * These are approximate - actual rollover dates vary
     */
    static ROLLOVER_SCHEDULE = {
        // Gold typically trades quarterly (Mar, Jun, Sep, Dec)
        // But micro gold (MGC) often uses Dec as primary
        'MGC': {
            activeMonths: [3, 6, 9, 12], // H, M, U, Z
            preferredMonth: 12, // Z (December)
            rolloverDaysBefore: 5
        },
        // Equity indices typically trade quarterly
        'MES': {
            activeMonths: [3, 6, 9, 12], // H, M, U, Z
            rolloverDaysBefore: 8
        },
        'MNQ': {
            activeMonths: [3, 6, 9, 12], // H, M, U, Z
            rolloverDaysBefore: 8
        },
        'M2K': {
            activeMonths: [3, 6, 9, 12], // H, M, U, Z
            rolloverDaysBefore: 8
        },
        'MYM': {
            activeMonths: [3, 6, 9, 12], // H, M, U, Z
            rolloverDaysBefore: 8
        },
        // Currencies often trade all months
        'M6E': {
            activeMonths: [3, 6, 9, 12], // Quarterly for micros
            rolloverDaysBefore: 5
        },
        // Crude oil trades all months
        'MCL': {
            activeMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], // All months
            rolloverDaysBefore: 3
        }
    };

    /**
     * Get the currently active contract month for a symbol
     * @param {string} symbol - The base symbol (e.g., 'MGC', 'MES')
     * @param {Date} currentDate - Current date (optional, defaults to now)
     * @returns {string} The contract month code and year (e.g., 'Z25')
     */
    static getActiveContractMonth(symbol, currentDate = new Date()) {
        const schedule = this.ROLLOVER_SCHEDULE[symbol];
        if (!schedule) {
            // Default to next quarterly month
            return this.getNextQuarterlyMonth(currentDate);
        }

        // Special handling for MGC - prefer December
        if (symbol === 'MGC' && schedule.preferredMonth) {
            const currentYear = currentDate.getFullYear();
            const preferredMonthCode = this.MONTH_CODES[schedule.preferredMonth];
            const yearSuffix = String(currentYear).slice(-2);
            
            // Check if December contract is still active
            const decemberDate = new Date(currentYear, schedule.preferredMonth - 1, 15);
            if (currentDate < decemberDate) {
                return `${preferredMonthCode}${yearSuffix}`;
            } else {
                // Roll to next year's December
                return `${preferredMonthCode}${String(currentYear + 1).slice(-2)}`;
            }
        }

        // For other contracts, find the next active month
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();
        
        // Find next active month
        let targetMonth = schedule.activeMonths.find(month => month >= currentMonth);
        let targetYear = currentYear;
        
        if (!targetMonth) {
            // Roll to next year
            targetMonth = schedule.activeMonths[0];
            targetYear = currentYear + 1;
        }

        const monthCode = this.MONTH_CODES[targetMonth];
        const yearSuffix = String(targetYear).slice(-2);
        
        return `${monthCode}${yearSuffix}`;
    }

    /**
     * Get next quarterly contract month
     * @param {Date} currentDate - Current date
     * @returns {string} The contract month code and year (e.g., 'U25')
     */
    static getNextQuarterlyMonth(currentDate = new Date()) {
        const quarterlyMonths = [3, 6, 9, 12]; // H, M, U, Z
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();
        
        let targetMonth = quarterlyMonths.find(month => month > currentMonth);
        let targetYear = currentYear;
        
        if (!targetMonth) {
            // Roll to next year
            targetMonth = quarterlyMonths[0];
            targetYear = currentYear + 1;
        }

        const monthCode = this.MONTH_CODES[targetMonth];
        const yearSuffix = String(targetYear).slice(-2);
        
        return `${monthCode}${yearSuffix}`;
    }

    /**
     * Parse a contract ID to extract components
     * @param {string} contractId - Full contract ID (e.g., 'CON.F.US.MGC.Z25')
     * @returns {object} Parsed components
     */
    static parseContractId(contractId) {
        const parts = contractId.split('.');
        if (parts.length !== 5) {
            throw new Error(`Invalid contract ID format: ${contractId}`);
        }

        const monthYear = parts[4];
        const monthCode = monthYear[0];
        const year = monthYear.slice(1);
        
        return {
            prefix: parts[0],      // CON
            type: parts[1],        // F
            exchange: parts[2],    // US
            symbol: parts[3],      // MGC
            monthYear: monthYear,  // Z25
            monthCode: monthCode,  // Z
            year: year,           // 25
            month: this.CODE_TO_MONTH[monthCode] || null
        };
    }

    /**
     * Build a contract ID from components
     * @param {string} symbol - Base symbol (e.g., 'MGC')
     * @param {string} monthYear - Month and year code (e.g., 'Z25')
     * @returns {string} Full contract ID
     */
    static buildContractId(symbol, monthYear) {
        return `CON.F.US.${symbol}.${monthYear}`;
    }

    /**
     * Get the active contract ID for a symbol
     * @param {string} symbol - Base symbol (e.g., 'MGC')
     * @param {Date} currentDate - Current date (optional)
     * @returns {string} Full contract ID with active month
     */
    static getActiveContractId(symbol, currentDate = new Date()) {
        const monthYear = this.getActiveContractMonth(symbol, currentDate);
        return this.buildContractId(symbol, monthYear);
    }

    /**
     * Update a contract ID to use the active month
     * @param {string} contractId - Current contract ID
     * @param {Date} currentDate - Current date (optional)
     * @returns {string} Updated contract ID with active month
     */
    static updateToActiveMonth(contractId, currentDate = new Date()) {
        const parsed = this.parseContractId(contractId);
        const activeMonth = this.getActiveContractMonth(parsed.symbol, currentDate);
        return this.buildContractId(parsed.symbol, activeMonth);
    }

    /**
     * Check if a contract month is likely expired
     * @param {string} monthYear - Month and year code (e.g., 'Q25')
     * @param {Date} currentDate - Current date (optional)
     * @returns {boolean} True if likely expired
     */
    static isLikelyExpired(monthYear, currentDate = new Date()) {
        const monthCode = monthYear[0];
        const year = parseInt('20' + monthYear.slice(1));
        const month = this.CODE_TO_MONTH[monthCode];
        
        if (!month) return true;
        
        // Create date for the 20th of the contract month (typical expiry)
        const expiryDate = new Date(year, month - 1, 20);
        
        return currentDate > expiryDate;
    }
}

module.exports = ContractMonths;