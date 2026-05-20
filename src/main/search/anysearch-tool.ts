import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { configStore } from '../config/config-store';
import { searchAnySearchAsText, type AnySearchInput } from './anysearch-client';

export interface AnySearchToolOptions {
  getApiKey?: () => string | undefined;
}

export function buildAnySearchTool(options: AnySearchToolOptions = {}): ToolDefinition {
  return {
    name: 'websearch',
    label: 'Web Search',
    description:
      'Search the web with AnySearch for current information, fact-checking, documentation, news, and source discovery. Prefer this over raw HTTP for search tasks. Do not search for passwords, API keys, personal data, trade secrets, or other sensitive information. Results include real URLs that must be cited when used in final answers.',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query. Do not include sensitive information.',
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: 'Maximum results to return. Defaults to 5 and is capped at 10.',
        })
      ),
      freshness: Type.Optional(
        Type.String({
          description: 'Optional recency window: day, week, month, or year.',
        })
      ),
      domains: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional AnySearch domain filters such as tech, academic, code, finance, legal, health, or security.',
        })
      ),
      contentTypes: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional content type filters: web, news, academic, code, doc, data, image, video, or audio.',
        })
      ),
      zone: Type.Optional(
        Type.String({
          description: 'Optional region: cn or intl.',
        })
      ),
      language: Type.Optional(
        Type.String({
          description: 'Optional preferred language, such as zh-CN or en.',
        })
      ),
    }),
    execute: async (_toolCallId: string, params: AnySearchInput) => {
      const configuredApiKey = options.getApiKey?.() ?? configStore.get('anySearchApiKey') ?? '';
      const apiKey = configuredApiKey.trim() || undefined;
      const text = await searchAnySearchAsText(params, { apiKey });
      return {
        content: [{ type: 'text' as const, text }],
        details: undefined as unknown,
      };
    },
  };
}
