import './toggle.css'

// A real switch for a boolean setting: role=switch, a sliding knob, and
// no On/Off word. Amber when on - a preference being on is interaction,
// while green stays reserved for running/ok.
export default function Toggle({ checked, onChange, label, disabled = false, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={checked ? 'tg-switch on' : 'tg-switch'}
      onClick={onChange}
    >
      <span className="tg-knob" />
    </button>
  )
}
