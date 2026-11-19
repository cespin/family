import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../lib/api.js';
import { NotInvitedError, completeSignIn, restoreSession } from '../lib/auth.js';
import { SessionProvider } from './SessionProvider.jsx';
import { useSession } from './useSession.js';

vi.mock('../lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  completeSignIn: vi.fn(),
  restoreSession: vi.fn(),
}));
vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}));

function Status() {
  return <p>{useSession().status}</p>;
}

const ME = { email: 'ana@example.test', name: 'Ana', memberId: 'ana', displayName: 'Ana' };
const NEW = { email: 'ana@example.test', name: 'Ana', memberId: null, displayName: null };

describe('a signed-in account', () => {
  beforeEach(() => {
    vi.mocked(completeSignIn).mockReset();
    vi.mocked(restoreSession).mockReset();
    vi.mocked(apiFetch).mockReset();
    window.history.pushState(null, '', '/');
    vi.mocked(restoreSession).mockResolvedValue('token-1');
  });

  it('is a member once the first sign-in step is done', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ME);
    render(
      <SessionProvider>
        <Status />
      </SessionProvider>,
    );
    expect(await screen.findByText('signedIn')).toBeTruthy();
  });

  it('is asked for a profile before entering', async () => {
    vi.mocked(apiFetch).mockResolvedValue(NEW);
    render(
      <SessionProvider>
        <Status />
      </SessionProvider>,
    );
    expect(await screen.findByText('needsProfile')).toBeTruthy();
  });

  it('enters once the profile is saved', async () => {
    vi.mocked(apiFetch).mockResolvedValue(NEW);
    function Finish() {
      const { status, updateMember } = useSession();
      return (
        <button type="button" onClick={() => updateMember(ME)}>
          {status}
        </button>
      );
    }
    render(
      <SessionProvider>
        <Finish />
      </SessionProvider>,
    );
    (await screen.findByText('needsProfile')).click();
    expect(await screen.findByText('signedIn')).toBeTruthy();
  });

  it('renews an expired token from the cookie, or signs out when the session ended', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ME);
    const captured = {};
    function Renew() {
      const session = useSession();
      useEffect(() => {
        captured.renew = session.renewToken;
      });
      return <p>{session.status}</p>;
    }
    render(
      <SessionProvider>
        <Renew />
      </SessionProvider>,
    );
    await screen.findByText('signedIn');

    vi.mocked(restoreSession).mockResolvedValueOnce('token-2');
    await expect(captured.renew()).resolves.toBe('token-2');

    vi.mocked(restoreSession).mockResolvedValueOnce(null);
    await expect(captured.renew()).resolves.toBeNull();
    expect(await screen.findByText('signedOut')).toBeTruthy();
  });
});

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
