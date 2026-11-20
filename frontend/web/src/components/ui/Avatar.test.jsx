import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n/index.js';
import { Avatar } from './Avatar.jsx';

describe('Avatar', () => {
  it('shows the emoji in place of the initials', () => {
    render(<Avatar name="Ana Pérez" tone="sage" avatar="🦊" />);
    const avatar = screen.getByRole('img', { name: 'Ana Pérez' });
    expect(avatar.textContent).toBe(i18n.t('common:avatar.emoji', { emoji: '🦊' }));
  });

  it('shows the initials of someone saved before avatars, not a made-up emoji', () => {
    render(<Avatar name="Ana Pérez" tone="sage" />);
    const avatar = screen.getByRole('img', { name: 'Ana Pérez' });
    expect(avatar.textContent).toBe(i18n.t('common:avatar.initials', { initials: 'AP' }));
  });

  it('keeps the tone behind the emoji', () => {
    render(<Avatar name="Ana Pérez" tone="lagoon" avatar="🦊" />);
    expect(screen.getByRole('img', { name: 'Ana Pérez' }).className).toContain('fa-avatar--lagoon');
  });
});
