import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n/index.js';
import { AvatarPicker } from './AvatarPicker.jsx';

const OPTIONS = ['🐵', '🐒', '🦊'];

const option = (emoji) =>
  screen.getByRole('radio', { name: i18n.t('common:avatar.option', { emoji }) });

function Picker({ start = '🐵', onChange = () => {} }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <p id="label">Avatar</p>
      <AvatarPicker
        labelledBy="label"
        options={OPTIONS}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </>
  );
}

describe('AvatarPicker', () => {
  it('marks only the chosen emoji as checked', async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    await userEvent.click(option('🦊'));
    expect(onChange).toHaveBeenCalledWith('🦊');
    expect(option('🦊').getAttribute('aria-checked')).toBe('true');
    expect(option('🐵').getAttribute('aria-checked')).toBe('false');
  });

  it('is one tab stop, on the chosen emoji', async () => {
    render(<Picker start="🐒" />);
    await userEvent.tab();
    expect(document.activeElement).toBe(option('🐒'));
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it('moves the choice with the arrow keys, wrapping at the ends', async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(option('🐒'));
    expect(onChange).toHaveBeenLastCalledWith('🐒');
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('🦊');
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('🐵');
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(option('🦊'));
  });

  it('lets the first emoji take the focus when none is chosen yet', async () => {
    render(<Picker start={null} />);
    await userEvent.tab();
    expect(document.activeElement).toBe(option('🐵'));
    const checked = screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'));
    expect(checked).toEqual(['false', 'false', 'false']);
  });
});
