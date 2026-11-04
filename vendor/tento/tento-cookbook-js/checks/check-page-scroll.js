// Evaluate on a cookbook landing page. The taller landing simulates a mobile
// layout viewport exceeding its visible area; this is not Safari emulation.
(async () => {
  const landing = document.querySelector('.ck-landing');
  const header = document.querySelector('.ck-header');
  const controls = document.querySelector('.ck-deck-controls');
  const page = document.querySelector('.ck-deck-page:not([inert])');
  const html = document.documentElement;
  const savedHeight = landing.style.height, savedScroll = scrollY;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const top = () => landing.getBoundingClientRect().top;
  const results = [];
  const check = (name, pass) => {
    results.push({ name, pass });
    if (!pass) throw Error(JSON.stringify(results));
  };
  check('landing document allows native vertical movement',
    getComputedStyle(html).overflowY === 'visible' &&
    getComputedStyle(html).overscrollBehaviorY === 'auto');
  check('landing header participates in document scrolling',
    getComputedStyle(header).position === 'absolute');
  try {
    landing.style.height = `${innerHeight + 120}px`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    await frame();
    const before = [header.getBoundingClientRect().top, controls.getBoundingClientRect().bottom];
    const pageScroll = page.scrollTop;
    window.scrollTo({ top: 60, behavior: 'instant' });
    await frame();
    check('whole page moves including header and controls', scrollY === 60 &&
      Math.abs(header.getBoundingClientRect().top - before[0] + 60) < 1 &&
      Math.abs(controls.getBoundingClientRect().bottom - before[1] + 60) < 1);
    check('document scrolling does not change slide scroll', page.scrollTop === pageScroll);
    const from = top();
    document.querySelector('.ck-open-link').click();
    check('opening starts at the displayed scrolled position',
      matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(top() - from) < 2);
    await wait(750);
    check('app uses locked viewport coordinates', scrollY === 0 &&
      getComputedStyle(html).overflowY === 'hidden' &&
      getComputedStyle(header).position === 'fixed' &&
      header.getBoundingClientRect().top === 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(420);
    check('full app also keeps the document locked', html.dataset.ckStage === 'app' &&
      scrollY === 0 && getComputedStyle(html).overflowY === 'hidden');
    const opened = top();
    document.querySelector('.ck-brand').click();
    check('closing starts at the displayed app position',
      matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(top() - opened) < 2);
    await wait(750);
    check('returning restores the landing document offset', scrollY === 60 &&
      header.getBoundingClientRect().top === -60 && page.scrollTop === pageScroll);
    document.querySelector('.ck-open-link').click();
    await wait(120);
    const interrupted = top();
    document.querySelector('.ck-brand').click();
    check('interrupted opening reverses without a jump',
      matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(top() - interrupted) < 2);
    await wait(750);
    check('interrupted return restores scroll and stage', scrollY === 60 && html.dataset.ckStage === 'landing');
    check('decoration stays within document width', html.scrollWidth === innerWidth);
    return { viewport: [innerWidth, innerHeight], results };
  } finally {
    landing.style.height = savedHeight;
    window.scrollTo({ top: savedScroll, behavior: 'instant' });
  }
})();
