import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { titleSuggestions } from '../../lib/titleSuggestions.js';
import { AutocompleteField } from './AutocompleteField.jsx';

const LABEL = 'Title';
const HISTORY = [{ title: 'Jumbo Ñuñoa Santiago' }, { title: 'Jumbo El Llano' }];

// The field as a form uses it: the value lives in the form, and suggestions follow what is typed.
function Form({ onSubmit, onPick = () => {}, history = HISTORY }) {
  const [title, setTitle] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(title);
      }}
    >
      <AutocompleteField
        label={LABEL}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        suggestions={titleSuggestions(history, title)}
        onPick={(value) => {
          onPick(value);
          setTitle(value);
        }}
      />
    </form>
  );
}

const field = () => screen.getByRole('combobox', { name: LABEL });
const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent);

describe('AutocompleteField', () => {
  it('offers both earlier titles for "Jum"', async () => {
    render(<Form onSubmit={vi.fn()} />);
    await userEvent.type(field(), 'Jum');
    expect(screen.getByRole('listbox', { name: LABEL })).toBeTruthy();
    expect(optionNames()).toEqual(['Jumbo Ñuñoa Santiago', 'Jumbo El Llano']);
    expect(field().getAttribute('aria-expanded')).toBe('true');
  });

  it('picks the highlighted option with Enter without submitting the form', async () => {
    const onSubmit = vi.fn();
    const onPick = vi.fn();
    render(<Form onSubmit={onSubmit} onPick={onPick} />);
    await userEvent.type(field(), 'Jum');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(field().getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Jumbo El Llano' }).id,
    );
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('Jumbo El Llano');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe('Jumbo El Llano');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('submits on Enter when no option is highlighted', async () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    await userEvent.type(field(), 'Jum{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Jum');
  });

  it('closes on Escape and opens again when typing', async () => {
    render(<Form onSubmit={vi.fn()} />);
    await userEvent.type(field(), 'Jum');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.type(field(), 'b');
    expect(optionNames()).toEqual(['Jumbo Ñuñoa Santiago', 'Jumbo El Llano']);
  });

  it('picks an option with a click and keeps the focus in the field', async () => {
    const onPick = vi.fn();
    render(<Form onSubmit={vi.fn()} onPick={onPick} />);
    await userEvent.type(field(), 'nunoa');
    await userEvent.click(screen.getByRole('option', { name: 'Jumbo Ñuñoa Santiago' }));
    expect(onPick).toHaveBeenCalledWith('Jumbo Ñuñoa Santiago');
    expect(field().value).toBe('Jumbo Ñuñoa Santiago');
    expect(document.activeElement).toBe(field());
  });

  it('closes when the field loses focus', async () => {
    render(<Form onSubmit={vi.fn()} />);
    await userEvent.type(field(), 'Jum');
    await userEvent.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('stays a plain text field when there is no history', async () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} history={[]} />);
    await userEvent.type(field(), 'Jum');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field().getAttribute('aria-expanded')).toBe('false');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Jum');
  });
});
