import { describe, expect, it } from 'vitest';
import { renderLinkPage } from '../../src/link/page.js';

function inlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('no inline <script> block found');
  return match[1];
}

describe('renderLinkPage', () => {
  it('loads Plaid Link from the official CDN', () => {
    const html = renderLinkPage('create');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(
      '<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>',
    );
  });

  it('shows a Connect bank button in create mode', () => {
    const html = renderLinkPage('create');
    expect(html).toContain('>Connect bank</button>');
    expect(html).not.toContain('Fix bank login');
  });

  it('shows a Fix bank login button in update mode', () => {
    const html = renderLinkPage('update');
    expect(html).toContain('>Fix bank login</button>');
    expect(html).not.toContain('>Connect bank</button>');
  });

  it('wires the link-token and complete endpoints to Plaid.create callbacks', () => {
    const script = inlineScript(renderLinkPage('create'));
    expect(script).toContain("postJson('/api/link-token')");
    expect(script).toContain('Plaid.create({');
    expect(script).toContain('onSuccess: function (public_token, metadata)');
    expect(script).toContain('onExit: function (err, metadata)');
    expect(script).toContain("postJson('/api/complete', { publicToken: publicToken })");
    expect(script).toContain('err.display_message || err.error_message');
    expect(script).toContain('Done — return to your terminal.');
  });

  it('embeds syntactically valid JavaScript', () => {
    for (const mode of ['create', 'update'] as const) {
      const script = inlineScript(renderLinkPage(mode));
      // Parses (does not run) the script; throws SyntaxError if the template broke it.
      expect(() => new Function(script)).not.toThrow();
    }
  });
});
