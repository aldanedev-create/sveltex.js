#!/usr/bin/env node
import { runCli } from './router.js';
import { defaultRunner } from './package-manager/run.js';
import { renderResult } from './terminal/output.js';

const argv = process.argv.slice(2);
const json = argv.includes('--json') || argv.includes('--json=true');

const result = await runCli({
  argv,
  cwd: process.cwd(),
  env: process.env,
  runner: defaultRunner,
  nodeVersion: process.versions.node,
  now: () => Date.now(),
});

const output = renderResult(result, json);
if (output !== '') process.stdout.write(`${output}\n`);
process.exitCode = result.exitCode;
