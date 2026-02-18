import type { Config } from 'jest';
import { createJestConfig } from '../../../jest.config.base';

const config: Config = createJestConfig('@polymarket/logger');

export default config;
