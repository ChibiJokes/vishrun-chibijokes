import LODASH_SOURCE from '../vendor/lodash-4.18.1.min.js' with { type: 'text' };

// Lodash 4.18.1 inlined into the iframe srcdoc head for tavern-mvu widgets.
// Full build (cards may use more than `_.get`).

export function lodashShim(): string {
  return '<script>' + LODASH_SOURCE + '</script>';
}
