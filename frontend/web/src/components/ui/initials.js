/**
 * A person's initials: the first letter of their first name, plus the first letter of their last
 * name unless `single`. "?" when there is no name.
 */
export function initials(name, single = false) {
  const parts = String(name ?? '').trim().split(/\s+/);
  const first = Array.from(parts[0])[0] ?? '?';
  const last = !single && parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
  return `${first}${last}`.toUpperCase();
}
