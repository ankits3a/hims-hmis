module.exports = { preset: "ts-jest", testEnvironment: "node", testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"], testTimeout: 15000, setupFiles: ["<rootDir>/test/helpers/env.ts"] };
