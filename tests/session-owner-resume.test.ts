import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeCommandForSession, wrapResumeCommandForOwner } from '../server/session-service.js';

test('other OS users resume through their login environment', () => {
  assert.equal(
    resumeCommandForSession('codex', '01a0b4f8-1da8-7e40-adc5-3b1f1f387bce', 'ds'),
    "sudo -iu 'ds' bash -lc 'codex resume 01a0b4f8-1da8-7e40-adc5-3b1f1f387bce'",
  );
  assert.equal(
    resumeCommandForSession('claude', 'test-session', 'glm'),
    "sudo -iu 'glm' bash -lc 'claude --resume test-session'",
  );
  assert.equal(
    wrapResumeCommandForOwner("printf '%s' hello", 'ds'),
    "sudo -iu 'ds' bash -lc 'printf '\\''%s'\\'' hello'",
  );
});
