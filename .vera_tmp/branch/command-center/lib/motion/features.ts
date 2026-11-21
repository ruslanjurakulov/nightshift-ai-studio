/**
 * Motion's feature bundles, each in its own module so the provider can
 * `import()` them after hydration: the first-load JavaScript carries only
 * `LazyMotion` and the `m` render shell, and the animation engine arrives as a
 * separate chunk a moment later (docs: motion.dev/docs/react-reduce-bundle-size).
 *
 * domAnimation: animations, variants, exit, tap/hover/focus, in-view.
 * domMax (features-max.ts): adds layout animation and shared `layoutId`, and
 * is loaded only by <SharedLayout> on the surfaces that use it.
 */
import { domAnimation } from "motion/react";

export default domAnimation;
