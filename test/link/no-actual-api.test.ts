import { describe, expect, it, vi } from 'vitest';

// Task 10's CLI relies on `link` (and `--help`) never pulling in `@actual-app/api`, so that
// those paths stay fast and don't require an Actual server to be reachable. Prove that none of
// the link modules import it, even transitively: if any of them did, this mock would throw
// during the import below and fail the test.
vi.mock('@actual-app/api', () => {
  throw new Error('must not load @actual-app/api');
});

describe('src/link modules', () => {
  it('do not load @actual-app/api', async () => {
    const [server, plaidLink, page] = await Promise.all([
      import('../../src/link/server.js'),
      import('../../src/link/plaid-link.js'),
      import('../../src/link/page.js'),
    ]);

    expect(typeof server.startLinkServer).toBe('function');
    expect(typeof plaidLink.createLinkDeps).toBe('function');
    expect(typeof page.renderLinkPage).toBe('function');
  });
});
