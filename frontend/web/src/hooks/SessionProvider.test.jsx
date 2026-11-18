import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api.js';
import { NotInvitedError, completeSignIn } from '../lib/auth.js';
import { SessionProvider } from './SessionProvider.jsx';
import { useSession } from './useSession.js';

vi.mock('../lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  completeSignIn: vi.fn(),
}));

function Status() {
  return <p>{useSession().status}</p>;
}

describe('returning from sign-in', () => {
  beforeEach(() => {
    vi.mocked(completeSignIn).mockReset();
    window.history.pushState(null, '', '/auth/callback?code=abc&state=xyz');
  });

  it.each([
    ['an uninvited first sign-in', new NotInvitedError()],
    ['a removed member refused during the code exchange', new ApiError(403, 'forbidden')],
  ])('shows the not-invited screen for %s', async (_name, error) => {
    vi.mocked(completeSignIn).mockRejectedValue(error);
    render(
      <SessionProvider>
        <Status />
      </SessionProvider>,
    );
    expect(await screen.findByText('notInvited')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
  });

  it('shows the failure screen for any other error', async () => {
    vi.mocked(completeSignIn).mockRejectedValue(new ApiError(500, 'internal_error'));
    render(
      <SessionProvider>
        <Status />
      </SessionProvider>,
    );
    expect(await screen.findByText('failed')).toBeTruthy();
  });
});
