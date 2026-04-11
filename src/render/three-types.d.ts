/**
 * Ambient type declaration for the Three.js global. The game loads
 * three.min.js via a <script> tag in index.html, so THREE is a global
 * rather than an ES module import.
 *
 * We declare it as `any` here as a deliberate shortcut — the sim is
 * strictly typed, which is what we actually care about for tournament
 * determinism. The renderer's type safety can be tightened later by
 * either adding @types/three or by writing a minimal typed shape for
 * just the APIs we use. For Phase 1, loose typing is fine: the renderer
 * is thin, and runtime bugs here are visually obvious rather than
 * silently wrong.
 */
declare const THREE: any;
