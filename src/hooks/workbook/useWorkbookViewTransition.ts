import { useLayoutEffect, useRef } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function useWorkbookViewTransition(presentationKey: string) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY);
    const stopAnimation = () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };
    const handleMotionPreferenceChange = () => {
      if (motionPreference.matches) stopAnimation();
    };
    motionPreference.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      motionPreference.removeEventListener('change', handleMotionPreferenceChange);
      stopAnimation();
    };
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const previousAnimation = animationRef.current;
    const initialOpacity = previousAnimation?.playState === 'running'
      ? Number(window.getComputedStyle(surface).opacity)
      : 0.96;
    previousAnimation?.cancel();
    animationRef.current = null;
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return;

    // Keep the painted table visible and interactive throughout each presentation change.
    const animation = surface.animate(
      [{ opacity: initialOpacity }, { opacity: 1 }],
      { duration: 140, easing: 'ease-out' },
    );
    animation.id = 'workbook-view-transition';
    animationRef.current = animation;
    animation.onfinish = () => {
      if (animationRef.current === animation) animationRef.current = null;
      animation.cancel();
    };
  }, [presentationKey]);

  return surfaceRef;
}
