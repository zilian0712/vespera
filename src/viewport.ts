import { useEffect, useState } from 'react';

export function useViewport() {
  const measure = () => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    top: window.visualViewport?.offsetTop ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
    landscape: window.screen.orientation
      ? window.screen.orientation.type.startsWith('landscape')
      : window.matchMedia('(orientation: landscape)').matches,
    touch: window.matchMedia('(pointer: coarse)').matches,
  });
  const [viewport, setViewport] = useState(measure);
  useEffect(() => {
    const update = () => setViewport(measure());
    window.addEventListener('resize', update);
    window.screen.orientation?.addEventListener('change', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.screen.orientation?.removeEventListener('change', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);
  return viewport;
}
