#!/usr/bin/env node

const scenarioFlagIndex = process.argv.indexOf('--fake-scenario');
const scenario =
  scenarioFlagIndex >= 0 && process.argv[scenarioFlagIndex + 1]
    ? process.argv[scenarioFlagIndex + 1]
    : process.env.FAKE_CODEX_SCENARIO || 'complete';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv.includes('--version')) {
  console.log('fake-codex-worker 1.0.0');
  process.exit(0);
}

switch (scenario) {
  case 'complete': {
    console.log('Fake Codex worker started');
    await delay(20);
    console.log('Implemented requested change');
    process.exit(0);
    break;
  }
  case 'stuck': {
    await delay(10_000);
    process.exit(0);
    break;
  }
  case 'auth-failed': {
    console.error('Authentication failed: 401 Unauthorized');
    process.exit(1);
    break;
  }
  case 'waiting-confirmation': {
    console.log('Preparing to continue');
    console.log('Press enter to continue?');
    await delay(10_000);
    process.exit(0);
    break;
  }
  case 'structured-report': {
    console.log('Work finished');
    console.log('STATUS: completed');
    console.log('CHANGED_FILES: server/codex-jobs.ts, tests/codex-worker.e2e.test.ts');
    console.log('TESTS: npm run test:codex-worker');
    console.log('NEXT_ACTION: none');
    process.exit(0);
    break;
  }
  case 'hermes-dispatch-e2e': {
    const prompt = process.argv.at(-1) || '';
    console.log('Fake Hermes worker started');
    console.log(prompt.includes('Hermes dispatch E2E') ? 'PROMPT_OK' : 'PROMPT_MISSING_TASK');
    await delay(80);
    console.log('Hermes dispatch chain finished');
    console.log('STATUS: completed');
    console.log('CHANGED_FILES: tests/hermes-dispatch.e2e.test.ts, tests/fixtures/fake-codex-worker.mjs');
    console.log('TESTS: npm run test:hermes-dispatch');
    console.log('NEXT_ACTION: none');
    await delay(20);
    process.exit(prompt.includes('Hermes dispatch E2E') ? 0 : 3);
    break;
  }
  case 'policy-stop': {
    console.log('About to run: git push origin main');
    await delay(10_000);
    process.exit(0);
    break;
  }
  default: {
    console.error(`Unknown FAKE_CODEX_SCENARIO: ${scenario}`);
    process.exit(2);
  }
}
