import PropTypes from 'prop-types';

/**
 * Terminal-styled checkbox component with [x] / [ ] style.
 *
 * Uses a hidden native <input type="checkbox"> under the hood for
 * accessibility (keyboard, screen readers, form integration), while
 * rendering the visual state with monospace box-drawing characters.
 */
const TerminalCheckbox = ({
  checked = false,
  onChange,
  label,
  disabled = false,
  name,
  id,
  className = '',
}) => {
  const handleChange = (event) => {
    if (disabled) return;
    if (onChange) onChange(event);
  };

  return (
    <label
      className={`
        inline-flex items-center gap-3 font-mono text-sm group
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        ${className}
      `}
    >
      <input
        type="checkbox"
        name={name}
        id={id}
        checked={checked}
        onChange={handleChange}
        disabled={disabled}
        className="sr-only peer"
      />
      <span
        aria-hidden="true"
        className={`
          select-none
          ${checked ? 'text-terminal-green' : 'text-terminal-muted'}
          peer-focus-visible:outline peer-focus-visible:outline-1
          peer-focus-visible:outline-terminal-green
          ${disabled ? '' : 'group-hover:text-terminal-green'}
          transition-colors
        `}
      >
        {checked ? '[x]' : '[ ]'}
      </span>
      {label && (
        <span
          className={`
            ${checked ? 'text-terminal-primary' : 'text-terminal-primary'}
            ${disabled ? '' : 'group-hover:text-terminal-green'}
            transition-colors
          `}
        >
          {label}
        </span>
      )}
    </label>
  );
};

TerminalCheckbox.propTypes = {
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  label: PropTypes.node,
  disabled: PropTypes.bool,
  name: PropTypes.string,
  id: PropTypes.string,
  className: PropTypes.string,
};

export default TerminalCheckbox;
export { TerminalCheckbox };
