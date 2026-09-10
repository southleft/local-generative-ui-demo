import { describe, expect, it } from 'vitest';
import { componentNameSet } from './catalog';
import { DEFAULT_PATTERN_LIBRARY, buildCompositionPrompt, selectPatternKeys, selectPatternRecipes, type PatternLibrary } from './prompt';
import { parseComposition } from './salvage';

const PATTERN_RECIPES = Object.fromEntries(
  Object.entries(DEFAULT_PATTERN_LIBRARY.patterns).map(([key, definition]) => [key, definition.blueprint]),
) as Record<keyof typeof DEFAULT_PATTERN_LIBRARY.patterns, string>;

describe('pattern recipes', () => {
  it('selects the intended blueprint for each day-to-day request shape', () => {
    expect(selectPatternRecipes('A patient intake form for a family clinic: full name, date of birth, and known allergies.')).toContain(PATTERN_RECIPES.form);
    expect(selectPatternRecipes('A customer support chat about a delayed order with a reply box and send button.')).toContain(PATTERN_RECIPES.chat);
    expect(selectPatternRecipes('A status dashboard for a website redesign project: overall progress and open tasks.')).toContain(PATTERN_RECIPES.dashboard);
    expect(selectPatternRecipes('An account settings page: profile details and notification preferences.')).toContain(PATTERN_RECIPES.settings);
    expect(selectPatternRecipes('A checkout review screen: ordered items, shipping details fields, and a place-order action.')).toContain(PATTERN_RECIPES.form);
    expect(selectPatternRecipes('Compare three pricing plans and recommend one.')).toContain(PATTERN_RECIPES.compare);
  });

  it('does not force the compare blueprint onto a board that merely contains a decision', () => {
    // Flagged raccoon-heist run: 'go / no-go decision' triggered the Compare
    // blueprint and confused the whole composition.
    const recipes = selectPatternRecipes('A heist planning board for a crew of raccoons robbing a bird feeder. Show crew readiness, a gear checklist, risk level, and a big go / no-go decision.');
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).not.toContain('Compare:');
  });

  it('ends the prompt with a flat-transport reminder after the blueprints', () => {
    const prompt = buildCompositionPrompt('A patient intake form.');
    expect(prompt.indexOf('Transport reminder')).toBeGreaterThan(prompt.indexOf(PATTERN_RECIPES.form));
    expect(prompt).toContain('never nest component objects');
  });

  it('coerces h1/h2/h3 used as component names into Headings', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['t', 'x'] },
        { id: 't', component: 'h1', props: { text: 'Board title', level: 'h1' } },
        { id: 'x', component: 'Text', props: { text: 'anchor' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 't')).toMatchObject({ component: 'Heading', props: { text: 'Board title', level: 'h1' } });
  });

  it('falls back to one generic scaffold line instead of the full recipe list', () => {
    const recipes = selectPatternRecipes('A love letter to the sea, beautifully arranged.');
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).not.toContain('Form:');
    expect(recipes[0]).toContain('Page');
  });

  it('injects at most two blueprints for multi-intent requests', () => {
    const recipes = selectPatternRecipes('A settings page with a built-in support chat and a metrics dashboard and a signup form.');
    expect(recipes.length).toBeLessThanOrEqual(2);
  });

  it('places the blueprint after the rules and inside the prompt for both providers', () => {
    for (const schemaEnforced of [false, true]) {
      const prompt = buildCompositionPrompt('A patient intake form.', { schemaEnforced });
      expect(prompt).toContain('copy the STRUCTURE, never the words');
      expect(prompt.indexOf(PATTERN_RECIPES.form)).toBeGreaterThan(prompt.indexOf('Rules:'));
    }
  });

  it('keeps every capitalized recipe token inside the catalog vocabulary', () => {
    const labels = new Set(['Form', 'Chat', 'Dashboard', 'Settings', 'Compare']);
    for (const recipe of Object.values(PATTERN_RECIPES)) {
      for (const token of recipe.match(/[A-Z][A-Za-z]+/g) ?? []) {
        if (labels.has(token)) continue;
        expect(componentNameSet.has(token), `"${token}" leaks a non-catalog name into the recipe`).toBe(true);
      }
    }
  });

  it('honors a user-edited pattern library for matching and blueprint text', () => {
    const custom: PatternLibrary = {
      ...DEFAULT_PATTERN_LIBRARY,
      patterns: {
        ...DEFAULT_PATTERN_LIBRARY.patterns,
        form: { keywords: ['kombucha'], blueprint: 'Form: Page [Heading, one Card [2 TextField], Inline [Button tone=primary]]' },
      },
    };

    expect(selectPatternKeys('A kombucha brewing log.', custom)).toEqual(['form']);
    expect(selectPatternRecipes('A kombucha brewing log.', custom)).toEqual([custom.patterns.form.blueprint]);
    // The default form keywords no longer trigger under the custom library.
    expect(selectPatternKeys('A patient intake form.', custom)).toEqual([]);
    const prompt = buildCompositionPrompt('A kombucha brewing log.', { patternLibrary: custom });
    expect(prompt).toContain(custom.patterns.form.blueprint);
  });
});
