/**
 * The emojis a member can choose as their avatar. This is data, not copy: it mirrors `AVATARS` in
 * `backend/functions/family-ledger/src/service/profile.rs`, which refuses anything else, and a
 * backend test keeps the two lists equal. Each is a single code point.
 */
export const AVATARS = [
  '🐵', '🐒', '🦍', '🦧', '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐔',
  '🐧', '🦉', '🦄', '🐝', '🦋', '🐢', '🐙', '🐳', '🐬', '🦒', '🦘', '🦥', '🦦', '🌵', '🌻', '🍄',
  '🍉', '🍓', '🍕', '🌮', '🍩', '☕', '⚽', '🎸', '🎨', '🚀', '🌈', '⭐', '😀', '😎', '🤓', '🥳',
];

/** Where the first sign-in step starts, and what the server stores when none is sent. */
export const DEFAULT_AVATAR = '🐵';
