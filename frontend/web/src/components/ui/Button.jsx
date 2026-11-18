import './Button.css';

export function Button({
  variant = 'primary',
  size = 'medium',
  block = false,
  iconOnly = false,
  icon: Icon,
  children,
  ...props
}) {
  const classes = [
    'fa-button',
    `fa-button--${variant}`,
    `fa-button--${size}`,
    block && 'fa-button--block',
    iconOnly && 'fa-button--icon-only',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} {...props}>
      {Icon && <Icon aria-hidden="true" size={20} strokeWidth={1.75} />}
      {children}
    </button>
  );
}
