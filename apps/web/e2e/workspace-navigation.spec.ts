import type { Locator } from '@playwright/test';
import { expect, test } from '@playwright/test';

async function menuGeometry(items: Locator) {
  return items.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        padding: style.padding,
        radius: style.borderRadius,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        iconSize: icon.width,
        iconInset: icon.left - rect.left,
      };
    }),
  );
}

for (const locale of ['en', 'ko']) {
  for (const theme of ['light', 'dark']) {
    test(`${locale} ${theme}: every destination shares menu geometry and selected appearance`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      const selectedStyles = [];
      for (const path of [
        'decisions',
        'reviews?fixture=default',
        'development',
        'settings/connections',
        'reviews/241?fixture=completed-multiple-findings',
      ]) {
        await page.goto(`/${locale}/${path}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(theme));
        if (testInfo.project.name === 'mobile') {
          await page.locator('[data-sidebar="trigger"]').click();
        }
        const items = page.locator('[data-sidebar="menu-button"]:visible');
        await expect(items).toHaveCount(4);
        // Both the accessible location and visual state must identify the same single link.
        const current = page.locator('[data-sidebar="menu-button"][aria-current="page"]:visible');
        await expect(current).toHaveCount(1);
        const expectedPath = path.startsWith('settings/')
          ? `/${locale}/settings/connections`
          : `/${locale}/${path.split(/[/?]/)[0]}`;
        expect(new URL((await current.getAttribute('href'))!, page.url()).pathname).toBe(
          expectedPath,
        );
        await expect(current).toHaveAttribute('data-active', '');
        await expect(page.locator('[data-sidebar="menu-button"][data-active]:visible')).toHaveCount(
          1,
        );
        await page.mouse.move(0, 0);
        const geometry = await menuGeometry(items);
        expect(geometry[0]).toMatchObject({ height: 40, fontSize: '14px', fontWeight: '500' });
        for (const item of geometry.slice(1)) {
          expect(item).toEqual(geometry[0]);
        }
        selectedStyles.push(
          await current.evaluate((element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color };
          }),
        );
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow).toBe(false);
      }
      for (const style of selectedStyles.slice(1)) {
        expect(style).toEqual(selectedStyles[0]);
      }

      if (testInfo.project.name !== 'mobile') {
        await page.locator('[data-sidebar="trigger"]').click();
        await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
          'data-state',
          'collapsed',
        );
        const items = page.locator('[data-sidebar="menu-button"]:visible');
        await expect
          .poll(async () =>
            (await menuGeometry(items)).map(({ width, height }) => ({ width, height })),
          )
          .toEqual(Array.from({ length: 4 }, () => ({ width: 40, height: 40 })));
        await expect
          .poll(async () => (await menuGeometry(items)).map((item) => item.iconInset))
          .toEqual([12, 12, 12, 12]);
        const geometry = await menuGeometry(items);
        for (const item of geometry) {
          expect(item).toEqual(geometry[0]);
          expect(item.iconInset).toBe((item.width - item.iconSize) / 2);
        }
      }
    });
  }
}
