import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n, { DEFAULT_LOCALE, catalogs } from '../i18n/index.js';
import App from '../App.jsx';
import { ApiError } from '../lib/api.js';
import { useSession } from '../hooks/useSession.js';
import { saveProfile } from '../lib/expenses.js';

vi.mock('../hooks/useSession.js', () => ({ useSession: vi.fn() }));
// The signed-in screen stays on its loading state: these tests are about the session screens.
vi.mock('../lib/expenses.js', () => ({
  fetchLedger: vi.fn(() => new Promise(() => {})),
  saveProfile: vi.fn(),
}));

const MEMBER = {
  email: 'ana@example.test',
  name: 'Ana Pérez',
  memberId: 'ana',
  displayName: 'Ana Pérez',
  homeCurrency: 'CAD',
};

const STATES = {
  loading: {},
  signedOut: {},
  notInvited: {},
  failed: { errorCode: 'internal_error' },
  needsProfile: {
    member: { ...MEMBER, memberId: null, displayName: null, homeCurrency: null },
  },
  signedIn: { member: MEMBER },
};

function session(status, overrides = {}) {
  return {
    status,
    ...STATES[status],
    signIn: vi.fn(),
    signOut: vi.fn(),
    retry: vi.fn(),
    getToken: () => 'token',
    renewToken: vi.fn(),
    updateMember: vi.fn(),
    ...overrides,
  };
}

describe('screens', () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReset();
  });

  it('starts sign-in from the sign-in screen', async () => {
    const value = session('signedOut');
    vi.mocked(useSession).mockReturnValue(value);
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: i18n.t('auth:signIn.button') }));
    expect(value.signIn).toHaveBeenCalledOnce();
  });

  it('greets the member by first name and signs out', async () => {
    const value = session('signedIn');
    vi.mocked(useSession).mockReturnValue(value);
    render(<App />);
    expect(
      screen.getByRole('heading', { name: i18n.t('dashboard:greeting', { name: 'Ana' }) }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: i18n.t('common:actions.signOut') }));
    expect(value.signOut).toHaveBeenCalledOnce();
  });

  it('greets without a name when the profile has none', () => {
    vi.mocked(useSession).mockReturnValue(
      session('signedIn', { member: { ...MEMBER, name: null, displayName: '' } }),
    );
    render(<App />);
    expect(screen.getByRole('heading', { name: i18n.t('dashboard:greetingFallback') })).toBeTruthy();
  });

  describe('the first sign-in step', () => {
    beforeEach(() => {
      vi.mocked(saveProfile).mockReset();
    });

    it('starts from the account name and waits for a currency', () => {
      vi.mocked(useSession).mockReturnValue(session('needsProfile'));
      render(<App />);
      expect(screen.getByLabelText(i18n.t('auth:profile.name')).value).toBe('Ana Pérez');
      expect(screen.getByRole('button', { name: i18n.t('auth:profile.submit') }).disabled).toBe(true);
    });

    it('saves the name and currency, then becomes a member', async () => {
      const value = session('needsProfile');
      vi.mocked(useSession).mockReturnValue(value);
      vi.mocked(saveProfile).mockResolvedValue(MEMBER);
      render(<App />);

      const name = screen.getByLabelText(i18n.t('auth:profile.name'));
      await userEvent.clear(name);
      await userEvent.type(name, '  Anita ');
      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CLP') }));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('auth:profile.submit') }));

      expect(vi.mocked(saveProfile).mock.calls[0][1]).toEqual({
        displayName: 'Anita',
        homeCurrency: 'CLP',
      });
      expect(value.updateMember).toHaveBeenCalledWith(MEMBER);
    });

    it('keeps the step open and explains when saving fails', async () => {
      const value = session('needsProfile');
      vi.mocked(useSession).mockReturnValue(value);
      vi.mocked(saveProfile).mockRejectedValue(new ApiError(400, 'validation_error'));
      render(<App />);

      await userEvent.click(screen.getByRole('button', { name: i18n.t('expenses:currencies.CAD') }));
      await userEvent.click(screen.getByRole('button', { name: i18n.t('auth:profile.submit') }));
      expect(await screen.findByText(i18n.t('common:errors.validation_error'))).toBeTruthy();
      expect(value.updateMember).not.toHaveBeenCalled();
    });
  });

  it('explains the refusal to someone who is not invited', () => {
    vi.mocked(useSession).mockReturnValue(session('notInvited'));
    render(<App />);
    expect(screen.getByRole('heading', { name: i18n.t('auth:notInvited.title') })).toBeTruthy();
  });

  it('translates the error code on the failure screen and offers a retry', async () => {
    const value = session('failed');
    vi.mocked(useSession).mockReturnValue(value);
    render(<App />);
    expect(screen.getByText(i18n.t('common:errors.internal_error'))).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: i18n.t('common:actions.retry') }));
    expect(value.retry).toHaveBeenCalledOnce();
  });
});

// Proves a new language needs only a catalog: every visible string must come from the test locale.
describe('with a throwaway locale', () => {
  const MARK = '§';

  function pseudo(messages) {
    return Object.fromEntries(
      Object.entries(messages).map(([key, value]) => [
        key,
        typeof value === 'object' ? pseudo(value) : `${MARK}${value}`,
      ]),
    );
  }

  beforeAll(async () => {
    for (const [namespace, messages] of Object.entries(catalogs[DEFAULT_LOCALE])) {
      i18n.addResourceBundle('zz-ZZ', namespace, pseudo(messages));
    }
    await i18n.changeLanguage('zz-ZZ');
  });

  afterAll(async () => {
    await i18n.changeLanguage(DEFAULT_LOCALE);
  });

  it.each(Object.keys(STATES))('renders the %s screen entirely from the catalog', (status) => {
    vi.mocked(useSession).mockReturnValue(session(status));
    const { container } = render(<App />);

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (text) texts.push(text);
    }
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((text) => !text.startsWith(MARK))).toEqual([]);
  });

  it('keeps the document language in sync', () => {
    expect(document.documentElement.lang).toBe('zz-ZZ');
  });
});
