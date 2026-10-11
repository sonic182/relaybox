import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        globalSetup: ['tests/globalSetup.ts'],
        setupFiles: ['tests/setup.ts'],
        clearMocks: true,
        restoreMocks: true,
        fileParallelism: false,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/index.ts', 'src/db.ts', 'src/**/*.d.ts'],
        },
    },
});
