/**
 * Table-driven tests for the routing table in `src/capabilities.ts`.
 *
 * The `getCapabilities` function decides per model name which OKMD
 * endpoint to call and whether the model is tool-capable. Per
 * spec 0001 §Testing Decisions: assert the externally observable
 * contract — the `{ endpoint, toolCalling }` object — never the
 * internals of the lookup table.
 *
 * The whitelist itself (`TOOL_CAPABLE_MODELS` in `constants.ts`) is
 * asserted separately, because the whitelist is a hardcoded
 * artifact that the routing table reads from; if the two drift
 * (e.g. someone adds a name to the whitelist but forgets the
 * `claude-` prefix convention), the table test alone would not
 * catch it.
 */

jest.mock('vscode');

import { getCapabilities } from '../src/capabilities';
import { TOOL_CAPABLE_MODELS } from '../src/constants';

type Case = {
  name: string;
  input: string;
  expectEndpoint: 'openai' | 'anthropic';
  expectToolCalling: boolean;
};

const cases: Case[] = [
  {
    name: 'claude-sonnet-4 is routed to anthropic and is tool-capable',
    input: 'claude-sonnet-4',
    expectEndpoint: 'anthropic',
    expectToolCalling: true,
  },
  {
    name: 'claude-opus-4 is routed to anthropic and is tool-capable',
    input: 'claude-opus-4',
    expectEndpoint: 'anthropic',
    expectToolCalling: true,
  },
  {
    name: 'gpt-5 is routed to openai and is tool-capable',
    input: 'gpt-5',
    expectEndpoint: 'openai',
    expectToolCalling: true,
  },
  {
    name: 'gemini-2.5-pro is routed to openai and is tool-capable',
    input: 'gemini-2.5-pro',
    expectEndpoint: 'openai',
    expectToolCalling: true,
  },
  {
    name: 'gemini-3.5-flash is not in the whitelist — openai + non-tool-capable',
    input: 'gemini-3.5-flash',
    expectEndpoint: 'openai',
    expectToolCalling: false,
  },
  {
    name: 'unknown name falls through to openai and is not tool-capable',
    input: 'some-future-model-9000',
    expectEndpoint: 'openai',
    expectToolCalling: false,
  },
  {
    name: 'empty name falls through to openai and is not tool-capable',
    input: '',
    expectEndpoint: 'openai',
    expectToolCalling: false,
  },
];

describe('getCapabilities — routing table', () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(getCapabilities(c.input)).toEqual({
        endpoint: c.expectEndpoint,
        toolCalling: c.expectToolCalling,
      });
    });
  }
});

describe('TOOL_CAPABLE_MODELS whitelist', () => {
  test('contains exactly the four whitelisted names and no others', () => {
    // The whitelist is hardcoded in `constants.ts`; this test pins
    // the exact set so that future changes to the whitelist show up
    // as a deliberate diff in this test, not as silent drift.
    expect(new Set(TOOL_CAPABLE_MODELS)).toEqual(
      new Set(['claude-sonnet-4', 'claude-opus-4', 'gpt-5', 'gemini-2.5-pro']),
    );
  });

  test('every whitelisted name is tool-capable in the routing table', () => {
    // Cross-check: the whitelist and the routing table must agree.
    // If the prefix rule for `claude-` ever changes, the routing
    // table and the whitelist would disagree on which Claude
    // variants are tool-capable; this test catches that.
    for (const name of TOOL_CAPABLE_MODELS) {
      expect(getCapabilities(name).toolCalling).toBe(true);
    }
  });
});
