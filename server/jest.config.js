module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.(e2e-spec|spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: true }] },
  setupFiles: ['<rootDir>/test/test-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
  maxWorkers: 1,   // الملفات تشترك بقاعدة وحدة وبحالة TOTP، فتتنفذ ورا بعض
};
