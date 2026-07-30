/**
 * Table-driven tests for the routing table in `src/capabilities.ts`.
 *
 * The `getCapabilities` function decides per model name which OKMD
 * endpoint to call and whether the model is tool-capable. Per
 * spec 0001 §Testing Decisions: assert the externally observable
 * contract — the `{ endpoint, toolCalling }` object — never the
 * internals of the lookup table.
 *
 * **Every OKMD model is reported as `toolCalling: true`.** VS Code
 * 1.120+ filters BYOK models that are not `toolCalling` out of the
 * model picker (microsoft/vscode#296786). The OKMD gateway
 * forwards tool calls to the underlying model for every name we
 * expose, so reporting `true` here is what makes the picker show
 * all 23 models in Agent mode. If a future model on the OKMD
 * gateway does not support tools, the dispatch path will log a
 * warning and skip the tool call (see `dispatch` in
 * `provider.ts`).
 */

jest.mock('vscode');

import { getCapabilities } from '../src/capabilities';

type Case = {
  name: string;
  input: string;
  expectEndpoint: 'openai' | 'anthropic';
};

const cases: Case[] = [
  {
    name: 'claude-sonnet-4 is routed to anthropic',
    input: 'claude-sonnet-4',
    expectEndpoint: 'anthropic',
  },
  {
    name: 'claude-opus-4 is routed to anthropic',
    input: 'claude-opus-4',
    expectEndpoint: 'anthropic',
  },
  {
    name: 'gpt-5 is routed to openai',
    input: 'gpt-5',
    expectEndpoint: 'openai',
  },
  {
    name: 'gemini-2.5-pro is routed to openai',
    input: 'gemini-2.5-pro',
    expectEndpoint: 'openai',
  },
  {
    name: 'gemini-3.5-flash is routed to openai',
    input: 'gemini-3.5-flash',
    expectEndpoint: 'openai',
  },
  {
    name: 'name without "claude-" prefix is routed to openai',
    input: 'some-future-model-9000',
    expectEndpoint: 'openai',
  },
  {
    name: 'empty input is routed to openai',
    input: '',
    expectEndpoint: 'openai',
  },
];

describe('getCapabilities — routing table', () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(getCapabilities(c.input)).toEqual({
        endpoint: c.expectEndpoint,
        toolCalling: true,
      });
    });
  }
});

describe('getCapabilities — all models are tool-capable (regression guard for microsoft/vscode#296786)', () => {
  test('every input is reported as toolCalling: true', () => {
    // The OKMD gateway forwards tool calls for every model. VS Code
    // 1.120+ filters BYOK models that report toolCalling=false out
    // of the model picker in Agent mode; this test pins the
    // "always true" contract so a future refactor that brings
    // back the whitelist cannot silently break the picker.
    for (const name of [
      'claude-sonnet-4',
      'claude-opus-4',
      'gpt-5',
      'gemini-2.5-pro',
      'gemini-3.5-flash',
      'some-future-model-9000',
      '',
    ]) {
      expect(getCapabilities(name).toolCalling).toBe(true);
    }
  });
});
