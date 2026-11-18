import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotInvitedError, completeSignIn, restoreSession } from './auth.js';
import { ApiError, apiFetch } from './api.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: vi.fn(),
}));

const pending = { state: 'the-state', verifier: 'the-verifier' };

describe('completeSignIn', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    sessionStorage.setItem('fa_oauth_pending', JSON.stringify(pending));
  });

  it('exchanges the code with the stored verifier and clears it', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ idToken: 'id-token' });
    await expect(completeSignIn('?code=abc&state=the-state')).resolves.toBe('id-token');
    expect(apiFetch).toHaveBeenCalledWith('/auth/session', {
      method: 'POST',
      body: { code: 'abc', codeVerifier: 'the-verifier' },
    });
    expect(sessionStorage.getItem('fa_oauth_pending')).toBeNull();
  });

  it('refuses a response whose state does not match', async () => {
    await expect(completeSignIn('?code=abc&state=forged')).rejects.toBeInstanceOf(ApiError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('recognizes the allowlist refusal from the Cognito trigger', async () => {
    const search = '?error=access_denied&error_description=PreSignUp+failed+with+error+not_invited.';
    await expect(completeSignIn(search)).rejects.toBeInstanceOf(NotInvitedError);
  });
});

describe('restoreSession', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('returns null when there is no session', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError(401, 'unauthorized'));
    await expect(restoreSession()).resolves.toBeNull();
  });

  it('surfaces other failures', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError(500, 'internal_error'));
    await expect(restoreSession()).rejects.toBeInstanceOf(ApiError);
  });
});
