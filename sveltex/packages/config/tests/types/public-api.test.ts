import { defineConfig, mergeConfig, validateConfig } from '../../dist/index.js';
const config = defineConfig({ app: { name: 'demo' } });
const merged = mergeConfig({ enabled: true }, { enabled: false });
const result = validateConfig(merged, (value): value is { enabled: boolean } => typeof value === 'object' && value !== null && 'enabled' in value);
void [config, result];
