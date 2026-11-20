import { describe, expect, it } from 'vitest';
import { normalizeTitle, titleSuggestions } from './titleSuggestions.js';

const entries = (...titles) => titles.map((title) => ({ title }));

const HISTORY = entries(
  'Jumbo El Llano',
  'Panadería La Espiga',
  'Jumbo Ñuñoa Santiago',
  'Repuesto (Ferrari) del coche',
  'jumbo el llano',
  'Almuerzo en Jumbo',
);

describe('normalizeTitle', () => {
  it('drops accents and case, and collapses spaces', () => {
    expect(normalizeTitle('  Jumbo   Ñuñoa ')).toBe('jumbo nunoa');
  });
});

describe('titleSuggestions', () => {
  it('offers both Jumbos for "Jum"', () => {
    expect(titleSuggestions(HISTORY, 'Jum')).toEqual([
      'Jumbo El Llano',
      'Jumbo Ñuñoa Santiago',
      'Almuerzo en Jumbo',
    ]);
  });

  it('keeps matching as more words are typed', () => {
    expect(titleSuggestions(HISTORY, 'jumbo e')).toEqual(['Jumbo El Llano']);
  });

  it('ignores accents on either side', () => {
    expect(titleSuggestions(HISTORY, 'nunoa')).toEqual(['Jumbo Ñuñoa Santiago']);
    expect(titleSuggestions(HISTORY, 'Ñuñ')).toEqual(['Jumbo Ñuñoa Santiago']);
    expect(titleSuggestions(HISTORY, 'panaderia')).toEqual(['Panadería La Espiga']);
  });

  it('finds a word that follows punctuation', () => {
    expect(titleSuggestions(HISTORY, 'ferr')).toEqual(['Repuesto (Ferrari) del coche']);
  });

  it('does not match inside a word', () => {
    expect(titleSuggestions(HISTORY, 'umb')).toEqual([]);
  });

  it('lists a title typed several ways once, in its newest spelling', () => {
    const titles = titleSuggestions(entries('Jumbo el llano', 'JUMBO EL LLANO'), 'jum');
    expect(titles).toEqual(['Jumbo el llano']);
  });

  it('leaves out a title the text already equals', () => {
    expect(titleSuggestions(HISTORY, 'jumbo el llano')).toEqual([]);
    expect(titleSuggestions(entries('Jumbo', 'Jumbo El Llano'), 'Jumbo')).toEqual([
      'Jumbo El Llano',
    ]);
  });

  it('offers nothing for empty or blank text', () => {
    expect(titleSuggestions(HISTORY, '')).toEqual([]);
    expect(titleSuggestions(HISTORY, '   ')).toEqual([]);
  });

  it('puts titles that start with the text before the newer ones that only contain it', () => {
    const titles = titleSuggestions(entries('Pan de jamón', 'Jamón serrano'), 'jam');
    expect(titles).toEqual(['Jamón serrano', 'Pan de jamón']);
  });

  it('stops at the limit', () => {
    const many = entries('Té 1', 'Té 2', 'Té 3', 'Té 4', 'Té 5', 'Té 6');
    expect(titleSuggestions(many, 'te')).toHaveLength(5);
    expect(titleSuggestions(many, 'te', { max: 2 })).toEqual(['Té 1', 'Té 2']);
  });
});
