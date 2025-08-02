// Silent console wrapper for services
// Checks for silent mode and suppresses console output accordingly

const isSilent = () => {
    return process.env.SILENT_MODE === 'true' || 
           process.argv.includes('--silent') || 
           process.argv.includes('-s');
};

// Create a wrapper for console methods
const silentConsole = {
    log: (...args) => {
        if (!isSilent()) {
            console.log(...args);
        }
    },
    
    error: (...args) => {
        // Always show errors even in silent mode, but they go to file logger
        if (!isSilent()) {
            console.error(...args);
        }
    },
    
    warn: (...args) => {
        if (!isSilent()) {
            console.warn(...args);
        }
    },
    
    info: (...args) => {
        if (!isSilent()) {
            console.info(...args);
        }
    },
    
    debug: (...args) => {
        if (!isSilent()) {
            console.debug(...args);
        }
    }
};

// Replace global console if running in silent mode
if (isSilent()) {
    console.log('[Silent Mode] Console output suppressed. Check log files for output.');
    
    // Store original console for critical errors
    global._originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info,
        debug: console.debug
    };
    
    // Replace console methods
    console.log = silentConsole.log;
    console.error = silentConsole.error;
    console.warn = silentConsole.warn;
    console.info = silentConsole.info;
    console.debug = silentConsole.debug;
}

module.exports = {
    isSilent,
    silentConsole,
    restoreConsole: () => {
        if (global._originalConsole) {
            console.log = global._originalConsole.log;
            console.error = global._originalConsole.error;
            console.warn = global._originalConsole.warn;
            console.info = global._originalConsole.info;
            console.debug = global._originalConsole.debug;
        }
    }
};