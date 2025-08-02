module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    'connection-manager/**/*.js',
    'fake-api/**/*.js',
    '!src/**/*.test.js',
    '!src/**/index.js',
    '!**/backup-*/**'
  ],
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js',
    '**/__tests__/**/*.js'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/backup-.*/',
    '/.git/'
  ],
  verbose: true,
  testTimeout: 30000,
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  }
};