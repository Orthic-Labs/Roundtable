/** Citadel wordmark: a keep/shield mark in the accent + the name in Tanker.
 *  Single-color name (no per-syllable split); the accent lives in the mark. */
export function Wordmark() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 20V10l7-5 7 5v10z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 20v-7" stroke="currentColor" strokeWidth="1.7" />
      </svg>
      Citadel
    </span>
  );
}
