import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { triageUser } from '../src/triage.mjs';
import { WRITER_SYSTEM, parseWriterOutput, writerPrefix } from '../src/writer.mjs';

describe('writer output parser', () => {
  test('takes the outer four-backtick fence even with inner code fences', () => {
    const out = 'Sure.\n````markdown\n# Title\n\n```bash\nnpm test\n```\n\nEnd.\n````\nDone.';
    assert.equal(parseWriterOutput(out), '# Title\n\n```bash\nnpm test\n```\n\nEnd.\n');
  });
  test('tolerates a three-backtick fence by taking the last closing fence', () => {
    const out = '```md\n# T\n```js\nx\n```\ntail\n```';
    assert.equal(parseWriterOutput(out), '# T\n```js\nx\n```\ntail\n');
  });
  test('rejects output with no fence or no closing fence', () => {
    assert.equal(parseWriterOutput('# Just prose'), null);
    assert.equal(parseWriterOutput('````\nunclosed'), null);
  });
});

describe('writer prefix and deletes', () => {
  test('the prefix lists deletes after everything triage saw, and nothing when there are none', () => {
    const base = { guidelines: 'g', narrative: 'n', diff: 'd', manifest: 'm' };
    const prefix = writerPrefix({ ...base, deleted: [{ path: 'docs/gone.md', reason: 'app removed' }] });
    assert.ok(prefix.startsWith(triageUser(base)));
    assert.ok(prefix.endsWith('<deleted_this_run>\n- docs/gone.md: app removed\n</deleted_this_run>'));
    assert.equal(writerPrefix({ ...base, deleted: [] }), triageUser(base));
    assert.match(WRITER_SYSTEM, /Never link to a doc listed in <deleted_this_run>/);
  });
});
