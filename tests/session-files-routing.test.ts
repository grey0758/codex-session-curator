import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filesPageUrl,
  readFilesPageRoute,
  readTerminalPageRoute,
  sessionFileDownloadUrl,
  sessionFilesDetailUrl,
  sessionFilesListUrl,
  sessionFileUploadUrl,
  terminalPageUrl,
} from '../src/session-files-routing.js';

const sessionId = 'duplicate/session id';
const machineId = 'cnal002';
const agent = 'claude';

function query(url: string): URLSearchParams {
  return new URL(url, 'https://curator.test').searchParams;
}

test('files page preserves the selected composite identity in its standalone URL', () => {
  const pageUrl = filesPageUrl(
    sessionId,
    machineId,
    agent,
    'https://curator.test/panel?stale=1#detail'
  );
  const parsed = new URL(pageUrl);

  assert.equal(parsed.pathname, '/panel');
  assert.equal(parsed.hash, '');
  assert.equal(parsed.searchParams.get('stale'), null);
  assert.equal(parsed.searchParams.get('files'), sessionId);
  assert.equal(parsed.searchParams.get('machine'), machineId);
  assert.equal(parsed.searchParams.get('agent'), agent);
  assert.deepEqual(readFilesPageRoute(pageUrl), { sessionId, machineId, agent });
});

test('files page detail, list, download, and upload requests retain composite identity', () => {
  const pageRoute = readFilesPageRoute(
    filesPageUrl(sessionId, machineId, agent, 'https://curator.test/')
  );
  assert.equal(pageRoute.sessionId, sessionId);
  assert.equal(pageRoute.machineId, machineId);
  assert.equal(pageRoute.agent, agent);
  if (!pageRoute.sessionId || !pageRoute.machineId || !pageRoute.agent) {
    assert.fail('files page route lost its composite identity');
  }

  const urls = [
    sessionFilesDetailUrl(pageRoute.sessionId, pageRoute.machineId, pageRoute.agent),
    sessionFilesListUrl(pageRoute.sessionId, pageRoute.machineId, pageRoute.agent, 'logs/today'),
    sessionFileDownloadUrl(
      pageRoute.sessionId,
      pageRoute.machineId,
      pageRoute.agent,
      'logs/output 1.txt'
    ),
    sessionFileUploadUrl(
      pageRoute.sessionId,
      pageRoute.machineId,
      pageRoute.agent,
      'uploads',
      'report 1.txt'
    ),
  ];
  for (const url of urls) {
    assert.equal(query(url).get('machineId'), machineId);
    assert.equal(query(url).get('agent'), agent);
    assert.match(url, /duplicate%2Fsession%20id/);
  }

  assert.equal(query(urls[1]).get('path'), 'logs/today');
  assert.equal(query(urls[2]).get('path'), 'logs/output 1.txt');
  assert.equal(query(urls[3]).get('path'), 'uploads');
  assert.equal(query(urls[3]).get('name'), 'report 1.txt');
  assert.equal(query(urls[3]).get('overwrite'), '1');
});

test('files route accepts machineId aliases but never invents a missing machine', () => {
  assert.deepEqual(
    readFilesPageRoute(
      'https://curator.test/?files=session-1&machineId=us002&agent=codex'
    ),
    { sessionId: 'session-1', machineId: 'us002', agent: 'codex' }
  );
  assert.deepEqual(
    readFilesPageRoute('https://curator.test/?files=session-1&agent=codex'),
    { sessionId: 'session-1', machineId: null, agent: 'codex' }
  );
});

test('files route fails closed when agent is absent or invalid', () => {
  assert.deepEqual(
    readFilesPageRoute('https://curator.test/?files=session-1&machine=us002'),
    { sessionId: 'session-1', machineId: 'us002', agent: null }
  );
  assert.deepEqual(
    readFilesPageRoute(
      'https://curator.test/?files=session-1&machine=us002&agent=unknown'
    ),
    { sessionId: 'session-1', machineId: 'us002', agent: null }
  );
});

test('terminal page preserves composite identity and fails closed when incomplete', () => {
  const pageUrl = terminalPageUrl(
    sessionId,
    machineId,
    agent,
    'https://curator.test/panel?stale=1#detail'
  );
  const parsed = new URL(pageUrl);

  assert.equal(parsed.pathname, '/panel');
  assert.equal(parsed.hash, '');
  assert.equal(parsed.searchParams.get('stale'), null);
  assert.deepEqual(readTerminalPageRoute(pageUrl), {
    sessionId,
    machineId,
    agent,
  });
  assert.deepEqual(
    readTerminalPageRoute(
      'https://curator.test/?terminal=session-1&machineId=us002'
    ),
    { sessionId: 'session-1', machineId: 'us002', agent: null }
  );
  assert.deepEqual(
    readTerminalPageRoute(
      'https://curator.test/?terminal=session-1&agent=codex'
    ),
    { sessionId: 'session-1', machineId: null, agent: 'codex' }
  );
});
